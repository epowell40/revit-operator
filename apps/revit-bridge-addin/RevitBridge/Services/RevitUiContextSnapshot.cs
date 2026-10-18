using System;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Services
{
    internal static class RevitUiContextSnapshot
    {
        private static readonly OperatorUiContextSnapshotStore Store = new OperatorUiContextSnapshotStore();
        // Accessed only by Revit UI callbacks. Background readers see serialized values only.
        private static UIApplication? _uiApplication;

        [StructLayout(LayoutKind.Sequential)]
        private struct WindowRect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr window, out WindowRect rectangle);

        private static object? CaptureFrame(UIApplication application, UIDocument? uidoc)
        {
            // UI callback only. HTTP readers receive immutable coordinates, never
            // a UIView or a new ExternalEvent (including while a modal is open).
            try
            {
                var window = application.MainWindowHandle;
                if (window == IntPtr.Zero || !GetWindowRect(window, out var main)) return null;
                object? viewRectangle = null;
                try
                {
                    var uiView = uidoc?.GetOpenUIViews().FirstOrDefault(v => v.ViewId == uidoc.ActiveView.Id);
                    var rectangle = uiView?.GetWindowRectangle();
                    if (rectangle != null) viewRectangle = new { x = rectangle.Left, y = rectangle.Top, width = rectangle.Right - rectangle.Left, height = rectangle.Bottom - rectangle.Top };
                }
                catch { /* Some editors have no UIView; owned modal capture can still work. */ }
                return new
                {
                    main_window_handle = "0x" + window.ToInt64().ToString("X"),
                    main_window_bounds = new { x = main.Left, y = main.Top, width = main.Right - main.Left, height = main.Bottom - main.Top },
                    view_rectangle = viewRectangle
                };
            }
            catch { return null; }
        }

        public static void Capture(UIApplication application)
        {
            _uiApplication = application;
            try
            {
                var uidoc = application.ActiveUIDocument;
                var doc = uidoc?.Document;
                var view = doc?.ActiveView;
                var sessionId = doc == null ? null : OperatorNativeDocumentSessionAuthority.GetSessionId(doc);
                var value = new
                {
                    version = application.Application.VersionName,
                    process_id = Process.GetCurrentProcess().Id,
                    visual_capture_context = CaptureFrame(application, uidoc),
                    nativeChangeObservations = sessionId == null ? (object?)null : RevitDocumentChangeObservations.Read(sessionId),
                    document = doc == null ? null : new
                    {
                        title = doc.Title,
                        sessionId,
                        activeView = view == null ? null : new
                        {
                            id = ElementIdCompat.GetValue(view.Id),
                            name = view.Name,
                            type = view.ViewType.ToString()
                        },
                        selection = new { count = uidoc?.Selection.GetElementIds().Count ?? 0 }
                    }
                };
                Store.Publish(JsonSerializer.Serialize(value), DateTimeOffset.UtcNow);
            }
            catch { Store.Invalidate("ui_context_unavailable"); }
        }

        public static void RefreshFromUiEvent()
        {
            if (_uiApplication != null) Capture(_uiApplication);
            else Store.Invalidate("awaiting_ui_context");
        }

        public static void Invalidate(string reason) => Store.Invalidate(reason);

        public static JsonElement Read()
        {
            // No Autodesk API access or model references cross onto the HTTP thread.
            using var document = JsonDocument.Parse(Store.ReadJson());
            return document.RootElement.Clone();
        }

        public static void Shutdown()
        {
            _uiApplication = null;
            Store.Invalidate("revit_shutdown");
        }
    }
}

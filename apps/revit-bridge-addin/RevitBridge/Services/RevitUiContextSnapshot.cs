using System;
using System.Diagnostics;
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

        public static void Capture(UIApplication application)
        {
            _uiApplication = application;
            try
            {
                var uidoc = application.ActiveUIDocument;
                var doc = uidoc?.Document;
                var view = doc?.ActiveView;
                var value = new
                {
                    version = application.Application.VersionName,
                    process_id = Process.GetCurrentProcess().Id,
                    document = doc == null ? null : new
                    {
                        title = doc.Title,
                        activeView = view == null ? null : new
                        {
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

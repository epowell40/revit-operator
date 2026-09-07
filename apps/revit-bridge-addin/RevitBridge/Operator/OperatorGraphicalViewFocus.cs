using System;
using System.Linq;
using System.Runtime.InteropServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Operator
{
    /// <summary>Restore this Revit UI thread's drawing focus before posting project close.</summary>
    internal static class OperatorGraphicalViewFocus
    {
        internal static void Restore(UIApplication app, UIDocument document, View graphicalView)
        {
            var uiView = document.GetOpenUIViews().SingleOrDefault(view => view.ViewId == graphicalView.Id)
                ?? throw new InvalidOperationException("The graphical view has no open drawing window.");
            var rectangle = uiView.GetWindowRectangle();
            if (rectangle.Right <= rectangle.Left || rectangle.Bottom <= rectangle.Top)
                throw new InvalidOperationException("The graphical view has no usable drawing area.");
            var screenPoint = new Point { X = rectangle.Left + (rectangle.Right - rectangle.Left) / 2,
                Y = rectangle.Top + (rectangle.Bottom - rectangle.Top) / 2 };
            var main = app.MainWindowHandle;
            var target = main;
            // Walk this application's children, not global WindowFromPoint:
            // another foreground application must never become the target.
            for (var depth = 0; depth < 32; depth++)
            {
                var local = screenPoint;
                if (!ScreenToClient(target, ref local))
                    throw new InvalidOperationException("Cannot resolve the drawing's window coordinates.");
                var child = ChildWindowFromPointEx(target, local, 0x1 | 0x2 | 0x4);
                if (child == IntPtr.Zero || child == target) break;
                target = child;
            }
            var threadId = GetWindowThreadProcessId(target, out var processId);
            if (target == main || !IsChild(main, target) || processId != GetCurrentProcessId() || threadId != GetCurrentThreadId())
                throw new InvalidOperationException("The drawing focus target does not belong to the active Revit UI thread.");
            SetFocus(target);
            var focused = GetFocus();
            if (focused != target && !IsChild(target, focused))
                throw new InvalidOperationException("Revit did not restore keyboard focus to the drawing; project close was not posted.");
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Point { public int X; public int Y; }
        [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref Point point);
        [DllImport("user32.dll")] private static extern IntPtr ChildWindowFromPointEx(IntPtr parent, Point point, uint flags);
        [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetFocus();
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    }
}

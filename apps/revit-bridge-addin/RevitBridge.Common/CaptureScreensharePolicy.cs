namespace RevitBridge.Common
{
    public static class CaptureScreensharePolicy
    {
        public static string SelectCaptureMode(bool isMinimized, bool windowCaptureSucceeded)
        {
            return !isMinimized && windowCaptureSucceeded
                ? "revit_window"
                : "active_view_export";
        }
    }
}

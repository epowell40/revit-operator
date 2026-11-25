using System.Globalization;

namespace RevitBridge.Common
{
    public static class OperatorBrowserCompatibility
    {
        // Revit through 2025 hosts CEF. Current Evergreen WebView2 can crash
        // that host on document/Home/Manage Links transitions even after the
        // add-in disposes its WebView. Keep the browser in Operator Desktop;
        // do not pin an obsolete browser runtime or change machine settings.
        // Autodesk: Program-crash-on-certain-machines-when-opening-the-Manage-Links-dialog-in-Revit.
        public static bool SupportsEmbeddedBrowser(string? revitVersion)
            => int.TryParse(revitVersion, NumberStyles.None, CultureInfo.InvariantCulture, out var year)
                && year >= 2026;

        public const string DesktopExplanation =
            "Operator opens in a separate window to avoid a browser conflict in this Revit version. All Operator tools remain available.";
    }
}

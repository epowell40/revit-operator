namespace RevitBridge.Common
{
    /// <summary>
    /// Resolves the public route-size aliases before any Revit API work begins.
    /// The route manifest has long advertised <c>diameter</c> for both duct and
    /// pipe requests, so round duct requests must not require callers to rename
    /// the same value to <c>ductSize</c>.
    /// </summary>
    public static class MepRouteSizeInputPolicy
    {
        public static string ResolveDuctSize(string? ductSize, string? diameter)
        {
            var explicitDuctSize = (ductSize ?? string.Empty).Trim();
            if (explicitDuctSize.Length > 0) return explicitDuctSize;
            return (diameter ?? string.Empty).Trim();
        }
    }
}

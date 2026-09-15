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

        public static string ResolveSingleDuctSize(string? ductSize, string? width, string? height, string? diameter)
        {
            var direct = (ductSize ?? string.Empty).Trim();
            var w = (width ?? string.Empty).Trim();
            var h = (height ?? string.Empty).Trim();
            var d = (diameter ?? string.Empty).Trim();
            if (direct.Length > 0) return direct;
            if ((w.Length > 0) != (h.Length > 0) || (w.Length > 0 && d.Length > 0))
                throw new System.ArgumentException("Provide both width and height, or diameter, without conflicting dimensions.");
            return w.Length > 0 ? $"{w}x{h}" : d;
        }
    }
}

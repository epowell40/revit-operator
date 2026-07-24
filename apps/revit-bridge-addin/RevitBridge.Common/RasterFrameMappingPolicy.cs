using System;

namespace RevitBridge.Common
{
    /// <summary>
    /// Keeps image-only capture available when a raster cannot safely support model-coordinate picking.
    /// </summary>
    public static class RasterFrameMappingPolicy
    {
        public static double GetRelativeAspectMismatch(double cropAspect, double rasterAspect)
        {
            return cropAspect > 1e-9
                ? Math.Abs(cropAspect - rasterAspect) / cropAspect
                : double.PositiveInfinity;
        }
    }
}

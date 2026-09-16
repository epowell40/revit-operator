using System;

namespace RevitBridge.Common
{
    /// <summary>Geometry of a fit-to-page 2D export, using its displayed outline.</summary>
    public sealed class ExportedRasterFrameGeometry
    {
        public double[] SourceTopLeft { get; private set; } = Array.Empty<double>();
        public double[] SourceTopRight { get; private set; } = Array.Empty<double>();
        public double[] SourceBottomLeft { get; private set; } = Array.Empty<double>();
        public double[] TopLeft { get; private set; } = Array.Empty<double>();
        public double[] TopRight { get; private set; } = Array.Empty<double>();
        public double[] BottomLeft { get; private set; } = Array.Empty<double>();
        public double SourceAspect { get; private set; }
        public double RasterAspect { get; private set; }
        public bool AspectCorrectionApplied { get; private set; }

        public static ExportedRasterFrameGeometry FromViewOutline(
            double[] origin, double[] right, double[] up,
            double minU, double minV, double maxU, double maxV,
            int viewScale, int widthPx, int heightPx)
        {
            ValidatePoint(origin); ValidatePoint(right); ValidatePoint(up);
            if (!Finite(minU) || !Finite(minV) || !Finite(maxU) || !Finite(maxV)
                || maxU <= minU || maxV <= minV || viewScale < 1 || widthPx < 2 || heightPx < 2)
                throw new ArgumentException("Exported view outline and raster dimensions must be finite and nondegenerate.");
            if (Math.Abs(Dot(right, right) - 1) > 1e-6 || Math.Abs(Dot(up, up) - 1) > 1e-6 || Math.Abs(Dot(right, up)) > 1e-6)
                throw new ArgumentException("Exported view directions must form an orthonormal 2D basis.");
            var width = (maxU - minU) * viewScale;
            var height = (maxV - minV) * viewScale;
            var rasterAspect = (widthPx - 1.0) / (heightPx - 1.0);
            var correctedWidth = height * rasterAspect;
            if (!Finite(width) || !Finite(height) || !Finite(correctedWidth) || width < 1e-9 || height < 1e-9)
                throw new ArgumentException("Exported view outline has invalid model extents.");
            double[] Point(double u, double v)
            {
                var point = new[] { origin[0] + right[0] * u + up[0] * v,
                    origin[1] + right[1] * u + up[1] * v, origin[2] + right[2] * u + up[2] * v };
                ValidatePoint(point);
                return point;
            }
            var offset = (correctedWidth - width) / 2;
            var correction = Math.Abs(correctedWidth - width) > 1e-9;
            return new ExportedRasterFrameGeometry
            {
                SourceTopLeft = Point(minU * viewScale, maxV * viewScale),
                SourceTopRight = Point(maxU * viewScale, maxV * viewScale),
                SourceBottomLeft = Point(minU * viewScale, minV * viewScale),
                TopLeft = Point(minU * viewScale - offset, maxV * viewScale),
                TopRight = Point(maxU * viewScale + offset, maxV * viewScale),
                BottomLeft = Point(minU * viewScale - offset, minV * viewScale),
                SourceAspect = width / height, RasterAspect = rasterAspect, AspectCorrectionApplied = correction
            };
        }

        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static double Dot(double[] a, double[] b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        private static void ValidatePoint(double[] point)
        {
            if (point == null || point.Length != 3 || !Finite(point[0]) || !Finite(point[1]) || !Finite(point[2]))
                throw new ArgumentException("Exported view coordinates must contain three finite values.");
        }
    }
}

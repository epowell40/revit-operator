using System;

namespace RevitBridge.Common
{
    /// <summary>Reject coordinates the drafting resolver would otherwise ignore.</summary>
    public static class DraftPointCoordinatePolicy
    {
        public static void Validate(double[]? xyz, int? xPx, int? yPx, double? xIn, double? yIn,
            double? x, double? y, double? z, string? frameId)
        {
            var hasPixels = xPx.HasValue || yPx.HasValue;
            var hasInches = xIn.HasValue || yIn.HasValue;
            var hasXY = x.HasValue || y.HasValue;
            var modes = (xyz != null ? 1 : 0) + (hasPixels ? 1 : 0) + (hasInches ? 1 : 0) + (hasXY ? 1 : 0);
            if (modes != 1) throw new InvalidOperationException("Provide exactly one point coordinate form: xyz, xPx/yPx, xIn/yIn, or x/y/z.");
            if (xyz != null)
            {
                if (xyz.Length < 2 || xyz.Length > 3 || z.HasValue)
                    throw new InvalidOperationException("Point xyz must contain two or three coordinates without a separate z value.");
                foreach (var value in xyz) RequireFinite(value);
                return;
            }
            if (hasPixels || hasInches || hasXY && !string.IsNullOrWhiteSpace(frameId))
            {
                if (z.HasValue) throw new InvalidOperationException("A view-plane point cannot include world z. Use xyz:[x,y,z] in model feet for explicit elevation.");
            }
            if (hasPixels && (!xPx.HasValue || !yPx.HasValue)
                || hasInches && (!xIn.HasValue || !yIn.HasValue)
                || hasXY && (!x.HasValue || !y.HasValue))
                throw new InvalidOperationException("Both coordinates of the selected point form are required.");
            foreach (var value in new[] { xIn, yIn, x, y, z }) if (value.HasValue) RequireFinite(value.Value);
        }

        private static void RequireFinite(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
                throw new InvalidOperationException("Point coordinates must be finite.");
        }
    }
}

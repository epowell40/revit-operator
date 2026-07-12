using System;

namespace RevitBridge.Common.Annotation
{
    public sealed class TagAnchorCalibration
    {
        private TagAnchorCalibration(double offsetX, double offsetY)
        {
            OffsetX = offsetX;
            OffsetY = offsetY;
        }

        public double OffsetX { get; }
        public double OffsetY { get; }

        public static TagAnchorCalibration FromMeasurement(double anchorX, double anchorY, TagRect2 actualBounds)
        {
            if (!IsFinite(anchorX) || !IsFinite(anchorY)) throw new ArgumentException("Tag anchor coordinates must be finite.");
            if (actualBounds == null) throw new ArgumentNullException(nameof(actualBounds));
            return new TagAnchorCalibration(actualBounds.CenterX - anchorX, actualBounds.CenterY - anchorY);
        }

        public double AnchorXForCenter(double desiredCenterX) => desiredCenterX - OffsetX;
        public double AnchorYForCenter(double desiredCenterY) => desiredCenterY - OffsetY;

        private static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }
}

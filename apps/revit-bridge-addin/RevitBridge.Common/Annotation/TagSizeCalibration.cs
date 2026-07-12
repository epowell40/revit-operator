using System;

namespace RevitBridge.Common.Annotation
{
    public sealed class TagSizeCalibration
    {
        public TagSizeCalibration(double initialWidth, double initialHeight)
        {
            Width = initialWidth;
            Height = initialHeight;
        }

        public double Width { get; private set; }
        public double Height { get; private set; }
        public bool IsCalibrated { get; private set; }

        public bool Observe(double width, double height)
        {
            if (!IsFinitePositive(width) || !IsFinitePositive(height)) return false;
            if (!IsCalibrated)
            {
                Width = width;
                Height = height;
                IsCalibrated = true;
                return true;
            }

            Width = Math.Max(Width, width);
            Height = Math.Max(Height, height);
            return true;
        }

        private static bool IsFinitePositive(double value) => value > 0 && !double.IsNaN(value) && !double.IsInfinity(value);
    }
}

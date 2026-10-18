using System;

namespace RevitBridge.Common
{
    /// <summary>Native text position and orientation, without assuming a horizontal view plane.</summary>
    public sealed class TextNoteOrientationReadback
    {
        public string kind => "TextNote";
        public string coordinateSpace => "model_feet";
        public double[] pointXyz { get; }
        public double[] baseDirectionXyz { get; }
        public double[] upDirectionXyz { get; }

        private TextNoteOrientationReadback(double[] point, double[] baseline, double[] up)
        {
            pointXyz = point;
            baseDirectionXyz = baseline;
            upDirectionXyz = up;
        }

        public static TextNoteOrientationReadback Create(double[] point, double[] baseline, double[] up)
        {
            var position = ReadVector(point, nameof(point));
            var baseVector = ReadVector(baseline, nameof(baseline));
            var upVector = ReadVector(up, nameof(up));
            var baseLength = Length(baseVector);
            var upLength = Length(upVector);
            if (double.IsInfinity(baseLength) || double.IsInfinity(upLength)
                || baseLength < 1e-12 || upLength < 1e-12)
                throw new InvalidOperationException("Native TextNote orientation has an invalid direction length.");
            var dot = (baseVector[0] / baseLength) * (upVector[0] / upLength)
                + (baseVector[1] / baseLength) * (upVector[1] / upLength)
                + (baseVector[2] / baseLength) * (upVector[2] / upLength);
            if (Math.Abs(dot) > 1e-6)
                throw new InvalidOperationException("Native TextNote baseline and up directions are not perpendicular.");
            // Retain observed vectors, rather than inferring a world-XY rotation for section/elevation text.
            return new TextNoteOrientationReadback(position, baseVector, upVector);
        }

        private static double[] ReadVector(double[] values, string name)
        {
            if (values == null || values.Length != 3)
                throw new InvalidOperationException($"Native TextNote {name} requires three coordinates.");
            foreach (var value in values)
                if (double.IsNaN(value) || double.IsInfinity(value))
                    throw new InvalidOperationException($"Native TextNote {name} is not finite.");
            return (double[])values.Clone();
        }

        private static double Length(double[] vector)
        {
            var scale = Math.Max(Math.Abs(vector[0]), Math.Max(Math.Abs(vector[1]), Math.Abs(vector[2])));
            if (scale == 0) return 0;
            return scale * Math.Sqrt(Math.Pow(vector[0] / scale, 2)
                + Math.Pow(vector[1] / scale, 2) + Math.Pow(vector[2] / scale, 2));
        }
    }
}

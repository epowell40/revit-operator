using System;

namespace RevitBridge.Common
{
    /// <summary>Correct a native family insertion to the requested model-space point.</summary>
    public static class AbsolutePlacementCorrection
    {
        public const double ToleranceFeet = 0.000001;

        public static double[] Delta(double[] requested, double[] observed)
        {
            Validate(requested);
            Validate(observed);
            return new[] { requested[0] - observed[0], requested[1] - observed[1], requested[2] - observed[2] };
        }

        public static bool Matches(double[] requested, double[] observed)
        {
            var delta = Delta(requested, observed);
            return Math.Abs(delta[0]) <= ToleranceFeet && Math.Abs(delta[1]) <= ToleranceFeet
                && Math.Abs(delta[2]) <= ToleranceFeet;
        }

        private static void Validate(double[] point)
        {
            if (point == null || point.Length != 3) throw new ArgumentException("A three-coordinate model-space point is required.");
            foreach (var value in point)
                if (double.IsNaN(value) || double.IsInfinity(value))
                    throw new ArgumentException("Model-space coordinates must be finite.");
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>Exact polynomial cubic data, independent of Revit's model mutation API.</summary>
    public static class DraftingCubicBezier
    {
        public static double[] ClampedKnots() => new[] { 0d, 0d, 0d, 0d, 1d, 1d, 1d, 1d };

        public static double[][] ValidateControlPoints(IEnumerable<double[]>? points)
        {
            var values = points?.Take(5).ToArray();
            if (values == null || values.Length != 4 || values.Any(p => p == null || p.Length != 3 || p.Any(n => !Finite(n))))
                throw new ArgumentException("cubic_bezier requires exactly four finite XYZ control points in source order.");
            return values.Select(p => p.ToArray()).ToArray();
        }

        public static void RequireNativeLength(double curveLength, double shortCurveTolerance)
        {
            if (!Finite(curveLength) || !Finite(shortCurveTolerance) || shortCurveTolerance <= 0 || curveLength <= shortCurveTolerance)
                throw new ArgumentException("Cubic curve must exceed the actual native ShortCurveTolerance; no source curve was silently dropped.");
        }

        /// <summary>Copy-stable representation of a complete native spline, including its bounded domain.
        /// Relative controls are quantized at 1e-9ft only for this comparison key. Raw native controls
        /// remain available separately; a key is not independent source or visual verification.</summary>
        public static string NativeNurbsGeometryKey(int degree, bool rational, bool cyclic,
            IEnumerable<double[]> relativeControlPoints, IEnumerable<double> knots, IEnumerable<double> weights,
            double startParameter, double endParameter)
        {
            var points = relativeControlPoints.Take(20001).ToArray();
            var k = knots.Take(20100).ToArray(); var w = weights.Take(20001).ToArray();
            if (degree < 1 || degree > 64 || points.Length <= degree || points.Length > 20000
                || points.Any(p => p == null || p.Length != 3 || p.Any(n => !Finite(n)))
                || k.Length != points.Length + degree + 1 || k.Any(n => !Finite(n))
                || k.Zip(k.Skip(1), (a, b) => b < a).Any(v => v)
                || w.Length != points.Length || w.Any(n => !Finite(n) || n <= 0)
                || !Finite(startParameter) || !Finite(endParameter) || startParameter >= endParameter)
                throw new ArgumentException("Complete native NURBS controls, degree, knots, weights and bounded parameter domain required.");
            string Number(double n) => (n == 0 ? 0d : n).ToString("R", CultureInfo.InvariantCulture);
            string Position(double[] p) => string.Join(",", p.Select(n => Number(Math.Round(n, 9))));
            return "nurbs:v1:relative-round9:" + degree + ":" + rational + ":" + cyclic
                + ":points:" + string.Join(";", points.Select(Position))
                + ":knots:" + string.Join(",", k.Select(Number))
                + ":weights:" + string.Join(",", w.Select(Number))
                + ":domain:" + Number(startParameter) + "," + Number(endParameter);
        }

        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }
}

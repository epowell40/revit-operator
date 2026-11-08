using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace RevitBridge.Common
{
    /// <summary>Bounded, read-only native curve descriptions. Keys compare the
    /// observed locus at 1e-9ft, not source intent or whole-task completion.</summary>
    public static class DraftingCurveReadback
    {
        public const int MaximumHermiteControls = 4096;

        public static string HermiteKey(bool periodic, bool cyclic,
            IEnumerable<double[]> controls, IEnumerable<double[]> tangents, IEnumerable<double> parameters,
            double startParameter, double endParameter)
        {
            var p = controls?.Take(MaximumHermiteControls + 1).ToArray();
            var t = tangents?.Take(MaximumHermiteControls + 1).ToArray();
            var u = parameters?.Take(MaximumHermiteControls + 1).ToArray();
            if (p == null || p.Length < 2 || p.Length > MaximumHermiteControls || p.Any(v => !Point(v))
                || t == null || t.Length != p.Length || t.Any(v => !Point(v))
                || u == null || u.Length != p.Length || u.Any(n => !Finite(n))
                || u.Zip(u.Skip(1), (a, b) => b <= a).Any(v => v)
                || !Finite(startParameter) || !Finite(endParameter) || startParameter >= endParameter)
                throw new ArgumentException("Complete finite native Hermite controls, tangents, ordered parameters and bounded domain required; oversized curves remain unsupported.");
            // Tangent magnitudes and parameter spacing affect the curve. Do not
            // normalize them, replace them with endpoints, or tessellate them.
            string Vector(double[] v) => string.Join(",", v.Select(n => Number(Math.Round(n, 9))));
            var source = string.Join("|", periodic, cyclic, string.Join(";", p.Select(Vector)),
                string.Join(";", t.Select(Vector)), string.Join(",", u.Select(Number)),
                Number(startParameter), Number(endParameter));
            using (var sha = SHA256.Create())
                return "hermite:v1:r9:sha256:" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(source)))
                    .Replace("-", "").ToLowerInvariant();
        }

        public static string CircleKey(double[] center, double radius, double[] normal)
        {
            if (!Point(center) || !Point(normal) || !Finite(radius) || radius <= 0)
                throw new ArgumentException("Complete finite circle center, positive radius and plane required.");
            var length = Math.Sqrt(normal.Sum(n => n * n));
            if (!Finite(length) || length <= 0)
                throw new ArgumentException("Circle plane normal must be nonzero and finite.");
            var n = normal.Select(v => v / length).ToArray();
            // A full circle has no endpoints; reversing its normal does not
            // change its locus. Preserve native axes in the raw observation.
            // Choose orientation after applying the stated comparison precision.
            // Otherwise a tiny negative near-zero component can flip the whole
            // normal and turn sub-tolerance native noise into a different key.
            var rounded = n.Select(v => Math.Round(v, 9)).ToArray();
            var sign = rounded.First(v => v != 0) < 0 ? -1d : 1d;
            return "circle:v1:relative-rounded9:" + string.Join(",", center.Select(v => Number(Math.Round(v, 9))))
                + ":" + Number(Math.Round(radius, 9)) + ":"
                + string.Join(",", rounded.Select(v => Number(v * sign)));
        }

        private static bool Point(double[]? p) => p != null && p.Length == 3 && p.All(Finite);
        private static bool Finite(double n) => !double.IsNaN(n) && !double.IsInfinity(n);
        private static string Number(double n) => (n == 0 ? 0d : n).ToString("R", CultureInfo.InvariantCulture);
    }
}

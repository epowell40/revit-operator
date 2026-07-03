using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    public static class MepRouteElementEditPlanner
    {
        public sealed class CurveInput
        {
            public long ElementId { get; set; }
            public double[] StartXyz { get; set; } = Array.Empty<double>();
            public double[] EndXyz { get; set; } = Array.Empty<double>();
        }

        public sealed class CurvePlan
        {
            public long ElementId { get; set; }
            public double DeltaZFt { get; set; }
            public double[] BeforeStartXyz { get; set; } = Array.Empty<double>();
            public double[] BeforeEndXyz { get; set; } = Array.Empty<double>();
            public double[] AfterStartXyz { get; set; } = Array.Empty<double>();
            public double[] AfterEndXyz { get; set; } = Array.Empty<double>();
        }

        public static IReadOnlyList<CurvePlan> PlanElevationMove(
            IEnumerable<CurveInput> curves,
            double? deltaZFt,
            double? targetCenterlineZFt,
            double slopeToleranceFt = 1e-6)
        {
            if (curves == null) throw new ArgumentNullException(nameof(curves));
            if (deltaZFt.HasValue && targetCenterlineZFt.HasValue)
            {
                throw new ArgumentException("Specify either deltaZFt or targetCenterlineZFt, not both.");
            }

            var result = new List<CurvePlan>();
            foreach (var curve in curves)
            {
                if (curve == null) throw new ArgumentException("Curve input cannot contain null items.");
                if (curve.StartXyz == null || curve.StartXyz.Length < 3 || curve.EndXyz == null || curve.EndXyz.Length < 3)
                {
                    throw new ArgumentException($"Element {curve.ElementId} requires 3D start/end coordinates.");
                }

                var startZ = curve.StartXyz[2];
                var endZ = curve.EndXyz[2];
                if (Math.Abs(startZ - endZ) > Math.Max(0.0, slopeToleranceFt))
                {
                    throw new InvalidOperationException($"Element {curve.ElementId} is sloped; elevation move currently supports level straight segments only.");
                }

                var dz = deltaZFt ?? (targetCenterlineZFt.GetValueOrDefault((startZ + endZ) * 0.5) - ((startZ + endZ) * 0.5));
                result.Add(new CurvePlan
                {
                    ElementId = curve.ElementId,
                    DeltaZFt = dz,
                    BeforeStartXyz = Copy3(curve.StartXyz),
                    BeforeEndXyz = Copy3(curve.EndXyz),
                    AfterStartXyz = new[] { curve.StartXyz[0], curve.StartXyz[1], curve.StartXyz[2] + dz },
                    AfterEndXyz = new[] { curve.EndXyz[0], curve.EndXyz[1], curve.EndXyz[2] + dz }
                });
            }

            return result;
        }

        private static double[] Copy3(double[] xyz)
        {
            return new[] { xyz[0], xyz[1], xyz[2] };
        }
    }
}

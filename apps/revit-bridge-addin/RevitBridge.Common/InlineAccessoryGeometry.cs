using System;

namespace RevitBridge.Common
{
    public sealed class InlineAccessoryGeometryPlan
    {
        public BranchPoint3d Axis { get; set; }
        public BranchPoint3d Center { get; set; }
        public BranchPoint3d FirstPort { get; set; }
        public BranchPoint3d SecondPort { get; set; }
        public double FirstRetainedLengthFt { get; set; }
        public double SecondRetainedLengthFt { get; set; }
        public double AccessoryLengthFt { get; set; }
    }

    /// <summary>Geometry only. A plan is neither a native connection nor saved/model proof.
    /// All lengths are feet. Port geometry must be measured AFTER instance sizing.</summary>
    public static class InlineAccessoryGeometry
    {
        public static InlineAccessoryGeometryPlan Plan(BranchPoint3d start, BranchPoint3d end,
            BranchPoint3d requestedCenter, double measuredPortSpacingFt, double hostDiameterFt,
            double firstPortDiameterFt, double secondPortDiameterFt, double shortCurveToleranceFt,
            double toleranceFt = 0.000001)
        {
            RequirePoint(start); RequirePoint(end); RequirePoint(requestedCenter);
            if (!Positive(toleranceFt) || toleranceFt > 0.001 || !Positive(shortCurveToleranceFt)
                || !Positive(measuredPortSpacingFt) || !Positive(hostDiameterFt)
                || !Positive(firstPortDiameterFt) || !Positive(secondPortDiameterFt))
                throw new ArgumentException("Finite positive lengths and bounded tolerance are required.");
            if (Math.Abs(firstPortDiameterFt - hostDiameterFt) > toleranceFt
                || Math.Abs(secondPortDiameterFt - hostDiameterFt) > toleranceFt)
                throw new ArgumentException("Both measured accessory port diameters must equal the existing duct diameter.");
            var length = start.DistanceTo(end);
            if (!Positive(length) || length <= shortCurveToleranceFt)
                throw new ArgumentException("The existing straight duct is too short.");
            var axis = Scale(Subtract(end, start), 1 / length);
            var station = Dot(Subtract(requestedCenter, start), axis);
            var center = Add(start, Scale(axis, station));
            if (center.DistanceTo(requestedCenter) > toleranceFt)
                throw new ArgumentException("The requested insertion point must lie on the existing duct centerline.");
            var firstLength = station - measuredPortSpacingFt / 2;
            var secondLength = length - station - measuredPortSpacingFt / 2;
            if (firstLength <= shortCurveToleranceFt + toleranceFt || secondLength <= shortCurveToleranceFt + toleranceFt)
                throw new ArgumentException("The measured accessory does not leave two valid retained duct segments.");
            return new InlineAccessoryGeometryPlan {
                Axis = axis, Center = center, FirstPort = Add(center, Scale(axis, -measuredPortSpacingFt / 2)),
                SecondPort = Add(center, Scale(axis, measuredPortSpacingFt / 2)),
                FirstRetainedLengthFt = firstLength, SecondRetainedLengthFt = secondLength,
                AccessoryLengthFt = measuredPortSpacingFt
            };
        }

        public static void RequireOpposingAxialPorts(BranchPoint3d first, BranchPoint3d second,
            BranchPoint3d firstOutward, BranchPoint3d secondOutward, double tolerance = 0.000001)
        {
            RequirePoint(first); RequirePoint(second); RequirePoint(firstOutward); RequirePoint(secondOutward);
            if (!Positive(tolerance) || tolerance > 0.001) throw new ArgumentException("Invalid port tolerance.");
            var delta = Subtract(second, first); var length = first.DistanceTo(second);
            if (!Positive(length)) throw new ArgumentException("Accessory ports must have distinct origins.");
            var axis = Scale(delta, 1 / length);
            var firstLength = firstOutward.DistanceTo(new BranchPoint3d(0, 0, 0));
            var secondLength = secondOutward.DistanceTo(new BranchPoint3d(0, 0, 0));
            if (!Positive(firstLength) || !Positive(secondLength)
                || Math.Abs(firstLength - 1) > tolerance || Math.Abs(secondLength - 1) > tolerance
                || Dot(firstOutward, axis) > -1 + tolerance || Dot(secondOutward, axis) < 1 - tolerance)
                throw new ArgumentException("Accessory ports must be axial, opposing, outward-facing unit directions.");
        }

        private static bool Positive(double value) => value > 0 && !double.IsNaN(value) && !double.IsInfinity(value);
        private static void RequirePoint(BranchPoint3d value)
        {
            if (double.IsNaN(value.X) || double.IsInfinity(value.X) || double.IsNaN(value.Y)
                || double.IsInfinity(value.Y) || double.IsNaN(value.Z) || double.IsInfinity(value.Z))
                throw new ArgumentException("Coordinates must be finite.");
        }
        private static BranchPoint3d Add(BranchPoint3d a, BranchPoint3d b) => new BranchPoint3d(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
        private static BranchPoint3d Subtract(BranchPoint3d a, BranchPoint3d b) => new BranchPoint3d(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
        private static BranchPoint3d Scale(BranchPoint3d a, double scale) => new BranchPoint3d(a.X * scale, a.Y * scale, a.Z * scale);
        private static double Dot(BranchPoint3d a, BranchPoint3d b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;
    }
}

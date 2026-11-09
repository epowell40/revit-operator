using System;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    public static class NativeDraftingCurveGeometry
    {
        public static object Read(Curve curve)
        {
            if (curve == null) throw new InvalidOperationException("Native curve geometry is required.");
            if (curve is Ellipse ellipse)
            {
                // Whole ellipses have no endpoints. Never call bounded-only
                // getters, invent endpoints, or substitute tessellation.
                double? start = ellipse.IsBound ? ellipse.GetEndParameter(0) : (double?)null;
                double? end = ellipse.IsBound ? ellipse.GetEndParameter(1) : (double?)null;
                _ = DraftingCurveReadback.EllipseKey(Vector(ellipse.Center), ellipse.RadiusX, ellipse.RadiusY,
                    Vector(ellipse.XDirection), Vector(ellipse.YDirection), start, end);
                _ = Vector(ellipse.Normal);
                return new { kind = curve.GetType().Name, isBound = ellipse.IsBound,
                    center = Point(ellipse.Center), radiusX = ellipse.RadiusX, radiusY = ellipse.RadiusY,
                    xDirection = Point(ellipse.XDirection), yDirection = Point(ellipse.YDirection), normal = Point(ellipse.Normal),
                    startParameter = start, endParameter = end,
                    geometryScope = "complete_native_ellipse_radii_frame_and_domain" };
            }
            if (curve is Arc circle && !curve.IsBound)
            {
                _ = DraftingCurveReadback.CircleKey(Vector(circle.Center), circle.Radius, Vector(circle.Normal));
                _ = Vector(circle.XDirection); _ = Vector(circle.YDirection);
                return new { kind = curve.GetType().Name, isBound = false, center = Point(circle.Center), radius = circle.Radius,
                    normal = Point(circle.Normal), xDirection = Point(circle.XDirection), yDirection = Point(circle.YDirection),
                    geometryScope = "complete_native_circle_center_radius_and_frame" };
            }
            if (!curve.IsBound) throw new InvalidOperationException("Bounded native curve geometry is required for this curve kind.");
            if (curve is HermiteSpline hermite)
            {
                var controls = hermite.ControlPoints.Take(DraftingCurveReadback.MaximumHermiteControls + 1).ToArray();
                var tangents = hermite.Tangents.Take(DraftingCurveReadback.MaximumHermiteControls + 1).ToArray();
                var parameters = hermite.Parameters.Cast<double>().Take(DraftingCurveReadback.MaximumHermiteControls + 1).ToArray();
                _ = DraftingCurveReadback.HermiteKey(hermite.IsPeriodic, hermite.IsCyclic,
                    controls.Select(Vector), tangents.Select(Vector), parameters, hermite.GetEndParameter(0), hermite.GetEndParameter(1));
                return new { kind = curve.GetType().Name, start = Point(curve.GetEndPoint(0)), end = Point(curve.GetEndPoint(1)),
                    periodic = hermite.IsPeriodic, cyclic = hermite.IsCyclic, controlPoints = controls.Select(Point).ToArray(),
                    tangents = tangents.Select(Point).ToArray(), parameters, startParameter = hermite.GetEndParameter(0),
                    endParameter = hermite.GetEndParameter(1), geometryScope = "complete_native_hermite_controls_tangents_parameters_and_bounded_domain" };
            }
            if (curve is NurbSpline spline)
                return new { kind = curve.GetType().Name, start = Point(curve.GetEndPoint(0)), end = Point(curve.GetEndPoint(1)),
                    degree = spline.Degree, rational = spline.isRational, cyclic = spline.IsCyclic,
                    controlPoints = spline.CtrlPoints.Select(Point).ToArray(), knots = spline.Knots.Cast<double>().ToArray(),
                    weights = spline.Weights.Cast<double>().ToArray(), startParameter = spline.GetEndParameter(0), endParameter = spline.GetEndParameter(1),
                    geometryScope = "complete_native_nurbs_controls_knots_weights_and_bounded_domain" };
            if (curve is Arc arc)
                return new { kind = curve.GetType().Name, start = Point(curve.GetEndPoint(0)), end = Point(curve.GetEndPoint(1)),
                    midpoint = Point(curve.Evaluate(0.5, true)), center = Point(arc.Center), radius = arc.Radius,
                    normal = Point(arc.Normal), xDirection = Point(arc.XDirection), yDirection = Point(arc.YDirection),
                    startParameter = arc.GetEndParameter(0), endParameter = arc.GetEndParameter(1) };
            if (curve is Line)
                return new { kind = curve.GetType().Name, start = Point(curve.GetEndPoint(0)), end = Point(curve.GetEndPoint(1)) };
            throw new InvalidOperationException("Complete readback is unavailable for native curve kind " + curve.GetType().Name);
        }

        public static string NurbsRelativeKey(NurbSpline spline, View view)
        {
            if (!spline.IsBound) throw new InvalidOperationException("Unbounded native spline requires a separate comparison contract.");
            var origin = view.Origin; var right = view.RightDirection.Normalize();
            var up = view.UpDirection.Normalize(); var normal = view.ViewDirection.Normalize();
            var controls = spline.CtrlPoints.Select(p => p - origin).Select(p => new[] {
                p.DotProduct(right), p.DotProduct(up), p.DotProduct(normal) }).ToArray();
            return DraftingCubicBezier.NativeNurbsGeometryKey(spline.Degree, spline.isRational, spline.IsCyclic,
                controls, spline.Knots.Cast<double>(), spline.Weights.Cast<double>(), spline.GetEndParameter(0), spline.GetEndParameter(1));
        }

        public static string HermiteRelativeKey(HermiteSpline spline, View view)
        {
            if (!spline.IsBound) throw new InvalidOperationException("Unbounded native Hermite spline requires a separate comparison contract.");
            var origin = view.Origin; var right = view.RightDirection.Normalize();
            var up = view.UpDirection.Normalize(); var depth = view.ViewDirection.Normalize();
            double[] Direction(XYZ v) => new[] { v.DotProduct(right), v.DotProduct(up), v.DotProduct(depth) };
            return DraftingCurveReadback.HermiteKey(spline.IsPeriodic, spline.IsCyclic,
                spline.ControlPoints.Select(p => Direction(p - origin)), spline.Tangents.Select(Direction), spline.Parameters.Cast<double>(),
                spline.GetEndParameter(0), spline.GetEndParameter(1));
        }

        public static string CircleRelativeKey(Arc circle, View view)
        {
            if (circle.IsBound) throw new InvalidOperationException("A full-circle comparison requires an unbounded native Arc.");
            var right = view.RightDirection.Normalize(); var up = view.UpDirection.Normalize(); var depth = view.ViewDirection.Normalize();
            double[] Direction(XYZ v) => new[] { v.DotProduct(right), v.DotProduct(up), v.DotProduct(depth) };
            return DraftingCurveReadback.CircleKey(Direction(circle.Center - view.Origin), circle.Radius, Direction(circle.Normal));
        }

        public static string EllipseRelativeKey(Ellipse ellipse, View view)
        {
            var right = view.RightDirection.Normalize(); var up = view.UpDirection.Normalize(); var depth = view.ViewDirection.Normalize();
            double[] Direction(XYZ v) => new[] { v.DotProduct(right), v.DotProduct(up), v.DotProduct(depth) };
            return DraftingCurveReadback.EllipseKey(Direction(ellipse.Center-view.Origin), ellipse.RadiusX, ellipse.RadiusY,
                Direction(ellipse.XDirection), Direction(ellipse.YDirection),
                ellipse.IsBound ? ellipse.GetEndParameter(0) : (double?)null,
                ellipse.IsBound ? ellipse.GetEndParameter(1) : (double?)null);
        }

        private static object Point(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };
        private static double[] Vector(XYZ point)
        {
            var v = new[] { point.X, point.Y, point.Z };
            if (v.Any(n => double.IsNaN(n) || double.IsInfinity(n)))
                throw new InvalidOperationException("Native curve vector must be finite.");
            return v;
        }
    }
}

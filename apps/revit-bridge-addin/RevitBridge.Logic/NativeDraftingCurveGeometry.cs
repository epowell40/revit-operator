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
            if (curve == null || !curve.IsBound) throw new InvalidOperationException("Bounded native curve geometry is required.");
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

        private static object Point(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };
    }
}

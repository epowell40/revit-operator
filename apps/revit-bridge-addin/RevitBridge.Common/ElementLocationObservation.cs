using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>Small placement observations, not a connector, host-fit or geometry certificate.</summary>
    public static class ElementLocationObservation
    {
        private static Dictionary<string, object> Start(string kind) => new Dictionary<string, object>
        {
            ["status"] = "observed", ["kind"] = kind,
            ["coordinateSpace"] = "document_internal", ["lengthUnits"] = "feet"
        };

        private static void Vector(Dictionary<string, object> result, string field, Func<double[]> read)
        {
            try
            {
                var xyz = read();
                if (xyz == null || xyz.Length != 3 || xyz.Any(v => double.IsNaN(v) || double.IsInfinity(v)))
                    throw new InvalidOperationException();
                result[field] = xyz.ToArray();
            }
            catch { result["status"] = "partial"; result[field + "Status"] = "unavailable"; }
        }

        public static object Point(Func<double[]> point, Func<double> rotation)
        {
            var result = Start("point");
            Vector(result, "point", point);
            try
            {
                var radians = rotation();
                if (double.IsNaN(radians) || double.IsInfinity(radians)) throw new InvalidOperationException();
                result["rotationRadians"] = radians;
            }
            catch { result["status"] = "partial"; result["rotationStatus"] = "unavailable"; }
            return result;
        }

        public static object Curve(bool isLine, bool isBound, Func<double[]> start, Func<double[]> end)
        {
            var result = Start(isLine ? "line" : "curve");
            result["isBound"] = isBound;
            result["scope"] = isLine ? "location_centerline" : "endpoints_only_not_full_curve";
            if (isBound) { Vector(result, "start", start); Vector(result, "end", end); }
            else { result["status"] = "partial"; result["endpointsStatus"] = "unavailable_unbounded"; }
            return result;
        }

        public static object Unavailable(string reason) => new { status = "unavailable", reason };
    }
}

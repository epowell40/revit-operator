using System;
using System.Globalization;

namespace RevitBridge.Common
{
    public static class ScheduleFilterValue
    {
        // Explicit types avoid guessing whether a numeric-looking label is an ID.
        // Double values are internal Revit units; display values are parsed by the native field's spec.
        public static object Parse(string? value, string? valueType)
        {
            if (value == null) throw new ArgumentException("Schedule filter value is required.");
            switch ((valueType ?? "string").Trim().ToLowerInvariant())
            {
                case "string": return value;
                case "element_id":
                    if (long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id) && id > 0) return id;
                    break;
                case "integer":
                    if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var integer)) return integer;
                    break;
                case "double":
                    if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && !double.IsNaN(number) && !double.IsInfinity(number)) return number;
                    break;
                default: throw new ArgumentException("Use string, element_id, integer, double (internal units), or display (document units) for valueType.");
            }
            throw new ArgumentException("Invalid schedule filter value for the explicitly requested type.");
        }
    }
}

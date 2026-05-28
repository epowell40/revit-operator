using System;
using System.Globalization;
using Autodesk.Revit.DB;

namespace RevitBridge.Common
{
    public static class LengthTextUtil
    {
        public static bool TryParseLengthToFeet(string? raw, out double feet, out string error)
        {
            return TryParseLengthToFeet(null, raw, out feet, out error);
        }

        public static bool TryParseLengthToFeet(Document? doc, string? raw, out double feet, out string error)
        {
            feet = 0;
            error = "";

            var t = (raw ?? "").Trim();
            if (t.Length == 0)
            {
                error = "Empty length string.";
                return false;
            }

            try
            {
                if (doc != null)
                {
                    try
                    {
                        var units = doc.GetUnits();
                        if (UnitFormatUtils.TryParse(units, SpecTypeId.Length, t, out var parsed))
                        {
                            feet = parsed;
                            return true;
                        }
                    }
                    catch
                    {
                        // continue to manual parsing
                    }
                }

                if (TryParseUnitSuffix(t, "\"", 1.0 / 12.0, out feet)) return true;
                if (TryParseUnitSuffix(t, "in", 1.0 / 12.0, out feet)) return true;
                if (TryParseUnitSuffix(t, "ft", 1.0, out feet)) return true;
                if (TryParseUnitSuffix(t, "'", 1.0, out feet)) return true;
                if (TryParseUnitSuffix(t, "mm", 0.0254 / 12.0, out feet)) return true;
                if (TryParseUnitSuffix(t, "cm", 0.3048 / 100.0 / 12.0, out feet)) return true;
                if (TryParseUnitSuffix(t, "m", 0.3048 / 12.0, out feet)) return true;

                if (double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out feet) ||
                    double.TryParse(t, NumberStyles.Float, CultureInfo.CurrentCulture, out feet))
                {
                    return true; // assume raw feet for backward compatibility
                }

                error = $"Invalid length string: \"{raw}\".";
                return false;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        public static string FormatLength(Document? doc, double feet)
        {
            if (doc == null)
            {
                return feet.ToString("G", CultureInfo.InvariantCulture);
            }

            try
            {
                var units = doc.GetUnits();
                return UnitFormatUtils.Format(units, SpecTypeId.Length, feet, forEditing: true);
            }
            catch
            {
                return feet.ToString("G", CultureInfo.InvariantCulture);
            }
        }

        private static bool TryParseUnitSuffix(string t, string suffix, double feetPerSuffixUnit, out double feet)
        {
            feet = 0;
            if (!t.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                return false;

            var num = t.Substring(0, t.Length - suffix.Length).Trim();
            if (num.Length == 0) return false;
            if (!double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out var raw) &&
                !double.TryParse(num, NumberStyles.Float, CultureInfo.CurrentCulture, out raw))
            {
                return false;
            }

            feet = raw * feetPerSuffixUnit;
            return true;
        }
    }
}

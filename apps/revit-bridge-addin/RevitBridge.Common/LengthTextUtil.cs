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

                if (EngineeringLengthText.TryParseLengthToFeet(t, unitlessIsInches: false, out feet)) return true;

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

    }
}

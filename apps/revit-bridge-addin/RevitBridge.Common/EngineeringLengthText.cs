using System;
using System.Globalization;

namespace RevitBridge.Common
{
    public static class EngineeringLengthText
    {
        public static bool TryParseLengthToFeet(string? raw, bool unitlessIsInches, out double feet)
        {
            feet = 0;
            var text = (raw ?? "").Trim().ToLowerInvariant();
            if (text.Length == 0) return false;

            var units = new[]
            {
                new { Suffix = "inches", Factor = 1.0 / 12.0 },
                new { Suffix = "inch", Factor = 1.0 / 12.0 },
                new { Suffix = "feet", Factor = 1.0 },
                new { Suffix = "foot", Factor = 1.0 },
                new { Suffix = "mm", Factor = 1.0 / 304.8 },
                new { Suffix = "cm", Factor = 1.0 / 30.48 },
                new { Suffix = "ft", Factor = 1.0 },
                new { Suffix = "in", Factor = 1.0 / 12.0 },
                new { Suffix = "m", Factor = 1.0 / 0.3048 },
                new { Suffix = "\"", Factor = 1.0 / 12.0 },
                new { Suffix = "'", Factor = 1.0 }
            };

            var factor = unitlessIsInches ? 1.0 / 12.0 : 1.0;
            foreach (var unit in units)
            {
                if (!text.EndsWith(unit.Suffix, StringComparison.OrdinalIgnoreCase)) continue;
                text = text.Substring(0, text.Length - unit.Suffix.Length).Trim();
                factor = unit.Factor;
                break;
            }

            if (!TryParseNumber(text, out var value)) return false;
            feet = value * factor;
            return !double.IsNaN(feet) && !double.IsInfinity(feet);
        }

        private static bool TryParseNumber(string text, out double value)
        {
            value = 0;
            var token = (text ?? "").Trim();
            if (double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out value) ||
                double.TryParse(token, NumberStyles.Float, CultureInfo.CurrentCulture, out value))
            {
                return !double.IsNaN(value) && !double.IsInfinity(value);
            }

            var sign = 1.0;
            if (token.StartsWith("-", StringComparison.Ordinal))
            {
                sign = -1.0;
                token = token.Substring(1).Trim();
            }
            else if (token.StartsWith("+", StringComparison.Ordinal))
            {
                token = token.Substring(1).Trim();
            }

            var normalized = token.Replace('-', ' ');

            var parts = normalized.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 1 || parts.Length > 2) return false;
            var fraction = parts[parts.Length - 1].Split('/');
            if (fraction.Length != 2
                || !double.TryParse(fraction[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var numerator)
                || !double.TryParse(fraction[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var denominator)
                || denominator == 0)
            {
                return false;
            }

            var whole = 0.0;
            if (parts.Length == 2
                && !double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out whole))
            {
                return false;
            }
            value = sign * (Math.Abs(whole) + Math.Abs(numerator / denominator));
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    public static class ScheduleCellUpdatePolicy
    {
        private static readonly HashSet<string> IdentifierFieldNames = new HashSet<string>(StringComparer.Ordinal)
        {
            "mark",
            "typemark",
            "number",
            "name",
            "equipmentnumber",
            "equipmentmark",
            "equipmentid",
            "equipmenttag",
            "unitnumber",
            "devicenumber",
            "tagnumber",
            "assetid",
            "designation",
            "desig",
            "tag",
            "id"
        };

        private static readonly Regex FirstNumber = new Regex(@"[-+]?\d[\d,]*(?:\.\d+)?", RegexOptions.Compiled);

        public static string NormalizeFieldName(string? value)
        {
            var source = (value ?? "").Trim();
            if (source.Length == 0) return "";
            var buffer = new StringBuilder(source.Length);
            foreach (var ch in source)
            {
                if (char.IsLetterOrDigit(ch)) buffer.Append(char.ToLowerInvariant(ch));
            }
            return buffer.ToString();
        }

        public static bool FieldNameMatches(string? requested, string? parameterName, string? heading)
        {
            var target = NormalizeFieldName(requested);
            if (target.Length == 0) return false;
            foreach (var candidate in new[] { NormalizeFieldName(parameterName), NormalizeFieldName(heading) })
            {
                if (string.Equals(target, candidate, StringComparison.Ordinal)) return true;
                // Natural schedule requests commonly omit unit/flow suffixes (for
                // example "Supply Air" versus "Supply Airflow CFM"). A prefix match
                // is useful only when unique; the handler blocks multiple matches.
                if (target.Length >= 4 && candidate.Length >= 4 &&
                    (candidate.StartsWith(target, StringComparison.Ordinal) || target.StartsWith(candidate, StringComparison.Ordinal))) return true;
            }
            return false;
        }

        public static bool IsLikelyIdentifierField(string? parameterName, string? heading)
        {
            return IdentifierFieldNames.Contains(NormalizeFieldName(parameterName)) ||
                   IdentifierFieldNames.Contains(NormalizeFieldName(heading));
        }

        public static bool ValueMatches(string? expected, string? rawValue, string? displayValue)
        {
            var wanted = CollapseWhitespace(expected);
            if (wanted.Length == 0) return false;
            // Schedule requests are expressed in visible cell units. When Revit supplies
            // a display value, never let a coincidentally equal raw internal-unit number
            // satisfy the guard (for example 10,000 internal CFS versus 10,000 CFM).
            var candidates = string.IsNullOrWhiteSpace(displayValue)
                ? new[] { rawValue }
                : new[] { displayValue };
            foreach (var candidate in candidates)
            {
                var actual = CollapseWhitespace(candidate);
                if (actual.Length == 0) continue;
                if (string.Equals(wanted, actual, StringComparison.OrdinalIgnoreCase)) return true;
            }

            // A redline often omits the unit suffix visible in a schedule (for example
            // "10,000" versus "10,000 CFM"). Numeric fallback is allowed only when
            // the requested value itself contains no alphabetic unit text.
            if ((expected ?? "").Any(char.IsLetter)) return false;
            if (!TryReadFirstNumber(expected, out var requestedNumber)) return false;
            foreach (var candidate in candidates)
            {
                if (TryReadFirstNumber(candidate, out var actualNumber) && Math.Abs(requestedNumber - actualNumber) < 1e-9)
                {
                    return true;
                }
            }
            return false;
        }

        public static string RemoveNumericGroupSeparators(string? value)
        {
            return (value ?? "").Replace(",", "");
        }

        private static string CollapseWhitespace(string? value)
        {
            return string.Join(" ", (value ?? "").Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        }

        private static bool TryReadFirstNumber(string? value, out double number)
        {
            number = 0;
            var match = FirstNumber.Match(value ?? "");
            if (!match.Success) return false;
            var normalized = match.Value.Replace(",", "");
            return double.TryParse(normalized, NumberStyles.Float, CultureInfo.InvariantCulture, out number);
        }
    }
}

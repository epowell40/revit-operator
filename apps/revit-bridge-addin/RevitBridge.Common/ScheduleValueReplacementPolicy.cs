using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public static class ScheduleValueReplacementPolicy
    {
        public static bool FieldNameMatchesAny(string? parameterName, string? heading, IEnumerable<string>? requestedNames)
        {
            var candidates = new[]
            {
                ScheduleCellUpdatePolicy.NormalizeFieldName(parameterName),
                ScheduleCellUpdatePolicy.NormalizeFieldName(heading)
            };
            var requested = (requestedNames ?? Array.Empty<string>())
                .Select(ScheduleCellUpdatePolicy.NormalizeFieldName)
                .Where(value => value.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToList();
            return requested.Count > 0 && candidates.Any(candidate =>
                candidate.Length > 0 && requested.Contains(candidate, StringComparer.Ordinal));
        }

        public static bool TryBuildLiteralReplacement(string? currentValue, string? find, string? replace, out string nextValue)
        {
            var current = currentValue ?? "";
            var needle = find ?? "";
            var replacement = replace ?? "";
            nextValue = current;
            if (needle.Length == 0 || string.Equals(needle, replacement, StringComparison.Ordinal)) return false;
            if (current.IndexOf(needle, StringComparison.Ordinal) < 0) return false;
            nextValue = current.Replace(needle, replacement);
            return !string.Equals(current, nextValue, StringComparison.Ordinal);
        }
    }
}

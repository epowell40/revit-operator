using System;

namespace RevitBridge.Common
{
    public static class ParameterValueMatchPolicy
    {
        public static bool Matches(string value, string? valueContains, string? valueEquals, bool caseSensitive)
        {
            var comparison = caseSensitive ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
            if (!string.IsNullOrEmpty(valueContains) && value.IndexOf(valueContains, comparison) < 0) return false;
            if (!string.IsNullOrEmpty(valueEquals) && !string.Equals(value, valueEquals, comparison)) return false;
            return true;
        }
    }
}

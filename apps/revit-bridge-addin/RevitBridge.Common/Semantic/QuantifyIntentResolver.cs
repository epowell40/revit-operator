using System;
using System.Text.RegularExpressions;

namespace RevitBridge.Common.Semantic
{
    public static class QuantifyIntentResolver
    {
        private static readonly Regex CountPattern = new Regex(@"\b(count|counts|counting|how\s+many|quantity|quantities|total)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex ListPattern = new Regex(@"\b(list|listing|enumerate|enumeration|show|rows?|details?)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        public static string Resolve(string intent)
        {
            var value = (intent ?? string.Empty).Trim();
            if (value.Length == 0 || value.Length > 160)
                throw new ArgumentException("Quantify intent must be count, list, count_and_list, or a short description that clearly requests counting or listing.");

            var canonical = value.Replace('-', '_').Replace(' ', '_').ToLowerInvariant();
            if (canonical == "count" || canonical == "list" || canonical == "count_and_list") return canonical;

            var wantsCount = CountPattern.IsMatch(value);
            var wantsList = ListPattern.IsMatch(value);
            if (wantsCount && wantsList) return "count_and_list";
            if (wantsCount) return "count";
            if (wantsList) return "list";
            throw new ArgumentException("Quantify intent could not be resolved exactly. Use count, list, count_and_list, or clearly request counting or listing.");
        }
    }
}

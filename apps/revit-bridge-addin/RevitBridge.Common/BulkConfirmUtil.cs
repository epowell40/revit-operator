using System;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    public static class BulkConfirmUtil
    {
        private static readonly Regex MultiWhitespace = new Regex("\\s+", RegexOptions.Compiled);

        private static bool AllowSimpleAffirmative()
        {
            // Default to allowing a simple "yes" confirmation for bulk operations, since the user has already
            // explicitly enabled writes via the Operator UI (write grant) and the model still enforces tool-level
            // confirmations per endpoint.
            //
            // Set OPERATOR_BULK_CONFIRM_SIMPLE=0 to require the exact requiredConfirm string again.
            var v = (Environment.GetEnvironmentVariable("OPERATOR_BULK_CONFIRM_SIMPLE") ?? "1").Trim().ToLowerInvariant();
            return v != "0" && v != "false" && v != "no";
        }

        public static string Normalize(string? input)
        {
            var s = (input ?? "").Trim();
            if (s.Length == 0) return "";

            // Strip common "copy from chat" wrappers (markdown + quotes), iteratively.
            bool changed;
            do
            {
                changed = false;
                s = StripOuterPair(s, "**", "**", ref changed);
                s = StripOuterPair(s, "__", "__", ref changed);
                s = StripOuterPair(s, "*", "*", ref changed);
                s = StripOuterPair(s, "_", "_", ref changed);
                s = StripOuterPair(s, "`", "`", ref changed);
                s = StripOuterPair(s, "\"", "\"", ref changed);
                s = StripOuterPair(s, "'", "'", ref changed);
            } while (changed && s.Length > 0);

            s = MultiWhitespace.Replace(s, " ").Trim();
            return s;
        }

        private static string StripOuterPair(string s, string prefix, string suffix, ref bool changed)
        {
            if (s.Length < prefix.Length + suffix.Length + 1) return s;
            if (!s.StartsWith(prefix, StringComparison.Ordinal)) return s;
            if (!s.EndsWith(suffix, StringComparison.Ordinal)) return s;
            changed = true;
            return s.Substring(prefix.Length, s.Length - prefix.Length - suffix.Length).Trim();
        }

        public static bool EqualsNormalized(string? got, string expected)
        {
            if (expected == null) expected = "";
            var exp = expected.Trim();
            var norm = Normalize(got);
            if (string.Equals(norm, exp, StringComparison.Ordinal)) return true;

            // For bulk operations that require a typed confirmation, allow a simple affirmative response ("yes")
            // when enabled. This keeps UX low-friction while still requiring an explicit confirm field.
            if (!AllowSimpleAffirmative()) return false;
            if (string.IsNullOrWhiteSpace(norm)) return false;
            if (!LooksLikeBulkExpected(exp)) return false;
            return IsAffirmative(norm);
        }

        public static string ExpectedApplyChanges(int count) => $"APPLY {count} CHANGES";

        public static string ExpectedDeleteElements(int count) => $"DELETE {count} ELEMENTS";

        private static bool LooksLikeBulkExpected(string expected)
        {
            var e = (expected ?? "").Trim();
            if (e.Length == 0) return false;
            // Keep this conservative: only treat APPLY/DELETE confirmations as eligible.
            return e.StartsWith("APPLY ", StringComparison.OrdinalIgnoreCase) || e.StartsWith("DELETE ", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsAffirmative(string normalized)
        {
            var s = (normalized ?? "").Trim().ToLowerInvariant();
            if (s == "y" || s == "yes") return true;
            if (s == "ok" || s == "okay") return true;
            if (s == "apply" || s == "confirm") return true;
            return false;
        }
    }
}

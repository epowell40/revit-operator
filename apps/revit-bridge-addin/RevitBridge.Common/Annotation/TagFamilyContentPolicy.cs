using System;
using System.Linq;

namespace RevitBridge.Common.Annotation
{
    public static class TagFamilyContentPolicy
    {
        public const string None = "none";
        public const string AirflowOnly = "airflow_only";

        public static string NormalizeProfile(string? value)
        {
            var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
            if (normalized.Length == 0 || normalized == None) return None;
            if (normalized == AirflowOnly) return AirflowOnly;
            throw new ArgumentException("Tag family content profile must be none|airflow_only.", nameof(value));
        }

        public static bool ShouldKeepText(string profile, string? sampleText)
        {
            var normalizedProfile = NormalizeProfile(profile);
            if (normalizedProfile == None) return true;

            var text = (sampleText ?? string.Empty).Trim().ToUpperInvariant();
            if (!text.Any(char.IsDigit)) return false;
            var compact = new string(text.Where(c => !char.IsWhiteSpace(c)).ToArray());
            return compact.Contains("CFM") ||
                   compact.Contains("M³/H") ||
                   compact.Contains("M3/H") ||
                   compact.Contains("L/S") ||
                   compact.Contains("LPS");
        }
    }
}

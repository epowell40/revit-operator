using System;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    public static class OperatorDryRunTurnPolicy
    {
        public static bool IsDryRunOnlyRequest(string? userText)
        {
            if (string.IsNullOrWhiteSpace(userText)) return false;

            var text = (userText ?? "").Trim().ToLowerInvariant();
            if (ContainsAny(text,
                    "preflight only",
                    "plan only",
                    "planning only",
                    "do not apply",
                    "don't apply",
                    "dont apply",
                    "without applying",
                    "no apply",
                    "do not make changes",
                    "don't make changes",
                    "no changes"))
            {
                return true;
            }

            var mentionsDryRun = text.Contains("dry-run") || text.Contains("dry run");
            if (!mentionsDryRun) return false;

            // "Only" frequently scopes the apply condition in a staged write request
            // (for example, "dry-run first, then apply only if readback passes").
            // Treat an explicit staged continuation as authoritative unless a stronger
            // no-apply phrase above already made the request dry-run-only.
            if (Regex.IsMatch(
                    text,
                    @"\bdry[-\s]?run\b[^.!?\n]{0,180}\b(?:then|after(?:wards)?|if\s+(?:it|that|the\s+(?:result|readback|dry[-\s]?run)))\b[^.!?\n]{0,120}\bapply\b",
                    RegexOptions.IgnoreCase) ||
                Regex.IsMatch(
                    text,
                    @"\b(?:then|after(?:wards)?)\b[^.!?\n]{0,120}\bapply\b",
                    RegexOptions.IgnoreCase))
            {
                return false;
            }

            return Regex.IsMatch(text, @"\bdry[-\s]?run\s+only\b", RegexOptions.IgnoreCase) ||
                Regex.IsMatch(text, @"\b(?:one|single)\b[^.!?\n]{0,40}\bdry[-\s]?run\b", RegexOptions.IgnoreCase) ||
                Regex.IsMatch(text, @"\bstop\b[^.!?\n]{0,80}\b(?:after|following)\b[^.!?\n]{0,50}\bdry[-\s]?run\b", RegexOptions.IgnoreCase) ||
                Regex.IsMatch(text, @"\bdry[-\s]?run\b[^.!?\n]{0,80}\band\s+stop\b", RegexOptions.IgnoreCase) ||
                ContainsAny(text,
                    "do not continue",
                    "don't continue",
                    "dont continue",
                    "without apply");
        }

        public static bool BodyRequestsDryRun(string? bodyJson)
        {
            if (string.IsNullOrWhiteSpace(bodyJson)) return false;

            try
            {
                using var document = JsonDocument.Parse(bodyJson!);
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return false;

                if (TryReadBoolean(root, "dryRun", out var dryRun) && dryRun) return true;
                if (TryReadBoolean(root, "dry_run", out var snakeDryRun) && snakeDryRun) return true;
                if (TryReadBoolean(root, "apply", out var apply) && !apply) return true;
                return false;
            }
            catch
            {
                return false;
            }
        }

        public static bool IsScheduleCellUpdatePreview(string? method, string? path, string? bodyJson)
        {
            return string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(path, "/revit/update-schedule-cell", StringComparison.OrdinalIgnoreCase) &&
                BodyRequestsDryRun(bodyJson);
        }

        private static bool TryReadBoolean(JsonElement root, string propertyName, out bool value)
        {
            value = false;
            if (!root.TryGetProperty(propertyName, out var property) ||
                (property.ValueKind != JsonValueKind.True && property.ValueKind != JsonValueKind.False))
            {
                return false;
            }

            value = property.GetBoolean();
            return true;
        }

        private static bool ContainsAny(string text, params string[] candidates)
        {
            foreach (var candidate in candidates)
            {
                if (text.Contains(candidate)) return true;
            }

            return false;
        }
    }
}

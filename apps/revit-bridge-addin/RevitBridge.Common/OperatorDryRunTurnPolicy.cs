using System;
using System.Text.Json;

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

            return ContainsAny(text,
                "only",
                "stop",
                "do not continue",
                "don't continue",
                "dont continue",
                "one action",
                "single action",
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

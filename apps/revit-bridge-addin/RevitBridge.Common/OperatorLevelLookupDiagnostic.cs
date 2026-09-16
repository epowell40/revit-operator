using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class OperatorLevelLookupDiagnostic
    {
        public static string Describe(long? levelId, string? levelName, IEnumerable<string> availableNames)
        {
            var name = (levelName ?? "").Trim();
            if ((!levelId.HasValue || levelId.Value <= 0) && name.Length == 0)
                return "create-view(create_floor_plan) requires levelId or levelName.";
            var selector = levelId.HasValue && levelId.Value > 0
                ? "levelId " + levelId.Value
                : "levelName " + JsonSerializer.Serialize(name.Length <= 120 ? name : name.Substring(0, 120) + "…");
            // Never offer a truncated name as an exact selector. Keep diagnostics bounded.
            var names = availableNames.Where(value => !string.IsNullOrWhiteSpace(value) && value.Length <= 120)
                .Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(value => value, StringComparer.OrdinalIgnoreCase).Take(17).ToArray();
            var suffix = names.Length == 0 ? "No short level names are available; inspect the active document's levels."
                : "Available exact level names: " + string.Join(", ", names.Take(16).Select(value => JsonSerializer.Serialize(value)))
                    + (names.Length > 16 ? " (additional names omitted)." : ".");
            return "create-view could not resolve " + selector + " to a Level in the active document. " + suffix;
        }
    }
}

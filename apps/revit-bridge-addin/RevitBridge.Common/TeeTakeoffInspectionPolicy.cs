using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class TeeTakeoffInspectionPolicy
    {
        public static bool TryValidate(JsonElement body, out string error)
        {
            error = "";
            var enabled = body.TryGetProperty("includeTeeReplacementState", out var flag);
            if (enabled && flag.ValueKind != JsonValueKind.True && flag.ValueKind != JsonValueKind.False)
            { error = "includeTeeReplacementState must be boolean."; return false; }
            if (!enabled || flag.ValueKind == JsonValueKind.False)
            {
                if (body.TryGetProperty("replacementRemovedIds", out _) || body.TryGetProperty("replacementTypeIds", out _))
                { error = "Replacement scopes require includeTeeReplacementState=true."; return false; }
                return InlineAccessoryInspectionPolicy.TryValidate(body, out error);
            }
            if (body.TryGetProperty("includeInlineAccessoryState", out var inline) && inline.ValueKind != JsonValueKind.False)
            { error = "Select one bounded preservation state."; return false; }
            bool Ids(string name, int min, int max, out HashSet<long> ids)
            {
                ids = new HashSet<long>();
                if (!body.TryGetProperty(name, out var a) || a.ValueKind != JsonValueKind.Array || a.GetArrayLength() < min || a.GetArrayLength() > max) return false;
                foreach (var v in a.EnumerateArray()) if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt64(out var id) || id <= 0 || !ids.Add(id)) return false;
                return true;
            }
            if (!Ids("elementIds", 1, 8, out var owners) || !Ids("replacementRemovedIds", 0, 12, out var removed)
                || !Ids("replacementTypeIds", 0, 16, out var types) || !Ids("preservationScheduleIds", 0, 32, out var schedules)
                || owners.Concat(removed).Concat(types).Concat(schedules).Distinct().Count() != owners.Count + removed.Count + types.Count + schedules.Count)
            { error = "Replacement state requires bounded unique disjoint physical/removed/type/schedule scopes."; return false; }
            foreach (var name in new[] { "includeAllRefs", "includeCoordinateSystem", "includeFlexGeometry" })
                if (body.TryGetProperty(name, out var required) && required.ValueKind != JsonValueKind.True)
                { error = "Replacement state requires " + name + "=true."; return false; }
            if (body.TryGetProperty("onlyOpenPhysicalConnectors", out var open) && open.ValueKind != JsonValueKind.False)
            { error = "Replacement state requires all physical connections."; return false; }
            return true;
        }
    }
}

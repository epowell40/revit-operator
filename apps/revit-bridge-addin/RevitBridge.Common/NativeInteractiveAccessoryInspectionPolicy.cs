using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class NativeInteractiveAccessoryInspectionPolicy
    {
        public static bool TryValidate(JsonElement body, out string error)
        {
            error = "";
            if (!body.TryGetProperty("includeNativePlacementState", out var flag))
            {
                if (body.TryGetProperty("placementTypeIds", out _) || body.TryGetProperty("placementSystemIds", out _) || body.TryGetProperty("placementChangedIds", out _))
                { error = "Placement inspection scopes require includeNativePlacementState=true."; return false; }
                return true;
            }
            if (flag.ValueKind != JsonValueKind.True && flag.ValueKind != JsonValueKind.False)
            { error = "includeNativePlacementState must be boolean."; return false; }
            if (flag.ValueKind == JsonValueKind.False)
            {
                if (body.TryGetProperty("placementTypeIds", out _) || body.TryGetProperty("placementSystemIds", out _) || body.TryGetProperty("placementChangedIds", out _))
                { error = "Disabled placement state cannot carry placement scopes."; return false; }
                return true;
            }
            bool Ids(string field, int min, int max, out HashSet<long> result)
            {
                result = new HashSet<long>();
                if (!body.TryGetProperty(field, out var list) || list.ValueKind != JsonValueKind.Array
                    || list.GetArrayLength() < min || list.GetArrayLength() > max) return false;
                foreach (var item in list.EnumerateArray())
                    if (item.ValueKind != JsonValueKind.Number || !item.TryGetInt64(out var id) || id <= 0 || id > 9007199254740991L || !result.Add(id)) return false;
                return true;
            }
            if (!Ids("elementIds", 1, 5000, out var owners) || !Ids("placementTypeIds", 1, 1, out var types)
                || !Ids("placementSystemIds", 0, 50, out var systems) || !Ids("placementChangedIds", 0, 1024, out _)
                || !Ids("preservationScheduleIds", 0, 32, out var schedules)
                || new[] { owners, types, systems, schedules }.Sum(x => x.Count) != owners.Concat(types).Concat(systems).Concat(schedules).Distinct().Count())
            { error = "Placement state requires exact disjoint physical, type, system and schedule scopes within native bounds."; return false; }
            foreach (var field in new[] { "includeAllRefs", "includeCoordinateSystem", "includeFlexGeometry" })
                if (!body.TryGetProperty(field, out var value) || value.ValueKind != JsonValueKind.True)
                { error = "Placement state requires " + field + "=true."; return false; }
            if (body.TryGetProperty("replacementRemovedIds", out _) || body.TryGetProperty("replacementTypeIds", out _))
            { error = "Placement state cannot carry replacement scopes."; return false; }
            foreach (var field in new[] { "onlyOpenPhysicalConnectors", "includeInlineAccessoryState", "includeTeeReplacementState", "includeVerificationParameters" })
                if (body.TryGetProperty(field, out var value) && value.ValueKind != JsonValueKind.False)
                { error = "Placement state cannot use another preservation projection or omit connected ports."; return false; }
            return true;
        }
    }
}

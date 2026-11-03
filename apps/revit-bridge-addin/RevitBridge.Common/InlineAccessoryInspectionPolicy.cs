using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class InlineAccessoryInspectionPolicy
    {
        public static bool TryValidate(JsonElement body, out string error)
        {
            error = "";
            if (body.ValueKind != JsonValueKind.Object) { error = "Connector inspection must be an object."; return false; }
            var enabled = body.TryGetProperty("includeInlineAccessoryState", out var flag);
            if (enabled && flag.ValueKind != JsonValueKind.True && flag.ValueKind != JsonValueKind.False)
            { error = "includeInlineAccessoryState must be boolean."; return false; }
            if (!enabled || flag.ValueKind == JsonValueKind.False)
            {
                if (!body.TryGetProperty("preservationScheduleIds", out _)) return true;
                error = "preservationScheduleIds requires includeInlineAccessoryState=true."; return false;
            }
            bool Ids(string name, int min, int max, out HashSet<long> seen)
            {
                seen = new HashSet<long>();
                if (!body.TryGetProperty(name, out var values) || values.ValueKind != JsonValueKind.Array
                    || values.GetArrayLength() < min || values.GetArrayLength() > max) return false;
                foreach (var value in values.EnumerateArray())
                    if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var id) || id <= 0 || !seen.Add(id)) return false;
                return true;
            }
            if (!Ids("elementIds", 1, 5, out var owners) || !Ids("preservationScheduleIds", 0, 32, out var schedules)
                || owners.Overlaps(schedules))
            { error = "Inline state requires 1-5 exact physical owners and 0-32 disjoint schedules."; return false; }
            foreach (var name in new[] { "includeAllRefs", "includeCoordinateSystem", "includeFlexGeometry" })
                if (body.TryGetProperty(name, out var required) && required.ValueKind != JsonValueKind.True)
                { error = "Inline state requires " + name + "=true."; return false; }
            if (body.TryGetProperty("onlyOpenPhysicalConnectors", out var open) && open.ValueKind != JsonValueKind.False)
            { error = "Inline state requires all physical connections."; return false; }
            return true;
        }
    }
}

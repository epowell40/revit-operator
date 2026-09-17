using System;
using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Shared admission for one synchronous parameter and connector inspection.</summary>
    public static class DuctVerificationInspectionPolicy
    {
        public static bool TryValidate(JsonElement body, out string error)
        {
            error = "";
            if (body.ValueKind != JsonValueKind.Object) { error = "get-connectors body must be an object."; return false; }
            if (!body.TryGetProperty("includeVerificationParameters", out var enabled)) return true;
            if (enabled.ValueKind != JsonValueKind.True && enabled.ValueKind != JsonValueKind.False)
            { error = "includeVerificationParameters must be a boolean."; return false; }
            if (enabled.ValueKind == JsonValueKind.False) return true;
            if (!body.TryGetProperty("elementIds", out var targets) || targets.ValueKind != JsonValueKind.Array
                || targets.GetArrayLength() < 1 || targets.GetArrayLength() > 500)
            { error = "Combined duct verification requires 1 through 500 unique positive element IDs."; return false; }
            var seen = new HashSet<long>();
            foreach (var value in targets.EnumerateArray())
                if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var id) || id <= 0 || !seen.Add(id))
                { error = "Combined duct verification requires 1 through 500 unique positive element IDs."; return false; }
            foreach (var field in new[] { "includeAllRefs", "includeCoordinateSystem" })
                if (body.TryGetProperty(field, out var flag) && flag.ValueKind != JsonValueKind.True)
                { error = "Combined duct verification requires " + field + "=true."; return false; }
            if (body.TryGetProperty("onlyOpenPhysicalConnectors", out var onlyOpen) && onlyOpen.ValueKind != JsonValueKind.False)
            { error = "Combined duct verification requires all physical connectors, not only open ends."; return false; }
            return true;
        }
    }
}

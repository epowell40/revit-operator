using System;
using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Common
{
    // This selector annotates a complete sheet read; it never filters its inventory.
    public static class SheetPlacementReadContract
    {
        // Preserve the native anchor's third coordinate. GetBoxCenter may
        // carry a nonzero Z even though the placement is displayed in sheet UV.
        public static object AnchorCoordinates(double u, double v, double z) => new { u, v, z };

        public static object SelectorSchema() => new Dictionary<string, object>
        {
            ["type"] = "array",
            ["items"] = new Dictionary<string, object> { ["type"] = "integer", ["minimum"] = 1L },
            ["minItems"] = 1L, ["maxItems"] = 256L, ["uniqueItems"] = true,
            ["description"] = "Detail mode only. Identify placements for readback; the result still includes the complete sheet placement inventory."
        };

        public static bool Validate(JsonElement body, string action, out string error)
        {
            error = "";
            if (!body.TryGetProperty("placementIds", out var ids)) return true;
            if (!string.Equals(action, "detail", StringComparison.Ordinal) || ids.ValueKind != JsonValueKind.Array ||
                ids.GetArrayLength() < 1 || ids.GetArrayLength() > 256)
            {
                error = "sheets.placementIds requires detail mode and 1-256 distinct positive element IDs.";
                return false;
            }
            var seen = new HashSet<long>();
            foreach (var id in ids.EnumerateArray())
            {
                if (id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var value) || value <= 0 || !seen.Add(value))
                {
                    error = "sheets.placementIds requires detail mode and 1-256 distinct positive element IDs.";
                    return false;
                }
            }
            return true;
        }
    }
}

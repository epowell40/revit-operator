using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    // Creation and existing-tag repair consume different fields. Reject an
    // ignored request before resolving a document or entering a native stage.
    public static class TagElementModeContract
    {
        private static readonly string[] RepairFields = { "tagHeadPositionXyz", "leaderEndXyz", "leaderElbowXyz", "hasLeader", "leaderEndCondition" };
        private static readonly string[] CommonFields = { "viewId", "viewName", "dryRun" };

        public static bool Validate(JsonElement body, out string error)
        {
            error = "";
            if (body.ValueKind != JsonValueKind.Object) { error = "tag-elements body must be an object."; return false; }
            var repair = body.TryGetProperty("repairExistingTagId", out var id) && id.ValueKind != JsonValueKind.Null;
            if (repair && (id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var n) || n <= 0))
            { error = "tag-elements.repairExistingTagId must be a positive element ID."; return false; }
            foreach (var field in body.EnumerateObject())
            {
                if (field.Value.ValueKind == JsonValueKind.Null) continue;
                if (!repair && RepairFields.Contains(field.Name))
                {
                    error = $"tag-elements.{field.Name} requires repairExistingTagId. Creation uses addLeader and placementMode/offsetX/offsetY; repair an existing tag for exact head or leader coordinates.";
                    return false;
                }
                if (repair && field.Name != "repairExistingTagId" && !RepairFields.Contains(field.Name) && !CommonFields.Contains(field.Name))
                {
                    error = $"tag-elements.{field.Name} is a creation field and cannot be combined with repairExistingTagId. Use hasLeader for existing-tag leader repair.";
                    return false;
                }
            }
            return true;
        }

        public static void ApplySchema(Dictionary<string, object> schema)
        {
            var properties = (Dictionary<string, object>)schema["properties"];
            // Reflection cannot recover nullable reference fields in net48.
            // Selectors and field exclusivity belong to the two mode branches.
            schema["required"] = Array.Empty<string>();
            var create = new Dictionary<string, object>();
            var repair = new Dictionary<string, object>();
            foreach (var name in properties.Keys)
            {
                if (RepairFields.Contains(name) || name == "repairExistingTagId") create[name] = NullOnly();
                if (!RepairFields.Contains(name) && !CommonFields.Contains(name) && name != "repairExistingTagId") repair[name] = NullOnly();
            }
            repair["repairExistingTagId"] = new Dictionary<string, object> { ["type"] = "integer", ["minimum"] = 1L };
            schema["oneOf"] = new object[] {
                new Dictionary<string, object> { ["properties"] = create, ["anyOf"] = new object[] { Selector("elementIds"), Selector("categoryNames") } },
                new Dictionary<string, object> { ["properties"] = repair, ["required"] = new[] { "repairExistingTagId" } }
            };
        }

        private static object NullOnly() => new Dictionary<string, object> { ["type"] = "null" };
        private static object Selector(string name) => new Dictionary<string, object> {
            ["required"] = new[] { name }, ["properties"] = new Dictionary<string, object> {
                [name] = new Dictionary<string, object> { ["type"] = "array", ["minItems"] = 1L }
            }
        };
    }
}

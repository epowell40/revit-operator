using System;
using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Common
{
    // Keep mode-dependent contracts executable by native publication and MCP tests.
    public static class OperatorConditionalRequestContracts
    {
        private static readonly JsonElement Contracts = Load("conditional-requests.v1.json");
        private static readonly JsonElement Fragments = Load("conditional-request-fragments.v1.json");

        private static JsonElement Load(string name)
        {
            using var stream = typeof(OperatorConditionalRequestContracts).Assembly.GetManifestResourceStream("RevitBridge.Common." + name)
                ?? throw new InvalidOperationException("Conditional request contracts are unavailable.");
            using var document = JsonDocument.Parse(stream);
            return document.RootElement.Clone();
        }

        // Compose fragments with the reflected outer contract so unrelated fields stay closed.
        public static void ApplyMepFragments(string path, Dictionary<string, object> schema)
        {
            if (path == "/revit/create-duct" || path == "/revit/create-pipe")
                schema["allOf"] = new[] { Fragment("mep_curve_endpoints") };
            else if (path == "/revit/get-connectors")
                schema["allOf"] = new[] { Fragment("inline_accessory_inspection") };
            else if (path == "/revit/repair-mep-connectors")
                ((Dictionary<string, object>)schema["properties"])["repair"] = Fragment("mep_repair_operation");
            else throw new ArgumentException("No MEP fragments for path.", nameof(path));
        }

        public static JsonElement Fragment(string name)
        {
            if (!Fragments.TryGetProperty(name, out var value))
                throw new InvalidOperationException("Unknown conditional request fragment: " + name);
            return value.Clone();
        }

        public static void ApplyScheduleFragments(Dictionary<string, object> schema)
        {
            var properties = (Dictionary<string, object>)schema["properties"];
            // Publish canonical spellings without rejecting the native handler's
            // existing case, space and hyphen normalization.
            if (properties.TryGetValue("filters", out var filtersSchema)
                && filtersSchema is Dictionary<string, object> nullableFilters
                && nullableFilters.TryGetValue("oneOf", out var alternatives)
                && alternatives is object[] { Length: 2 } variants
                && variants[1] is Dictionary<string, object> filters
                && filters.TryGetValue("items", out var itemsSchema)
                && itemsSchema is Dictionary<string, object> items
                && items.TryGetValue("properties", out var itemProperties)
                && itemProperties is Dictionary<string, object> filterProperties
                && filterProperties.TryGetValue("op", out var opSchema)
                && opSchema is Dictionary<string, object> op)
            {
                op["description"] = "Use equals, not_equals, contains, not_contains, begins_with, ends_with, has_value, has_no_value. "
                    + "Omit for equals. has_value and has_no_value take no value. Operator availability depends on the schedule field and Revit version.";
            }
            var legacy = new Dictionary<string, object>(properties);
            legacy.Remove("combinedField");
            var combined = Fragment("schedule_combined_field");
            properties["combinedField"] = combined.GetProperty("properties").GetProperty("combinedField").Clone();
            schema["oneOf"] = new object[] {
                new Dictionary<string, object> { ["type"] = "object", ["properties"] = legacy, ["additionalProperties"] = false },
                combined
            };
        }

        public static bool TryGet(string path, out JsonElement schema)
        {
            if (Contracts.TryGetProperty(path, out var value))
            {
                schema = value.Clone();
                return true;
            }
            schema = default;
            return false;
        }
    }
}

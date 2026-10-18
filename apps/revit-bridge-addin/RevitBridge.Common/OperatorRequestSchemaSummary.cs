using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Informational field summary. The complete request schema remains authoritative.</summary>
    public static class OperatorRequestSchemaSummary
    {
        public sealed class Fields
        {
            internal readonly HashSet<string> All = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            internal readonly HashSet<string> Required = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public string[] RequiredFields => Required.OrderBy(x => x, StringComparer.Ordinal).ToArray();
            public string[] OptionalFields => All.Except(Required, StringComparer.OrdinalIgnoreCase).OrderBy(x => x, StringComparer.Ordinal).ToArray();
        }

        public static Fields Summarize(JsonElement schema)
        {
            int remaining = 1024;
            return Visit(schema, 0, ref remaining);
        }

        private static Fields Visit(JsonElement schema, int depth, ref int remaining)
        {
            if (--remaining < 0 || depth > 16) throw new ArgumentException("Field-summary schema exceeds bounded traversal.");
            var result = new Fields();
            if (schema.ValueKind != JsonValueKind.Object) return result;
            if (schema.TryGetProperty("properties", out var properties) && properties.ValueKind == JsonValueKind.Object)
                foreach (var property in properties.EnumerateObject()) result.All.Add(property.Name);
            if (schema.TryGetProperty("required", out var required) && required.ValueKind == JsonValueKind.Array)
                foreach (var field in required.EnumerateArray())
                    if (field.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(field.GetString()))
                        result.Required.Add(field.GetString()!);
            if (schema.TryGetProperty("allOf", out var conjunction) && conjunction.ValueKind == JsonValueKind.Array)
                foreach (var child in conjunction.EnumerateArray())
                {
                    var fields = Visit(child, depth + 1, ref remaining);
                    result.All.UnionWith(fields.All); result.Required.UnionWith(fields.Required);
                }
            foreach (var keyword in new[] { "oneOf", "anyOf" })
                if (schema.TryGetProperty(keyword, out var alternatives) && alternatives.ValueKind == JsonValueKind.Array)
                {
                    HashSet<string>? shared = null;
                    foreach (var child in alternatives.EnumerateArray())
                    {
                        if (child.ValueKind == JsonValueKind.False) continue;
                        var fields = Visit(child, depth + 1, ref remaining);
                        result.All.UnionWith(fields.All);
                        if (shared == null) shared = new HashSet<string>(fields.Required, StringComparer.OrdinalIgnoreCase);
                        else shared.IntersectWith(fields.Required);
                    }
                    if (shared != null) result.Required.UnionWith(shared);
                }
            result.All.UnionWith(result.Required);
            return result;
        }
    }
}

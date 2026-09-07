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

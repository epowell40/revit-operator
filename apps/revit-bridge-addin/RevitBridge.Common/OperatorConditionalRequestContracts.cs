using System;
using System.Text.Json;

namespace RevitBridge.Common
{
    // Keep mode-dependent contracts executable by native publication and MCP tests.
    public static class OperatorConditionalRequestContracts
    {
        private static readonly JsonElement Contracts = Load();

        private static JsonElement Load()
        {
            using var stream = typeof(OperatorConditionalRequestContracts).Assembly.GetManifestResourceStream("RevitBridge.Common.conditional-requests.v1.json")
                ?? throw new InvalidOperationException("Conditional request contracts are unavailable.");
            using var document = JsonDocument.Parse(stream);
            return document.RootElement.Clone();
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

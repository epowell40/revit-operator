using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class NativeInteractiveAccessoryRequest
    {
        public sealed class HostIdentity
        {
            public long elementId { get; set; }
            public string uniqueId { get; set; } = "";
        }
        public string expectedModelPath { get; set; } = "";
        public long viewId { get; set; }
        public string expectedViewUniqueId { get; set; } = "";
        public long accessoryTypeId { get; set; }
        public string expectedAccessoryTypeUniqueId { get; set; } = "";
        public int maximumPlacements { get; set; }
        public List<HostIdentity> targetHosts { get; set; } = new List<HostIdentity>();

        public static object RequestSchema() => new Dictionary<string, object>
        {
            ["type"] = "object", ["additionalProperties"] = false,
            ["required"] = new[] { "expectedModelPath", "viewId", "expectedViewUniqueId", "accessoryTypeId", "expectedAccessoryTypeUniqueId", "maximumPlacements", "targetHosts" },
            ["properties"] = new Dictionary<string, object>
            {
                ["expectedModelPath"] = new { type = "string", minLength = 1, maxLength = 1024 },
                ["viewId"] = new { type = "integer", minimum = 1, maximum = 9007199254740991L },
                ["expectedViewUniqueId"] = new { type = "string", minLength = 1, maxLength = 256 },
                ["accessoryTypeId"] = new { type = "integer", minimum = 1, maximum = 9007199254740991L },
                ["expectedAccessoryTypeUniqueId"] = new { type = "string", minLength = 1, maxLength = 256 },
                ["maximumPlacements"] = new { type = "integer", minimum = 1, maximum = 50 },
                ["targetHosts"] = new { type = "array", minItems = 1, maxItems = 50, items = new {
                    type = "object", additionalProperties = false, required = new[] { "elementId", "uniqueId" },
                    properties = new { elementId = new { type = "integer", minimum = 1, maximum = 9007199254740991L },
                        uniqueId = new { type = "string", minLength = 1, maxLength = 256 } } } }
            }
        };

        public static bool TryValidate(JsonElement body, out string? error)
        {
            try { Parse(body.GetRawText()); error = null; return true; }
            catch (Exception ex) when (ex is ArgumentException || ex is JsonException)
            { error = ex.Message; return false; }
        }

        public static NativeInteractiveAccessoryRequest Parse(string json)
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var fields = new HashSet<string>(new[] { "expectedModelPath", "viewId", "expectedViewUniqueId",
                "accessoryTypeId", "expectedAccessoryTypeUniqueId", "maximumPlacements", "targetHosts" }, StringComparer.Ordinal);
            if (root.ValueKind != JsonValueKind.Object) throw new ArgumentException("Expected an interactive accessory request object.");
            var actual = root.EnumerateObject().Select(p => p.Name).ToArray();
            if (actual.Length != fields.Count || actual.Distinct(StringComparer.Ordinal).Count() != actual.Length
                || actual.Any(name => !fields.Contains(name)))
                throw new ArgumentException("Exact interactive placement fields are required; preview and arbitrary placement arguments are unsupported.");
            var request = JsonSerializer.Deserialize<NativeInteractiveAccessoryRequest>(json)!;
            bool Text(string value, int maximum) => !string.IsNullOrWhiteSpace(value)
                && value.Length <= maximum && !value.Any(char.IsControl);
            bool Id(long value) => value > 0 && value <= 9007199254740991;
            if (!Text(request.expectedModelPath, 1024) || !Text(request.expectedViewUniqueId, 256)
                || !Text(request.expectedAccessoryTypeUniqueId, 256) || !Id(request.viewId) || !Id(request.accessoryTypeId)
                || request.viewId == request.accessoryTypeId || request.maximumPlacements < 1 || request.maximumPlacements > 50
                || request.targetHosts == null || request.targetHosts.Count < 1 || request.targetHosts.Count > 50
                || request.targetHosts.Any(h => h == null || !Id(h.elementId) || !Text(h.uniqueId, 256)
                    || h.elementId == request.viewId || h.elementId == request.accessoryTypeId)
                || request.targetHosts.Select(h => h.elementId).Distinct().Count() != request.targetHosts.Count
                || request.targetHosts.Select(h => h.uniqueId).Distinct(StringComparer.Ordinal).Count() != request.targetHosts.Count)
                throw new ArgumentException("Current model/view/type identity and an explicit placement bound of 1-50 are required.");
            foreach (var host in root.GetProperty("targetHosts").EnumerateArray())
            {
                var names = host.EnumerateObject().Select(p => p.Name).ToArray();
                if (names.Length != 2 || !names.Contains("elementId") || !names.Contains("uniqueId"))
                    throw new ArgumentException("Each target host requires exactly its current native elementId and uniqueId.");
            }
            return request;
        }
    }
}

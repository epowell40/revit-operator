using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Explicit existing-duct inline insertion contract.
    /// Instance radius is derived from the guarded native host, never a guessed request value.</summary>
    public sealed class InlineAccessoryRequest
    {
        public string connectionMode { get; set; } = "insert_inline_accessory";
        public string kind { get; set; } = "duct";
        public string expectedModelPath { get; set; } = "";
        public long mainElementId { get; set; }
        public string expectedMainUniqueId { get; set; } = "";
        public double[] expectedMainStartXyz { get; set; } = Array.Empty<double>();
        public double[] expectedMainEndXyz { get; set; } = Array.Empty<double>();
        public long accessoryTypeId { get; set; }
        public string expectedAccessoryTypeUniqueId { get; set; } = "";
        public double[] insertionPointXyz { get; set; } = Array.Empty<double>();
        public string instanceRadiusParameter { get; set; } = "";
        public bool dryRun { get; set; } = true;

        public static InlineAccessoryRequest Parse(string json)
        {
            using var document = JsonDocument.Parse(json);
            var body = document.RootElement;
            var allowed = new HashSet<string>(new[] { "connectionMode", "kind", "expectedModelPath", "mainElementId", "expectedMainUniqueId",
                "expectedMainStartXyz", "expectedMainEndXyz", "accessoryTypeId", "expectedAccessoryTypeUniqueId",
                "insertionPointXyz", "instanceRadiusParameter", "dryRun" }, StringComparer.Ordinal);
            if (body.ValueKind != JsonValueKind.Object) throw new ArgumentException("Inline accessory request must be an object.");
            var names = body.EnumerateObject().Select(p => p.Name).ToArray();
            if (names.Distinct(StringComparer.Ordinal).Count() != names.Length || names.Any(n => !allowed.Contains(n)))
                throw new ArgumentException("Unknown or duplicate inline accessory request field.");
            foreach (var name in allowed.Where(n => n != "dryRun"))
                if (!body.TryGetProperty(name, out _)) throw new ArgumentException("Missing inline accessory field: " + name);
            var request = JsonSerializer.Deserialize<InlineAccessoryRequest>(json) ?? throw new ArgumentException("Missing request.");
            if (request.connectionMode != "insert_inline_accessory" || request.kind != "duct"
                || request.mainElementId <= 0 || request.accessoryTypeId <= 0 || request.mainElementId == request.accessoryTypeId
                || !Text(request.expectedModelPath, 1024) || !Text(request.expectedMainUniqueId, 256)
                || !Text(request.expectedAccessoryTypeUniqueId, 256) || !Text(request.instanceRadiusParameter, 256)
                || !Point(request.expectedMainStartXyz) || !Point(request.expectedMainEndXyz) || !Point(request.insertionPointXyz))
                throw new ArgumentException("Exact native identities, finite coordinates and a named instance radius parameter are required.");
            return request;
        }
        public static bool IsMode(JsonElement body) => body.ValueKind == JsonValueKind.Object
            && body.TryGetProperty("connectionMode", out var mode) && mode.ValueKind == JsonValueKind.String
            && mode.GetString() == "insert_inline_accessory";
        public static bool TryValidate(JsonElement body, out string error)
        {
            try { Parse(body.GetRawText()); error = ""; return true; }
            catch (Exception e) when (e is ArgumentException || e is JsonException)
            { error = "Invalid inline accessory request: " + e.Message; return false; }
        }
        public static Dictionary<string, object> RequestSchema()
        {
            object TextSchema(int max) => new Dictionary<string, object> { ["type"] = "string", ["minLength"] = 1, ["maxLength"] = max };
            object IdSchema() => new Dictionary<string, object> { ["type"] = "integer", ["minimum"] = 1 };
            object XyzSchema() => new Dictionary<string, object> { ["type"] = "array", ["minItems"] = 3, ["maxItems"] = 3,
                ["items"] = new Dictionary<string, object> { ["type"] = "number" } };
            var properties = new Dictionary<string, object> {
                ["connectionMode"] = new { type = "string", @enum = new[] { "insert_inline_accessory" } },
                ["kind"] = new { type = "string", @enum = new[] { "duct" } },
                ["expectedModelPath"] = TextSchema(1024), ["mainElementId"] = IdSchema(), ["expectedMainUniqueId"] = TextSchema(256),
                ["expectedMainStartXyz"] = XyzSchema(), ["expectedMainEndXyz"] = XyzSchema(), ["accessoryTypeId"] = IdSchema(),
                ["expectedAccessoryTypeUniqueId"] = TextSchema(256), ["insertionPointXyz"] = XyzSchema(),
                ["instanceRadiusParameter"] = TextSchema(256), ["dryRun"] = new { type = "boolean" } };
            return new Dictionary<string, object> { ["type"] = "object", ["properties"] = properties,
                ["required"] = properties.Keys.Where(k => k != "dryRun").ToArray(), ["additionalProperties"] = false };
        }
        private static bool Text(string value, int maximum) => !string.IsNullOrWhiteSpace(value) && value.Length <= maximum && value.IndexOf('\0') < 0;
        private static bool Point(double[] values) => values != null && values.Length == 3 && values.All(n => !double.IsNaN(n) && !double.IsInfinity(n));
    }
}

using System;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class DrawingSpecInspectionRequest
    {
        public string sourcePath { get; set; } = "";
        public long manifestElementId { get; set; }
        public int? pageOffset { get; set; }
        public int? pageSize { get; set; }
        public string? expectedSnapshotSha256 { get; set; }

        public static DrawingSpecInspectionRequest Parse(string json)
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new ArgumentException("Inspection requires an object body.");
            var allowed = new[] { "sourcePath", "manifestElementId", "pageOffset", "pageSize", "expectedSnapshotSha256" };
            var names = root.EnumerateObject().Select(p => p.Name).ToArray();
            if (names.Distinct().Count() != names.Length || names.Any(n => !allowed.Contains(n))) throw new ArgumentException("Unknown or duplicate inspection fields.");
            if (!root.TryGetProperty("sourcePath", out var path) || path.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(path.GetString()) || path.GetString()!.Length > 520 ||
                !root.TryGetProperty("manifestElementId", out var id) || id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var number) || number <= 0 || number > 9007199254740991)
                throw new ArgumentException("sourcePath and a positive exact manifestElementId are required.");
            foreach (var field in new[] { "pageOffset", "pageSize" })
                if (root.TryGetProperty(field, out var value) && (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var n) || n < (field == "pageSize" ? 1 : 0) || n > (field == "pageSize" ? 100 : 20000)))
                    throw new ArgumentException("Invalid bounded inspection page.");
            if (root.TryGetProperty("expectedSnapshotSha256", out var hash) && (hash.ValueKind != JsonValueKind.String || hash.GetString()!.Length != 64 ||
                hash.GetString()!.Any(c => !"0123456789abcdef".Contains(c)))) throw new ArgumentException("Expected snapshot must be a lowercase SHA256 digest.");
            return JsonSerializer.Deserialize<DrawingSpecInspectionRequest>(json) ?? throw new ArgumentException("Inspection body is required.");
        }
    }
}

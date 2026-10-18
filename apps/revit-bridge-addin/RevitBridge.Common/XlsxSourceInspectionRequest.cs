using System;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class XlsxSourceInspectionRequest
    {
        public string sourcePath { get; set; } = "";
        public string? sheetName { get; set; }
        public string? section { get; set; }
        public int? pageOffset { get; set; }
        public int? pageSize { get; set; }
        public string? expectedSourceSha256 { get; set; }
        public static readonly string[] Sections = { "summary", "worksheets", "cells", "rows", "columns", "merges", "issues", "formatting", "printContext" };

        public static XlsxSourceInspectionRequest Parse(string json)
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new ArgumentException("XLSX inspection requires an object body.");
            var allowed = new[] { "sourcePath", "sheetName", "section", "pageOffset", "pageSize", "expectedSourceSha256" };
            var names = root.EnumerateObject().Select(p => p.Name).ToArray();
            if (names.Distinct().Count() != names.Length || names.Any(n => !allowed.Contains(n))) throw new ArgumentException("Unknown or duplicate XLSX inspection fields.");
            if (!root.TryGetProperty("sourcePath", out var path) || path.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(path.GetString()) || path.GetString()!.Length > 520)
                throw new ArgumentException("A bounded sourcePath is required.");
            if (root.TryGetProperty("sheetName", out var sheet) && (sheet.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(sheet.GetString()) || sheet.GetString()!.Length > 128))
                throw new ArgumentException("sheetName must be an explicit nonempty worksheet name.");
            if (root.TryGetProperty("section", out var section) && (section.ValueKind != JsonValueKind.String || !Sections.Contains(section.GetString())))
                throw new ArgumentException("Unknown XLSX inspection section.");
            foreach (var field in new[] { "pageOffset", "pageSize" })
                if (root.TryGetProperty(field, out var value) && (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var n) || n < (field == "pageSize" ? 1 : 0) || n > (field == "pageSize" ? 100 : 1000000)))
                    throw new ArgumentException("Invalid XLSX inspection page.");
            if (root.TryGetProperty("expectedSourceSha256", out var hash) && (hash.ValueKind != JsonValueKind.String || hash.GetString()!.Length != 64 || hash.GetString()!.Any(c => !"0123456789abcdef".Contains(c))))
                throw new ArgumentException("Expected source must be a lowercase SHA256 digest.");
            var request = JsonSerializer.Deserialize<XlsxSourceInspectionRequest>(json)!;
            request.section ??= "summary";
            if ((request.pageOffset ?? 0) > 0 && request.expectedSourceSha256 == null) throw new ArgumentException("Continuation pages require expectedSourceSha256.");
            if (request.sheetName == null && request.section != "summary" && request.section != "worksheets") throw new ArgumentException("Select an exact worksheet before inspecting its content.");
            return request;
        }
    }
}

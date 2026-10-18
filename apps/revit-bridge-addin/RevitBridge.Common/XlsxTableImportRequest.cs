using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class XlsxTableImportRequest
    {
        public string sourcePath { get; set; } = "";
        public string sheetName { get; set; } = "";
        public string expectedSourceSha256 { get; set; } = "";
        public string viewName { get; set; } = "";
        public int partIndex { get; set; }
        public long? manifestElementId { get; set; }
        public string? expectedImportSnapshotSha256 { get; set; }
        public string? textTypeName { get; set; }
        public XlsxTableLayoutOptions? layout { get; set; }
        public Dictionary<string, int>? borderWeights { get; set; }
        public bool dryRun { get; set; }
        public static XlsxTableImportRequest Parse(string json)
        {
            using var doc = JsonDocument.Parse(json);var root = doc.RootElement;
            XlsxTableRequestValidation.Fields(root, new[] { "sourcePath", "sheetName", "expectedSourceSha256", "viewName", "partIndex", "manifestElementId", "expectedImportSnapshotSha256", "textTypeName", "layout", "borderWeights", "dryRun" });
            foreach (var field in new[] { "sourcePath", "sheetName", "viewName" }) XlsxTableRequestValidation.Text(root, field, field == "sourcePath" ? 520 : field == "viewName" ? 110 : 128);
            XlsxTableRequestValidation.Digest(root, "expectedSourceSha256", true);
            XlsxTableRequestValidation.Digest(root, "expectedImportSnapshotSha256", false);
            XlsxTableRequestValidation.Integer(root, "partIndex", 0, 499, false);
            XlsxTableRequestValidation.Integer(root, "manifestElementId", 1, 9007199254740991, false);
            if (root.TryGetProperty("textTypeName", out _)) XlsxTableRequestValidation.Text(root, "textTypeName", 140);
            if (root.TryGetProperty("dryRun", out var dry) && dry.ValueKind != JsonValueKind.True && dry.ValueKind != JsonValueKind.False) throw new ArgumentException("dryRun must be boolean.");
            if (root.TryGetProperty("layout", out var layout))
            {
                XlsxTableRequestValidation.Fields(layout, new[] { "range", "pageWidthInches", "pageHeightInches", "paddingPoints", "minimumTextPoints", "repeatHeaderRows", "wrapOverflow" });
                foreach (var field in new[] { "pageWidthInches", "pageHeightInches", "paddingPoints", "minimumTextPoints" })
                    if (layout.TryGetProperty(field, out var number) && (!number.TryGetDouble(out var n) || !XlsxTableAxes.Finite(n) || n < (field == "paddingPoints" ? 0 : 1) || n > (field == "paddingPoints" ? 36 : field == "minimumTextPoints" ? 72 : 96))) throw new ArgumentException("Invalid table paper geometry.");
                XlsxTableRequestValidation.Integer(layout, "repeatHeaderRows", 0, 20, false);
                if (layout.TryGetProperty("wrapOverflow", out var wrap) && wrap.ValueKind != JsonValueKind.True && wrap.ValueKind != JsonValueKind.False) throw new ArgumentException("wrapOverflow must be boolean.");
                if (layout.TryGetProperty("range", out var range))
                {
                    XlsxTableRequestValidation.Fields(range, new[] { "firstRow", "lastRow", "firstColumn", "lastColumn" });
                    foreach (var field in new[] { "firstRow", "lastRow", "firstColumn", "lastColumn" }) XlsxTableRequestValidation.Integer(range, field, 1, field.EndsWith("Row", StringComparison.Ordinal) ? 1048576 : 16384, true);
                    XlsxTableAxes.Validate(JsonSerializer.Deserialize<XlsxSourceRange>(range.GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!);
                }
            }
            if (root.TryGetProperty("borderWeights", out var weights))
            {
                XlsxTableRequestValidation.Fields(weights, new[] { "hair", "thin", "medium", "thick" });
                foreach (var weight in weights.EnumerateObject()) XlsxTableRequestValidation.Integer(weights, weight.Name, 1, 16, true);
            }
            var result = JsonSerializer.Deserialize<XlsxTableImportRequest>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
            if (result.partIndex > 0 && !result.manifestElementId.HasValue || result.manifestElementId.HasValue && result.expectedImportSnapshotSha256 == null || !result.manifestElementId.HasValue && result.expectedImportSnapshotSha256 != null)
                throw new ArgumentException("Continuation requires exact manifestElementId and fresh expectedImportSnapshotSha256.");
            return result;
        }
    }
    public sealed class XlsxTableInspectionRequest
    {
        public string? action { get; set; }
        public string? sourcePath { get; set; }
        public long? manifestElementId { get; set; }
        public int? partIndex { get; set; }
        public string? section { get; set; }
        public int? pageOffset { get; set; }
        public int? pageSize { get; set; }
        public string? expectedInspectionSnapshotSha256 { get; set; }
        public static XlsxTableInspectionRequest Parse(string json)
        {
            using var doc = JsonDocument.Parse(json);var root = doc.RootElement;
            XlsxTableRequestValidation.Fields(root, new[] { "action", "sourcePath", "manifestElementId", "partIndex", "section", "pageOffset", "pageSize", "expectedInspectionSnapshotSha256" });
            if (root.TryGetProperty("action", out var action) && (action.ValueKind != JsonValueKind.String || !new[] { "list", "inspect" }.Contains(action.GetString()))) throw new ArgumentException("Unknown Excel import inspection action.");
            bool list = action.ValueKind == JsonValueKind.String && action.GetString() == "list";
            if (!list)
            { XlsxTableRequestValidation.Text(root, "sourcePath", 520);XlsxTableRequestValidation.Integer(root, "manifestElementId", 1, 9007199254740991, true); }
            else if (root.EnumerateObject().Any(p => !new[] { "action", "pageOffset", "pageSize" }.Contains(p.Name))) throw new ArgumentException("List cannot select a source or part.");
            XlsxTableRequestValidation.Integer(root, "partIndex", 0, 499, false);
            XlsxTableRequestValidation.Integer(root, "pageOffset", 0, 1000000, false);XlsxTableRequestValidation.Integer(root, "pageSize", 1, 100, false);
            XlsxTableRequestValidation.Digest(root, "expectedInspectionSnapshotSha256", false);
            if (root.TryGetProperty("section", out var section) && (section.ValueKind != JsonValueKind.String || !new[] { "summary", "notes", "borders", "cells", "issues" }.Contains(section.GetString()))) throw new ArgumentException("Unknown Excel import section.");
            var result = JsonSerializer.Deserialize<XlsxTableInspectionRequest>(json)!;
            if (!list && (result.pageOffset ?? 0) > 0 && result.expectedInspectionSnapshotSha256 == null) throw new ArgumentException("Paged inspection requires a fresh snapshot digest.");
            if (!result.partIndex.HasValue && result.section != null && result.section != "summary") throw new ArgumentException("Select a part before reading its detail records.");
            return result;
        }
    }
    internal static class XlsxTableRequestValidation
    {
        internal static void Fields(JsonElement value, string[] allowed)
        {
            if (value.ValueKind != JsonValueKind.Object) throw new ArgumentException("Excel table request must contain objects.");
            var names = value.EnumerateObject().Select(p => p.Name).ToArray();
            if (names.Distinct().Count() != names.Length || names.Any(n => !allowed.Contains(n))) throw new ArgumentException("Unknown or duplicate Excel table request fields.");
        }
        internal static void Text(JsonElement root, string name, int maximum)
        { if (!root.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(v.GetString()) || v.GetString()!.Length > maximum) throw new ArgumentException("Missing/invalid " + name); }
        internal static void Digest(JsonElement root, string name, bool required)
        {
            if (!root.TryGetProperty(name, out var v)) { if (required) throw new ArgumentException("Missing " + name);return; }
            if (v.ValueKind != JsonValueKind.String || v.GetString()!.Length != 64 || v.GetString()!.Any(c => !"0123456789abcdef".Contains(c))) throw new ArgumentException("Invalid SHA256: " + name);
        }
        internal static void Integer(JsonElement root, string name, long minimum, long maximum, bool required)
        {
            if (!root.TryGetProperty(name, out var v)) { if (required) throw new ArgumentException("Missing " + name);return; }
            if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt64(out var n) || n < minimum || n > maximum) throw new ArgumentException("Invalid integer: " + name);
        }
    }
}

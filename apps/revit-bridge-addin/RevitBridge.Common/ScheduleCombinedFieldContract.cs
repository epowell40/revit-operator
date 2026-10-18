using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class ScheduleCombinedFieldSpec
    {
        public string? name { get; set; }
        public List<int>? sourceFieldIds { get; set; }
        public int? index { get; set; }
        public string? separator { get; set; }
        public bool? hideSourceFields { get; set; }
        public double? widthFeet { get; set; }
    }

    public static class ScheduleCombinedFieldContract
    {
        public static bool ValidateEdit(JsonElement body, out string error)
        {
            error = "";
            if (body.ValueKind != JsonValueKind.Object || body.EnumerateObject().Any(p => !new[] { "scheduleId", "combinedField", "dryRun" }.Contains(p.Name))
                || !body.TryGetProperty("scheduleId", out var id) || id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var number) || number <= 0
                || !body.TryGetProperty("combinedField", out var field) || field.ValueKind != JsonValueKind.Object)
            { error = "Combined field requires one positive scheduleId and one combinedField, without other edits."; return false; }
            if (body.TryGetProperty("dryRun", out var dry) && dry.ValueKind != JsonValueKind.True && dry.ValueKind != JsonValueKind.False)
            { error = "dryRun must be Boolean."; return false; }
            if (field.EnumerateObject().Any(p => !new[] { "name", "sourceFieldIds", "index", "separator", "hideSourceFields", "widthFeet" }.Contains(p.Name))
                || !field.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(name.GetString()) || name.GetString()!.Length > 128
                || !field.TryGetProperty("sourceFieldIds", out var parts) || parts.ValueKind != JsonValueKind.Array || parts.GetArrayLength() < 2 || parts.GetArrayLength() > 8)
            { error = "combinedField needs a name of 1..128 characters and 2..8 existing sourceFieldIds."; return false; }
            var seen = new HashSet<int>();
            foreach (var part in parts.EnumerateArray())
                if (part.ValueKind != JsonValueKind.Number || !part.TryGetInt32(out var value) || value < 0 || !seen.Add(value))
                { error = "sourceFieldIds must be distinct nonnegative native schedule-field IDs, not model ElementIds."; return false; }
            if (field.TryGetProperty("index", out var index) && (index.ValueKind != JsonValueKind.Number || !index.TryGetInt32(out var i) || i < 0 || i > 200))
            { error = "index must be an integer 0..200 in the complete native field order."; return false; }
            if (field.TryGetProperty("separator", out var separator) && (separator.ValueKind != JsonValueKind.String || separator.GetString()!.Length > 32))
            { error = "separator must be text up to 32 characters."; return false; }
            if (field.TryGetProperty("hideSourceFields", out var hidden) && hidden.ValueKind != JsonValueKind.True && hidden.ValueKind != JsonValueKind.False)
            { error = "hideSourceFields must be Boolean."; return false; }
            if (field.TryGetProperty("widthFeet", out var width) && (width.ValueKind != JsonValueKind.Number || !width.TryGetDouble(out var w) || double.IsNaN(w) || double.IsInfinity(w) || w < 0.01 || w > 5))
            { error = "widthFeet must be finite 0.01..5 feet."; return false; }
            return true;
        }
    }
}

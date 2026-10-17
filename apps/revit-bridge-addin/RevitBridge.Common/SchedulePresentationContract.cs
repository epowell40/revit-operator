using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public class ScheduleTextStyles
    {
        public long? titleTextTypeId { get; set; }
        public long? headerTextTypeId { get; set; }
        public long? bodyTextTypeId { get; set; }
    }

    /// <summary>Non-destructive column ordering and existing text-type selection.</summary>
    public static class SchedulePresentationContract
    {
        public static bool Validate(JsonElement body, out string error)
        {
            error = "";
            if (body.ValueKind != JsonValueKind.Object) { error = "Schedule body must be an object."; return false; }
            if (body.TryGetProperty("fieldOrder", out var order) && order.ValueKind != JsonValueKind.Null)
            {
                if (order.ValueKind != JsonValueKind.Array || order.GetArrayLength() < 1 || order.GetArrayLength() > 200)
                { error = "fieldOrder must contain 1..200 native field IDs, including hidden fields."; return false; }
                var seen = new HashSet<int>();
                foreach (var id in order.EnumerateArray())
                    if (id.ValueKind != JsonValueKind.Number || !id.TryGetInt32(out var n) || n < 0 || !seen.Add(n))
                    { error = "fieldOrder requires distinct nonnegative native field IDs."; return false; }
                foreach (var name in new[] { "addFields", "calculatedFields" })
                    if (body.TryGetProperty(name, out var added) && added.ValueKind == JsonValueKind.Array && added.GetArrayLength() > 0)
                    { error = "Add fields first, read their native IDs, then submit fieldOrder separately."; return false; }
            }
            if (body.TryGetProperty("appearance", out var appearance) && appearance.ValueKind == JsonValueKind.Object)
                foreach (var name in new[] { "titleTextTypeId", "headerTextTypeId", "bodyTextTypeId" })
                    if (appearance.TryGetProperty(name, out var id) && id.ValueKind != JsonValueKind.Null
                        && (id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var n) || n <= 0))
                    { error = name + " must be a positive existing TextNoteType element ID."; return false; }
            if (body.TryGetProperty("columnWidths", out var widths) && widths.ValueKind != JsonValueKind.Null)
            {
                if (widths.ValueKind != JsonValueKind.Array || widths.GetArrayLength() < 1 || widths.GetArrayLength() > 200)
                { error = "columnWidths requires 1..200 uniquely named fields."; return false; }
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var width in widths.EnumerateArray())
                {
                    if (width.ValueKind != JsonValueKind.Object || width.EnumerateObject().Any(p => p.Name != "field" && p.Name != "widthFeet")
                        || !width.TryGetProperty("field", out var field) || field.ValueKind != JsonValueKind.String
                        || string.IsNullOrWhiteSpace(field.GetString()) || field.GetString()!.Length > 256 || !names.Add(field.GetString()!.Trim())
                        || !width.TryGetProperty("widthFeet", out var value) || value.ValueKind != JsonValueKind.Number
                        || !value.TryGetDouble(out var feet) || double.IsNaN(feet) || double.IsInfinity(feet) || feet <= 0 || feet > 100)
                    { error = "columnWidths requires distinct nonblank field names and finite widths >0 and <=100 feet; unknown keys are not allowed."; return false; }
                }
            }
            return true;
        }

        public static bool IsBoundedPresentationEdit(JsonElement body)
        {
            if (ScheduleFieldFormatContract.IsBoundedEdit(body)) return true;
            if (!Validate(body, out _) || !body.TryGetProperty("scheduleId", out var id) || id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var n) || n <= 0) return false;
            if (body.EnumerateObject().Any(p => !new[] { "scheduleId", "fieldOrder", "appearance", "columnWidths", "dryRun" }.Contains(p.Name))) return false;
            var changed = (body.TryGetProperty("fieldOrder", out var order) && order.ValueKind == JsonValueKind.Array)
                || (body.TryGetProperty("columnWidths", out var widths) && widths.ValueKind == JsonValueKind.Array);
            if (body.TryGetProperty("appearance", out var appearance) && appearance.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in appearance.EnumerateObject())
                {
                    if (!new[] { "titleTextTypeId", "headerTextTypeId", "bodyTextTypeId", "showTitle", "showHeaders" }.Contains(property.Name)) return false;
                    if (property.Name.EndsWith("TextTypeId") && property.Value.ValueKind == JsonValueKind.Number) changed = true;
                }
            }
            return changed;
        }

        public static bool ValidateRead(JsonElement body, out string error)
        {
            error = "";
            if (body.ValueKind != JsonValueKind.Object || body.EnumerateObject().Any(p => !new[] { "action", "scheduleId" }.Contains(p.Name))
                || !body.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.String || action.GetString() != "presentation"
                || !body.TryGetProperty("scheduleId", out var id) || id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var n) || n <= 0)
            { error = "Presentation read requires exactly action=presentation and one positive scheduleId."; return false; }
            return true;
        }

        public static void RequireCompleteOrder(IList<int> current, IList<int> requested)
        {
            if (requested.Count < 1 || requested.Count > 200 || requested.Any(id => id < 0)
                || requested.Distinct().Count() != requested.Count || current.Count != requested.Count
                || !new HashSet<int>(current).SetEquals(requested))
                throw new ArgumentException("fieldOrder must be an exact permutation of ALL current native field IDs, including hidden fields; read schedule detail again.");
        }
    }
}

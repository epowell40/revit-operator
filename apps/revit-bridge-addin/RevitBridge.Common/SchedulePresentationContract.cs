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

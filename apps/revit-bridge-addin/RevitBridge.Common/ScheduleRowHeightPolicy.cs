using System;
using System.Text.Json;
using System.Linq;
namespace RevitBridge.Common
{
    public static class ScheduleRowHeightPolicy
    {
        // Bounded explicit rows outside the standard body. Schedule-wide body
        // overrides need a different predicate and are not silently certified here.
        public static bool IsBoundedEdit(JsonElement body)
        {
            if (body.ValueKind != JsonValueKind.Object || body.EnumerateObject().Any(p => !new[] { "scheduleId", "rowHeights", "dryRun" }.Contains(p.Name))
                || !body.TryGetProperty("scheduleId", out var id) || id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var n) || n <= 0
                || !body.TryGetProperty("rowHeights", out var rows) || rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() < 1 || rows.GetArrayLength() > 200) return false;
            var seen = new System.Collections.Generic.HashSet<string>();
            foreach (var row in rows.EnumerateArray())
            {
                if (row.ValueKind != JsonValueKind.Object || row.EnumerateObject().Any(p => !new[] { "section", "rowNumber", "heightFeet" }.Contains(p.Name))
                    || !row.TryGetProperty("section", out var section) || section.ValueKind != JsonValueKind.String
                    || !new[] { "header", "summary", "footer" }.Contains(section.GetString()!.Trim().ToLowerInvariant())
                    || !row.TryGetProperty("rowNumber", out var number) || number.ValueKind != JsonValueKind.Number || !number.TryGetInt32(out var index) || index < 0 || index > 100000
                    || !seen.Add(section.GetString()!.Trim().ToLowerInvariant() + ":" + index)
                    || !row.TryGetProperty("heightFeet", out var value) || value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var height)
                    || double.IsNaN(height) || double.IsInfinity(height) || height <= 0 || height > 10) return false;
            }
            return true;
        }
        // This policy is for regular ViewSchedule, not editable panel-schedule body cells.
        public static bool HasUnsupportedExplicitBodyRow(JsonElement body)
        {
            if (!body.TryGetProperty("rowHeights", out var rows) || rows.ValueKind != JsonValueKind.Array) return false;
            foreach (var row in rows.EnumerateArray())
            {
                if (row.ValueKind != JsonValueKind.Object) continue;
                var section = row.TryGetProperty("section", out var name) && name.ValueKind == JsonValueKind.String ? name.GetString()!.Trim() : "body";
                if ((section.Length == 0 || section.Equals("body", StringComparison.OrdinalIgnoreCase))
                    && row.TryGetProperty("rowNumber", out var number) && number.ValueKind != JsonValueKind.Null) return true;
            }
            return false;
        }
        public static void RequireAppliedRows(JsonElement rows)
        {
            if (rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() == 0) throw new InvalidOperationException("No schedule row-height result was observed.");
            foreach (var row in rows.EnumerateArray())
            {
                if (row.ValueKind == JsonValueKind.Object && row.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.String && status.GetString() == "Applied"
                    && row.TryGetProperty("heightFeet", out var wanted) && wanted.ValueKind == JsonValueKind.Number && wanted.TryGetDouble(out var requested)
                    && row.TryGetProperty("afterHeightFeet", out var actual) && actual.ValueKind == JsonValueKind.Number && actual.TryGetDouble(out var observed)
                    && requested > 0 && requested <= 10 && !double.IsNaN(requested) && !double.IsInfinity(requested) && !double.IsNaN(observed) && !double.IsInfinity(observed)
                    && Math.Abs(requested - observed) <= 1e-8) continue;
                var reason = row.ValueKind == JsonValueKind.Object && row.TryGetProperty("reason", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : "Missing or mismatched native row-height readback.";
                throw new InvalidOperationException("Schedule row-height edit failed; roll back the configure operation. " + reason.Substring(0, Math.Min(512, reason.Length)));
            }
        }
    }
}

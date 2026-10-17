using System;
using System.Text.Json;
namespace RevitBridge.Common
{
    public static class ScheduleRowHeightPolicy
    {
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

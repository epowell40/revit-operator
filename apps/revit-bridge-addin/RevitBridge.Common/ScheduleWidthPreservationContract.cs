using System.Linq;
using System.Text.Json;
namespace RevitBridge.Common
{
    public static class ScheduleWidthPreservationContract
    {
        public static bool IsWidthOnlyEdit(JsonElement body)
        {
            if (!SchedulePresentationContract.IsBoundedPresentationEdit(body)) return false;
            if (body.TryGetProperty("dryRun", out var preview) && preview.ValueKind != JsonValueKind.False) return false;
            var name = body.TryGetProperty("columnWidths", out var widths) ? "columnWidths" : "fieldFormats";
            if (!body.TryGetProperty(name, out widths) || widths.ValueKind != JsonValueKind.Array || widths.GetArrayLength() == 0
                || body.EnumerateObject().Any(p => p.Name != "scheduleId" && p.Name != name && p.Name != "dryRun")) return false;
            return widths.EnumerateArray().All(f => f.ValueKind == JsonValueKind.Object
                && f.TryGetProperty("widthFeet", out var width) && width.ValueKind == JsonValueKind.Number
                && f.EnumerateObject().All(p => p.Name == "field" || p.Name == "widthFeet"));
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
namespace RevitBridge.Common
{
    public static class ScheduleFieldFormatContract
    {
        public static bool IsBoundedEdit(JsonElement body)
        {
            if (body.ValueKind != JsonValueKind.Object || body.EnumerateObject().Any(p => !new[] { "scheduleId", "fieldFormats", "dryRun" }.Contains(p.Name))
                || !body.TryGetProperty("scheduleId", out var id) || id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var n) || n <= 0
                || !body.TryGetProperty("fieldFormats", out var formats) || formats.ValueKind != JsonValueKind.Array || formats.GetArrayLength() < 1 || formats.GetArrayLength() > 200) return false;
            if (body.TryGetProperty("dryRun", out var preview) && preview.ValueKind != JsonValueKind.False) return false;
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var f in formats.EnumerateArray())
            {
                if (f.ValueKind != JsonValueKind.Object || f.EnumerateObject().Count() < 2
                    || f.EnumerateObject().Any(p => !new[] { "field", "heading", "hidden", "widthFeet", "horizontalAlignment", "headingOrientation" }.Contains(p.Name))
                    || !f.TryGetProperty("field", out var name) || name.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(name.GetString())
                    || name.GetString()!.Length > 256 || !names.Add(name.GetString()!.Trim())) return false;
                if (f.TryGetProperty("heading", out var heading) && (heading.ValueKind != JsonValueKind.String || heading.GetString()!.Length > 1024)) return false;
                if (f.TryGetProperty("hidden", out var hidden) && hidden.ValueKind != JsonValueKind.True && hidden.ValueKind != JsonValueKind.False) return false;
                if (f.TryGetProperty("widthFeet", out var width) && (width.ValueKind != JsonValueKind.Number || !width.TryGetDouble(out var feet)
                    || double.IsNaN(feet) || double.IsInfinity(feet) || feet <= 0 || feet > 100)) return false;
                if (!EnumText(f, "horizontalAlignment", new[] { "left", "center", "right" }) || !EnumText(f, "headingOrientation", new[] { "horizontal", "vertical" })) return false;
            }
            return true;
        }
        private static bool EnumText(JsonElement f, string key, string[] allowed)
            => !f.TryGetProperty(key, out var value) || (value.ValueKind == JsonValueKind.String && allowed.Contains(value.GetString()!, StringComparer.OrdinalIgnoreCase));
    }
}

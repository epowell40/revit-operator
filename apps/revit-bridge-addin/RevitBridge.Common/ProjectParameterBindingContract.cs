using System;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class ProjectParameterBindingContract
    {
        public static bool IsReadOnly(JsonElement body)
        {
            if (body.ValueKind != JsonValueKind.Object) return false;
            if (body.TryGetProperty("action", out var explicitAction) && explicitAction.ValueKind != JsonValueKind.String) return false;
            var action = body.TryGetProperty("action", out var a) && a.ValueKind == JsonValueKind.String ? a.GetString() : "list";
            if (action == "detail") return ValidateDetail(body, out _);
            if (action != "list" || body.EnumerateObject().Any(p => !new[] { "action", "query", "max" }.Contains(p.Name))) return false;
            return (!body.TryGetProperty("query", out var q) || q.ValueKind == JsonValueKind.String && q.GetString()!.Length <= 120)
                && (!body.TryGetProperty("max", out var m) || m.ValueKind == JsonValueKind.Number && m.TryGetInt32(out var count) && count >= 1 && count <= 5000);
        }
        public static bool ValidateDetail(JsonElement body, out string error)
        {
            error = "Project-parameter detail requires exactly action:detail and one positive parameterId.";
            return body.ValueKind == JsonValueKind.Object && body.EnumerateObject().All(p => new[] { "action", "parameterId" }.Contains(p.Name))
                && body.TryGetProperty("action", out var action) && action.ValueKind == JsonValueKind.String && action.GetString() == "detail"
                && body.TryGetProperty("parameterId", out var id) && id.ValueKind == JsonValueKind.Number && id.TryGetInt64(out var number) && number > 0 && number <= 9007199254740991L;
        }
        public static bool ValidateCreate(JsonElement body, out string error)
        {
            error = "Project-parameter creation needs one name, resolved categoryNames and no unrelated fields.";
            if (body.ValueKind != JsonValueKind.Object || body.EnumerateObject().Any(p => !new[] {
                "action", "name", "categoryNames", "instanceBinding", "parameterGroup", "dataType", "visible", "userModifiable", "rebindIfExists", "dryRun" }.Contains(p.Name))
                || !body.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.String || action.GetString() != "create"
                || !body.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(name.GetString()) || name.GetString()!.Length > 128
                || !body.TryGetProperty("categoryNames", out var cats) || cats.ValueKind != JsonValueKind.Array || cats.GetArrayLength() < 1 || cats.GetArrayLength() > 200
                || cats.EnumerateArray().Any(c => c.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(c.GetString()) || c.GetString()!.Length > 120)) return false;
            foreach (var key in new[] { "instanceBinding", "visible", "userModifiable", "rebindIfExists", "dryRun" })
                if (body.TryGetProperty(key, out var b) && b.ValueKind != JsonValueKind.True && b.ValueKind != JsonValueKind.False) return false;
            if (body.TryGetProperty("dataType", out var type) && (type.ValueKind != JsonValueKind.String || !new[] { "text", "url", "multiline_text", "multiline", "multilinetext", "yesno", "yes_no", "yes/no", "integer", "number" }.Contains(type.GetString()))) return false;
            if (body.TryGetProperty("parameterGroup", out var group) && (group.ValueKind != JsonValueKind.String || !new[] { "identity_data", "identity", "data", "text", "constraints", "geometry", "materials", "graphics", "phasing" }.Contains(group.GetString()))) return false;
            error = ""; return true;
        }
    }
}

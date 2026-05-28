using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class GetElementParametersHandler : IRequestHandler
    {
        public class Params
        {
            public long? elementId { get; set; }
            public List<long>? elementIds { get; set; }
            public List<string>? names { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = ParseRequest(jsonData);
            var doc = app.ActiveUIDocument.Document;

            if (p.elementIds != null && p.elementIds.Count > 0)
            {
                var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (p.names != null)
                {
                    foreach (var n in p.names)
                    {
                        if (!string.IsNullOrWhiteSpace(n)) wanted.Add(n.Trim());
                    }
                }

                var items = new List<object>();
                foreach (var id in p.elementIds)
                {
                    var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (elem == null)
                    {
                        items.Add(new { id, error = "Element not found" });
                        continue;
                    }

                    var paramsDict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    foreach (Parameter param in elem.Parameters)
                    {
                        if (param.Definition == null) continue;
                        var name = param.Definition.Name ?? "";
                        if (wanted.Count > 0 && !wanted.Contains(name)) continue;

                        string val = "";
                        switch (param.StorageType)
                        {
                            case StorageType.String: val = param.AsString(); break;
                            case StorageType.Integer: val = param.AsInteger().ToString(); break;
                            case StorageType.Double: val = param.AsDouble().ToString(); break;
                            case StorageType.ElementId: val = RevitBridge.Common.ElementIdCompat.GetValue(param.AsElementId()).ToString(); break;
                        }

                        if (!paramsDict.ContainsKey(name))
                            paramsDict.Add(name, val ?? "");
                    }

                    items.Add(new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(elem.Id),
                        name = elem.Name,
                        category = elem.Category?.Name,
                        parameters = paramsDict
                    });
                }

                return Task.FromResult<object>(new { items });
            }

            if (!p.elementId.HasValue) throw new Exception("elementId is required");

            var single = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.elementId.Value));
            if (single == null) throw new Exception("Element not found");

            var singleParams = new Dictionary<string, string>();

            foreach (Parameter param in single.Parameters)
            {
                if (param.Definition == null) continue;

                string val = "";
                switch (param.StorageType)
                {
                    case StorageType.String: val = param.AsString(); break;
                    case StorageType.Integer: val = param.AsInteger().ToString(); break;
                    case StorageType.Double: val = param.AsDouble().ToString(); break;
                    case StorageType.ElementId: val = RevitBridge.Common.ElementIdCompat.GetValue(param.AsElementId()).ToString(); break;
                }

                if (!singleParams.ContainsKey(param.Definition.Name))
                    singleParams.Add(param.Definition.Name, val ?? "");
            }

            return Task.FromResult<object>(new
            {
                id = RevitBridge.Common.ElementIdCompat.GetValue(single.Id),
                name = single.Name,
                category = single.Category?.Name,
                parameters = singleParams
            });
        }

        private static Params ParseRequest(string jsonData)
        {
            if (string.IsNullOrWhiteSpace(jsonData))
            {
                throw new Exception("Invalid request: body is required.");
            }

            using (var doc = JsonDocument.Parse(jsonData))
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Object)
                {
                    throw new Exception("Invalid request: body must be an object.");
                }

                var root = doc.RootElement;
                var parsed = new Params();

                if (root.TryGetProperty("elementId", out var elementIdProp) &&
                    elementIdProp.ValueKind != JsonValueKind.Null)
                {
                    parsed.elementId = ParseLong(elementIdProp, "elementId");
                }

                if (root.TryGetProperty("elementIds", out var elementIdsProp) &&
                    elementIdsProp.ValueKind != JsonValueKind.Null)
                {
                    parsed.elementIds = ParseLongListOrSingle(elementIdsProp, "elementIds");
                }

                if (root.TryGetProperty("names", out var namesProp) &&
                    namesProp.ValueKind != JsonValueKind.Null)
                {
                    if (namesProp.ValueKind != JsonValueKind.Array)
                    {
                        throw new Exception("names must be an array of strings.");
                    }

                    var names = new List<string>();
                    foreach (var entry in namesProp.EnumerateArray())
                    {
                        if (entry.ValueKind != JsonValueKind.String)
                        {
                            throw new Exception("names must be an array of strings.");
                        }

                        var value = entry.GetString();
                        if (!string.IsNullOrWhiteSpace(value))
                        {
                            names.Add(value.Trim());
                        }
                    }

                    parsed.names = names;
                }

                return parsed;
            }
        }

        private static List<long> ParseLongListOrSingle(JsonElement token, string fieldName)
        {
            var values = new List<long>();

            if (token.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in token.EnumerateArray())
                {
                    values.Add(ParseLong(item, fieldName));
                }
                return values;
            }

            values.Add(ParseLong(token, fieldName));
            return values;
        }

        private static long ParseLong(JsonElement token, string fieldName)
        {
            if (token.ValueKind == JsonValueKind.Number && token.TryGetInt64(out var numberValue))
            {
                return numberValue;
            }

            if (token.ValueKind == JsonValueKind.String)
            {
                var textValue = token.GetString();
                if (!string.IsNullOrWhiteSpace(textValue) && long.TryParse(textValue, out var parsed))
                {
                    return parsed;
                }
            }

            throw new Exception($"{fieldName} must be an integer.");
        }
    }
}

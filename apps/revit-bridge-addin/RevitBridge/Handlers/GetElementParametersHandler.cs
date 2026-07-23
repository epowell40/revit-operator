using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.Semantic;

namespace RevitBridge.Handlers
{
    public class GetElementParametersHandler : IRequestHandler
    {
        public class Params
        {
            public long? elementId { get; set; }
            public List<long>? elementIds { get; set; }
            public string? category { get; set; }
            public List<string>? categories { get; set; }
            public List<string>? names { get; set; }
            public bool? includeStringParameters { get; set; }
            public int? offset { get; set; }
            public int? limit { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = ParseRequest(jsonData);
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var requestedCategories = NormalizeCategories(p);
            var hasIdSelector = p.elementId.HasValue || (p.elementIds != null && p.elementIds.Count > 0);
            var hasCategorySelector = requestedCategories.Count > 0;

            if (hasIdSelector && hasCategorySelector)
            {
                throw new InvalidOperationException("get-parameters accepts either elementId/elementIds or category/categories, not both.");
            }

            var wantedNames = NormalizeNames(p.names);
            var stringsOnly = p.includeStringParameters ?? false;

            if (hasCategorySelector)
            {
                return Task.FromResult(ReadCategoryPage(doc, requestedCategories, wantedNames, stringsOnly, p.offset, p.limit));
            }

            if (p.elementIds != null && p.elementIds.Count > 0)
            {
                var items = new List<object>();
                foreach (var id in p.elementIds)
                {
                    var elem = doc.GetElement(ElementIdCompat.Create(id));
                    items.Add(elem == null
                        ? new { id, error = "Element not found" }
                        : BuildElementItem(elem, wantedNames, stringsOnly));
                }

                return Task.FromResult<object>(new { items });
            }

            if (!p.elementId.HasValue)
            {
                throw new InvalidOperationException("get-parameters requires elementId, elementIds, category, or categories.");
            }

            var single = doc.GetElement(ElementIdCompat.Create(p.elementId.Value));
            if (single == null) throw new InvalidOperationException("Element not found");
            return Task.FromResult(BuildElementItem(single, wantedNames, stringsOnly));
        }

        private static object ReadCategoryPage(
            Document doc,
            IReadOnlyList<string> requestedCategories,
            HashSet<string> wantedNames,
            bool stringsOnly,
            int? offset,
            int? limit)
        {
            var catalog = new List<StrictCategoryDescriptor>();
            foreach (Category category in doc.Settings.Categories)
            {
                if (category == null) continue;
                var id = ElementIdCompat.GetValue(category.Id);
                catalog.Add(new StrictCategoryDescriptor
                {
                    Id = id,
                    Name = category.Name ?? "",
                    BuiltInToken = StrictCategoryResolver.TryGetEnumName(typeof(BuiltInCategory), id)
                });
            }

            IReadOnlyList<StrictCategoryResolution> resolved;
            try
            {
                resolved = StrictCategoryResolver.Resolve(requestedCategories, catalog);
            }
            catch (ArgumentException ex)
            {
                throw new InvalidOperationException("get-parameters category scope is invalid. " + ex.Message, ex);
            }

            if (resolved.Count == 0)
            {
                throw new InvalidOperationException("get-parameters category/categories must contain at least one category token.");
            }

            var categoryIds = resolved.Select(x => ElementIdCompat.Create(x.Id)).ToList();
            var collector = new FilteredElementCollector(doc).WhereElementIsNotElementType();
            if (categoryIds.Count == 1)
            {
                collector.WherePasses(new ElementCategoryFilter(categoryIds[0]));
            }
            else
            {
                collector.WherePasses(new ElementMulticategoryFilter(categoryIds));
            }

            var elements = collector
                .ToElements()
                .Where(x => x != null)
                .OrderBy(x => ElementIdCompat.GetValue(x.Id))
                .ToList();
            var page = ParameterReadPagingPolicy.Normalize(offset, limit);
            var selected = elements.Skip(page.Offset).Take(page.Limit).ToList();
            var items = selected.Select(x => BuildElementItem(x, wantedNames, stringsOnly)).ToList();
            var nextOffset = ParameterReadPagingPolicy.NextOffset(elements.Count, page.Offset, selected.Count);
            var warnings = new List<string>();
            if (page.LimitWasClamped)
            {
                warnings.Add($"Requested limit={page.RequestedLimit} was clamped to the safe page size {page.Limit}; continue with nextOffset until hasMore is false.");
            }

            return new
            {
                selector = "categories",
                categories = resolved.Select(x => new
                {
                    requested = x.RequestedToken,
                    id = x.Id,
                    name = x.Name,
                    builtInToken = x.BuiltInToken
                }).ToList(),
                includeStringParameters = stringsOnly,
                offset = page.Offset,
                requestedLimit = page.RequestedLimit,
                limit = page.Limit,
                returnedCount = selected.Count,
                totalMatched = elements.Count,
                hasMore = nextOffset.HasValue,
                nextOffset,
                items,
                warnings
            };
        }

        private static object BuildElementItem(Element elem, HashSet<string> wantedNames, bool stringsOnly)
        {
            var parameters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var parameterDetails = new List<object>();
            foreach (Parameter parameter in elem.Parameters)
            {
                if (parameter?.Definition == null) continue;
                if (stringsOnly && parameter.StorageType != StorageType.String) continue;
                var name = parameter.Definition.Name ?? "";
                if (wantedNames.Count > 0 && !wantedNames.Contains(name)) continue;

                var value = ReadParameterValue(parameter);
                if (!parameters.ContainsKey(name)) parameters.Add(name, value);
                parameterDetails.Add(new
                {
                    name,
                    value,
                    storageType = parameter.StorageType.ToString(),
                    isReadOnly = parameter.IsReadOnly,
                    parameterId = ElementIdCompat.GetValue(parameter.Id)
                });
            }

            return new
            {
                id = ElementIdCompat.GetValue(elem.Id),
                uniqueId = elem.UniqueId,
                name = elem.Name,
                category = elem.Category?.Name,
                categoryId = ElementIdCompat.GetValue(elem.Category?.Id),
                parameters,
                parameterDetails
            };
        }

        private static string ReadParameterValue(Parameter parameter)
        {
            switch (parameter.StorageType)
            {
                case StorageType.String:
                    return parameter.AsString() ?? "";
                case StorageType.Integer:
                    return parameter.AsInteger().ToString();
                case StorageType.Double:
                    return parameter.AsDouble().ToString();
                case StorageType.ElementId:
                    return ElementIdCompat.GetValue(parameter.AsElementId()).ToString();
                default:
                    return "";
            }
        }

        private static HashSet<string> NormalizeNames(IEnumerable<string>? names)
        {
            return new HashSet<string>(
                (names ?? Array.Empty<string>())
                    .Where(x => !string.IsNullOrWhiteSpace(x))
                    .Select(x => x.Trim()),
                StringComparer.OrdinalIgnoreCase);
        }

        private static List<string> NormalizeCategories(Params p)
        {
            var categories = new List<string>();
            if (!string.IsNullOrWhiteSpace(p.category)) categories.Add(p.category.Trim());
            if (p.categories != null)
            {
                categories.AddRange(p.categories.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()));
            }
            return categories.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        private static Params ParseRequest(string jsonData)
        {
            if (string.IsNullOrWhiteSpace(jsonData)) throw new Exception("Invalid request: body is required.");
            using (var doc = JsonDocument.Parse(jsonData))
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Object) throw new Exception("Invalid request: body must be an object.");
                var root = doc.RootElement;
                var parsed = new Params();

                if (root.TryGetProperty("elementId", out var elementIdProp) && elementIdProp.ValueKind != JsonValueKind.Null)
                    parsed.elementId = ParseLong(elementIdProp, "elementId");
                if (root.TryGetProperty("elementIds", out var elementIdsProp) && elementIdsProp.ValueKind != JsonValueKind.Null)
                    parsed.elementIds = ParseLongListOrSingle(elementIdsProp, "elementIds");
                if (root.TryGetProperty("category", out var categoryProp) && categoryProp.ValueKind != JsonValueKind.Null)
                    parsed.category = ParseString(categoryProp, "category");
                if (root.TryGetProperty("categories", out var categoriesProp) && categoriesProp.ValueKind != JsonValueKind.Null)
                    parsed.categories = ParseStringList(categoriesProp, "categories");
                if (root.TryGetProperty("names", out var namesProp) && namesProp.ValueKind != JsonValueKind.Null)
                    parsed.names = ParseStringList(namesProp, "names");
                if (root.TryGetProperty("includeStringParameters", out var stringsProp) && stringsProp.ValueKind != JsonValueKind.Null)
                    parsed.includeStringParameters = ParseBool(stringsProp, "includeStringParameters");
                if (root.TryGetProperty("offset", out var offsetProp) && offsetProp.ValueKind != JsonValueKind.Null)
                    parsed.offset = ParseInt(offsetProp, "offset");
                if (root.TryGetProperty("limit", out var limitProp) && limitProp.ValueKind != JsonValueKind.Null)
                    parsed.limit = ParseInt(limitProp, "limit");
                return parsed;
            }
        }

        private static List<string> ParseStringList(JsonElement token, string fieldName)
        {
            if (token.ValueKind != JsonValueKind.Array) throw new Exception($"{fieldName} must be an array of strings.");
            var values = new List<string>();
            foreach (var entry in token.EnumerateArray()) values.Add(ParseString(entry, fieldName));
            return values;
        }

        private static string ParseString(JsonElement token, string fieldName)
        {
            if (token.ValueKind != JsonValueKind.String) throw new Exception($"{fieldName} must be a string.");
            return (token.GetString() ?? "").Trim();
        }

        private static bool ParseBool(JsonElement token, string fieldName)
        {
            if (token.ValueKind == JsonValueKind.True) return true;
            if (token.ValueKind == JsonValueKind.False) return false;
            throw new Exception($"{fieldName} must be a boolean.");
        }

        private static int ParseInt(JsonElement token, string fieldName)
        {
            if (token.ValueKind == JsonValueKind.Number && token.TryGetInt32(out var value)) return value;
            throw new Exception($"{fieldName} must be an integer.");
        }

        private static List<long> ParseLongListOrSingle(JsonElement token, string fieldName)
        {
            var values = new List<long>();
            if (token.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in token.EnumerateArray()) values.Add(ParseLong(item, fieldName));
                return values;
            }
            values.Add(ParseLong(token, fieldName));
            return values;
        }

        private static long ParseLong(JsonElement token, string fieldName)
        {
            if (token.ValueKind == JsonValueKind.Number && token.TryGetInt64(out var numberValue)) return numberValue;
            if (token.ValueKind == JsonValueKind.String)
            {
                var textValue = token.GetString();
                if (!string.IsNullOrWhiteSpace(textValue) && long.TryParse(textValue, out var parsed)) return parsed;
            }
            throw new Exception($"{fieldName} must be an integer.");
        }
    }
}

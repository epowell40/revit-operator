using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common.Semantic
{
    // Existing native request properties remain on the handler Params type.
    // This interface lets its pure strict parser run without a UIApplication.
    public interface IGetElementParametersRequest
    {
        long? elementId { get; set; }
        List<long>? elementIds { get; set; }
        string? category { get; set; }
        List<string>? categories { get; set; }
        bool? allModelInstances { get; set; }
        List<string>? names { get; set; }
        bool? includeStringParameters { get; set; }
        string? valueContains { get; set; }
        string? valueEquals { get; set; }
        bool? caseSensitive { get; set; }
        bool? writableOnly { get; set; }
        bool? includeEmpty { get; set; }
        int? offset { get; set; }
        int? limit { get; set; }
        List<long>? preservationScheduleIds { get; set; }
    }

    public static class GetElementParametersRequestParser
    {
        public static T Parse<T>(string jsonData) where T : IGetElementParametersRequest, new()
        {
            if (string.IsNullOrWhiteSpace(jsonData)) throw new Exception("Invalid request: body is required.");
            using (var doc = JsonDocument.Parse(jsonData))
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Object) throw new Exception("Invalid request: body must be an object.");
                var root = doc.RootElement;
                var parsed = new T();
                var allowed = new HashSet<string>(new[]
                {
                    "elementId", "elementIds", "category", "categories", "allModelInstances", "names",
                    "includeStringParameters", "valueContains", "valueEquals", "caseSensitive", "writableOnly", "includeEmpty",
                    "offset", "limit", "preservationScheduleIds"
                }, StringComparer.OrdinalIgnoreCase);
                foreach (var property in root.EnumerateObject())
                {
                    if (!allowed.Contains(property.Name))
                    {
                        throw new Exception("Unknown get-parameters field '" + property.Name + "'. Supported fields: " + string.Join(", ", allowed.OrderBy(x => x)) + ".");
                    }
                }

                if (root.TryGetProperty("elementId", out var elementIdProp) && elementIdProp.ValueKind != JsonValueKind.Null)
                    parsed.elementId = ParseLong(elementIdProp, "elementId");
                if (root.TryGetProperty("elementIds", out var elementIdsProp) && elementIdsProp.ValueKind != JsonValueKind.Null)
                    parsed.elementIds = ParseLongListOrSingle(elementIdsProp, "elementIds");
                if (root.TryGetProperty("category", out var categoryProp) && categoryProp.ValueKind != JsonValueKind.Null)
                    parsed.category = ParseString(categoryProp, "category");
                if (root.TryGetProperty("categories", out var categoriesProp) && categoriesProp.ValueKind != JsonValueKind.Null)
                    parsed.categories = ParseStringList(categoriesProp, "categories");
                if (root.TryGetProperty("allModelInstances", out var allModelProp) && allModelProp.ValueKind != JsonValueKind.Null)
                    parsed.allModelInstances = ParseBool(allModelProp, "allModelInstances");
                if (root.TryGetProperty("names", out var namesProp) && namesProp.ValueKind != JsonValueKind.Null)
                    parsed.names = ParseStringList(namesProp, "names");
                if (root.TryGetProperty("includeStringParameters", out var stringsProp) && stringsProp.ValueKind != JsonValueKind.Null)
                    parsed.includeStringParameters = ParseBool(stringsProp, "includeStringParameters");
                if (root.TryGetProperty("valueContains", out var valueContainsProp) && valueContainsProp.ValueKind != JsonValueKind.Null)
                    parsed.valueContains = ParseString(valueContainsProp, "valueContains");
                if (root.TryGetProperty("valueEquals", out var valueEqualsProp) && valueEqualsProp.ValueKind != JsonValueKind.Null)
                    parsed.valueEquals = ParseString(valueEqualsProp, "valueEquals");
                if (root.TryGetProperty("caseSensitive", out var caseSensitiveProp) && caseSensitiveProp.ValueKind != JsonValueKind.Null)
                    parsed.caseSensitive = ParseBool(caseSensitiveProp, "caseSensitive");
                if (root.TryGetProperty("writableOnly", out var writableOnlyProp) && writableOnlyProp.ValueKind != JsonValueKind.Null)
                    parsed.writableOnly = ParseBool(writableOnlyProp, "writableOnly");
                if (root.TryGetProperty("includeEmpty", out var includeEmptyProp) && includeEmptyProp.ValueKind != JsonValueKind.Null)
                    parsed.includeEmpty = ParseBool(includeEmptyProp, "includeEmpty");
                if (root.TryGetProperty("offset", out var offsetProp) && offsetProp.ValueKind != JsonValueKind.Null)
                    parsed.offset = ParseInt(offsetProp, "offset");
                if (root.TryGetProperty("limit", out var limitProp) && limitProp.ValueKind != JsonValueKind.Null)
                    parsed.limit = ParseInt(limitProp, "limit");
                if (root.TryGetProperty("preservationScheduleIds", out var preservationProp) && preservationProp.ValueKind != JsonValueKind.Null)
                    parsed.preservationScheduleIds = ParsePreservationScheduleIds(preservationProp);
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

        private static List<long> ParsePreservationScheduleIds(JsonElement value)
        {
            if (value.ValueKind != JsonValueKind.Array)
                throw new Exception("preservationScheduleIds must be an array of positive integers.");
            var result = new List<long>();
            var seen = new HashSet<long>();
            foreach (var item in value.EnumerateArray())
            {
                if (result.Count >= 32 || item.ValueKind != JsonValueKind.Number || !item.TryGetInt64(out var id) || id <= 0 || !seen.Add(id))
                    throw new Exception("preservationScheduleIds requires at most 32 unique positive integer identities.");
                result.Add(id);
            }
            return result;
        }

    }
}

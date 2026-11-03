using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common.Annotation
{
    public static class TagReferenceReadPolicy
    {
        public static void ValidateOptionalRequest(JsonElement body)
        {
            var enabled = false;
            if (body.TryGetProperty("includeTagReferences", out var flag))
            {
                if (flag.ValueKind != JsonValueKind.True && flag.ValueKind != JsonValueKind.False)
                    throw new ArgumentException("includeTagReferences must be a boolean.");
                enabled = flag.GetBoolean();
            }
            int? limit = null;
            if (body.TryGetProperty("maxTagReferencesPerElement", out var maximum) && maximum.ValueKind != JsonValueKind.Null)
            {
                if (maximum.ValueKind != JsonValueKind.Number || !maximum.TryGetInt32(out var value))
                    throw new ArgumentException("maxTagReferencesPerElement must be an integer.");
                limit = value;
            }
            if (!enabled)
            {
                if (limit.HasValue) throw new ArgumentException("maxTagReferencesPerElement requires includeTagReferences:true.");
                return;
            }
            if ((!body.TryGetProperty("elementIds", out var ids) || ids.ValueKind == JsonValueKind.Null) &&
                !body.TryGetProperty("ids", out ids))
                throw new ArgumentException("Exact elementIds are required.");
            if (ids.ValueKind != JsonValueKind.Array)
                throw new ArgumentException("elementIds must be an array.");
            var values = new List<long>();
            foreach (var id in ids.EnumerateArray())
            {
                if (id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var value))
                    throw new ArgumentException("elementIds must contain native integer IDs.");
                values.Add(value);
                if (values.Count > 200) throw new ArgumentException("Tag reference reads are limited to 200 exact elementIds.");
            }
            ValidateRequest(values, limit);
        }

        public static int ValidateRequest(IEnumerable<long> elementIds, int? maxReferencesPerTag)
        {
            var ids = elementIds?.ToArray() ?? throw new ArgumentException("Exact elementIds are required.");
            if (ids.Length == 0 || ids.Length > 200 || ids.Any(id => id <= 0) || ids.Distinct().Count() != ids.Length)
                throw new ArgumentException("Tag reference reads require 1-200 unique positive elementIds.");
            var limit = maxReferencesPerTag ?? 16;
            if (limit < 1 || limit > 64)
                throw new ArgumentException("maxTagReferencesPerElement must be between 1 and 64.");
            return limit;
        }

        public static string IdentityKey(long? linkInstanceId, long elementId)
        {
            if (elementId <= 0 || (linkInstanceId.HasValue && linkInstanceId.Value <= 0))
                throw new ArgumentException("Reference identity requires positive native IDs.");
            return linkInstanceId.HasValue ? $"link:{linkInstanceId}:{elementId}" : $"host:{elementId}";
        }

        public static bool Complete(int total, int returned, int unresolved, bool orphaned, bool enumerationFailed)
        {
            if (total < 0 || returned < 0 || returned > total || unresolved < 0 || unresolved > returned)
                throw new ArgumentException("Inconsistent tag reference coverage.");
            // An orphan or unresolved reference is not a proved empty cohort.
            return total > 0 && returned == total && unresolved == 0 && !orphaned && !enumerationFailed;
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    /// <summary>
    /// Strict host-side parser for the additive observation selector. It is deliberately not
    /// registered as an HTTP route; callers must remain behind an independently authorized host boundary.
    /// </summary>
    public static class DynamicObservationSelectorWireV1
    {
        private static readonly HashSet<string> AllowedFields = new HashSet<string>(new[]
        {
            "schema", "elementUniqueIds", "categoryStableIds", "ownerViewElementIds", "visibleInViewElementId",
            "parameterNames", "includeTypeParameters", "pageSize", "cursor"
        }, StringComparer.Ordinal);

        private static readonly HashSet<string> AllowedEnvelopeFields = new HashSet<string>(new[]
        {
            "schema", "contractManifestHash", "documentFingerprint", "documentSessionId", "revisionHash",
            "scopeHash", "pageOffset", "pageSize", "totalCount", "elements", "nextCursor", "envelopeHash"
        }, StringComparer.Ordinal);

        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = false,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            NumberHandling = JsonNumberHandling.Strict,
            MaxDepth = 16
        };

        public static DynamicObservationSelectorV1 Parse(string json)
        {
            if (json == null) throw new ArgumentNullException(nameof(json));
            if (Encoding.UTF8.GetByteCount(json) > DynamicObservationContractV1.MaximumRequestBytes)
                throw new ArgumentException("Dynamic observation selector exceeds the bounded wire size.", nameof(json));
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 16
            });
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                throw new ArgumentException("Dynamic observation selector must be a JSON object.", nameof(json));
            var names = document.RootElement.EnumerateObject().Select(property => property.Name).ToArray();
            if (!names.Contains("schema", StringComparer.Ordinal) ||
                names.Distinct(StringComparer.Ordinal).Count() != names.Length ||
                names.Any(name => !AllowedFields.Contains(name)))
                throw new ArgumentException("Dynamic observation selector contains missing, duplicate, or unknown fields.", nameof(json));
            var selector = JsonSerializer.Deserialize<DynamicObservationSelectorV1>(json, Json)
                ?? throw new ArgumentException("Dynamic observation selector is empty.", nameof(json));
            DynamicObservationPolicyV1.ValidateSelector(selector);
            return selector;
        }

        public static DynamicObservationEnvelopeV1 ParseEnvelope(string json)
        {
            var root = ParseStrictObject(json, AllowedEnvelopeFields, "schema");
            root.Dispose();
            var envelope = JsonSerializer.Deserialize<DynamicObservationEnvelopeV1>(json, Json)
                ?? throw new ArgumentException("Dynamic observation envelope is empty.", nameof(json));
            DynamicObservationPolicyV1.ValidateEnvelope(envelope);
            return envelope;
        }

        private static JsonDocument ParseStrictObject(string json, HashSet<string> allowed, params string[] required)
        {
            if (json == null) throw new ArgumentNullException(nameof(json));
            if (Encoding.UTF8.GetByteCount(json) > DynamicObservationContractV1.MaximumRequestBytes)
                throw new ArgumentException("Dynamic observation wire value exceeds the bounded size.", nameof(json));
            var document = JsonDocument.Parse(json, new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 16 });
            if (document.RootElement.ValueKind != JsonValueKind.Object) { document.Dispose(); throw new ArgumentException("Dynamic observation wire value must be a JSON object.", nameof(json)); }
            var names = document.RootElement.EnumerateObject().Select(property => property.Name).ToArray();
            if (required.Any(field => !names.Contains(field, StringComparer.Ordinal)) || names.Distinct(StringComparer.Ordinal).Count() != names.Length || names.Any(name => !allowed.Contains(name)))
            { document.Dispose(); throw new ArgumentException("Dynamic observation wire value contains missing, duplicate, or unknown fields.", nameof(json)); }
            RejectDuplicateProperties(document.RootElement);
            return document;
        }

        private static void RejectDuplicateProperties(JsonElement value)
        {
            if (value.ValueKind == JsonValueKind.Object)
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    if (!names.Add(property.Name)) throw new ArgumentException("Dynamic observation wire value contains duplicate fields.");
                    RejectDuplicateProperties(property.Value);
                }
            }
            else if (value.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in value.EnumerateArray()) RejectDuplicateProperties(item);
            }
        }
    }
}

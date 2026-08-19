using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class OperatorCourierTransportResult
    {
        public JsonElement Result { get; set; }
        public bool Compacted { get; set; }
        public int OriginalResultBytes { get; set; }
        public int TransportResultBytes { get; set; }
        public int OmittedArrayItems { get; set; }
        public int OmittedObjectProperties { get; set; }
        public int TruncatedStrings { get; set; }
        public int OmittedSubtrees { get; set; }
    }

    public static class OperatorCourierResultCompactor
    {
        // The backend's authenticated JSON reader accepts one million bytes for the
        // complete envelope. Keep the result comfortably below that boundary so
        // session/executor metadata and JSON escaping cannot push the POST over it.
        public const int MaxTransportResultBytes = 600_000;
        private const int MaxArrayItems = 32;
        private const int MaxPreservedIdentifierArrayItems = 20_000;
        private const int MaxPreservedIdentifierArrayBytes = 128_000;
        private const int MaxObjectProperties = 192;
        private const int MaxStringCharacters = 8_192;
        private const int MaxDepth = 12;

        public static OperatorCourierTransportResult Prepare(object? result)
        {
            var source = NormalizeSource(result);
            var originalBytes = JsonSerializer.SerializeToUtf8Bytes(source).Length;
            if (originalBytes <= MaxTransportResultBytes)
            {
                return new OperatorCourierTransportResult
                {
                    Result = source,
                    Compacted = false,
                    OriginalResultBytes = originalBytes,
                    TransportResultBytes = originalBytes
                };
            }

            // A native laboratory receipt signs the exact, full handler result.
            // Compaction would silently detach the signature from its semantics,
            // so oversized signed evidence fails closed instead.
            if (source.ValueKind == JsonValueKind.Object
                && source.TryGetProperty(OperatorLaboratoryExecutionReceiptAuthority.ResultField, out _))
                throw new InvalidOperationException(
                    "Signed laboratory execution evidence exceeds the courier transport limit and cannot be compacted.");

            var stats = new CompactionStats();
            var bounded = Compact(source, 0, stats);
            var root = WrapWithReceipt(bounded, originalBytes, stats, emergencySummary: false);
            var prepared = SerializeWithFinalByteCount(root);

            if (prepared.bytes > MaxTransportResultBytes)
            {
                stats.OmittedSubtrees++;
                root = BuildEmergencySummary(source, originalBytes, stats);
                prepared = SerializeWithFinalByteCount(root);
            }

            if (prepared.bytes > MaxTransportResultBytes)
                throw new InvalidOperationException("Courier result compaction could not satisfy the transport byte limit.");

            return new OperatorCourierTransportResult
            {
                Result = prepared.element,
                Compacted = true,
                OriginalResultBytes = originalBytes,
                TransportResultBytes = prepared.bytes,
                OmittedArrayItems = stats.OmittedArrayItems,
                OmittedObjectProperties = stats.OmittedObjectProperties,
                TruncatedStrings = stats.TruncatedStrings,
                OmittedSubtrees = stats.OmittedSubtrees
            };
        }

        private static JsonElement NormalizeSource(object? result)
        {
            if (result is JsonElement element) return element.Clone();
            if (result is string text && !string.IsNullOrWhiteSpace(text))
            {
                try
                {
                    using var parsed = JsonDocument.Parse(text);
                    return parsed.RootElement.Clone();
                }
                catch (JsonException)
                {
                    // Some control-plane actions legitimately return plain text. Only
                    // unwrap syntactically valid JSON emitted by Revit request handlers.
                }
            }
            return JsonSerializer.SerializeToElement(result);
        }

        private static object? Compact(
            JsonElement element,
            int depth,
            CompactionStats stats,
            string? propertyName = null)
        {
            if (depth >= MaxDepth && (element.ValueKind == JsonValueKind.Object || element.ValueKind == JsonValueKind.Array))
            {
                stats.OmittedSubtrees++;
                return new Dictionary<string, object?> { ["_operator_omitted"] = "max_depth" };
            }

            switch (element.ValueKind)
            {
                case JsonValueKind.Object:
                    var result = new Dictionary<string, object?>(StringComparer.Ordinal);
                    var properties = element.EnumerateObject().ToList();
                    foreach (var property in properties.Take(MaxObjectProperties))
                        result[property.Name] = Compact(property.Value, depth + 1, stats, property.Name);
                    stats.OmittedObjectProperties += Math.Max(0, properties.Count - MaxObjectProperties);
                    return result;

                case JsonValueKind.Array:
                    var items = element.EnumerateArray().ToList();
                    if (ShouldPreserveIdentifierArray(element, propertyName, items))
                        return items.Select(item => item.Clone()).ToList();
                    var bounded = items.Take(MaxArrayItems).Select(item => Compact(item, depth + 1, stats)).ToList();
                    var omitted = Math.Max(0, items.Count - MaxArrayItems);
                    stats.OmittedArrayItems += omitted;
                    if (omitted > 0)
                    {
                        bounded.Add(new Dictionary<string, object?>
                        {
                            ["_operator_omitted_items"] = omitted,
                            ["_operator_original_items"] = items.Count
                        });
                    }
                    return bounded;

                case JsonValueKind.String:
                    var text = element.GetString() ?? "";
                    if (text.Length <= MaxStringCharacters) return text;
                    stats.TruncatedStrings++;
                    return text.Substring(0, MaxStringCharacters) + "...[operator transport truncation]";

                case JsonValueKind.True:
                    return true;
                case JsonValueKind.False:
                    return false;
                case JsonValueKind.Null:
                case JsonValueKind.Undefined:
                    return null;
                default:
                    return element.Clone();
            }
        }

        private static bool ShouldPreserveIdentifierArray(
            JsonElement element,
            string? propertyName,
            IReadOnlyCollection<JsonElement> items)
        {
            if (string.IsNullOrWhiteSpace(propertyName) || items.Count <= MaxArrayItems)
                return false;

            var normalizedName = propertyName.Trim();
            if (!string.Equals(normalizedName, "ids", StringComparison.OrdinalIgnoreCase)
                && !normalizedName.EndsWith("Ids", StringComparison.OrdinalIgnoreCase))
                return false;
            if (items.Count > MaxPreservedIdentifierArrayItems)
                return false;
            if (items.Any(item => item.ValueKind != JsonValueKind.Number && item.ValueKind != JsonValueKind.String))
                return false;

            // Complete identifier projections are the continuation handle for refining
            // an oversized verbose result. Preserve them when they are individually
            // bounded; the final envelope limit still provides a fail-safe ceiling.
            return JsonSerializer.SerializeToUtf8Bytes(element).Length <= MaxPreservedIdentifierArrayBytes;
        }

        private static Dictionary<string, object?> WrapWithReceipt(
            object? bounded,
            int originalBytes,
            CompactionStats stats,
            bool emergencySummary)
        {
            Dictionary<string, object?> root;
            if (bounded is Dictionary<string, object?> dictionary)
                root = dictionary;
            else
                root = new Dictionary<string, object?> { ["result"] = bounded };

            root["_operator_transport"] = Receipt(originalBytes, stats, emergencySummary);
            return root;
        }

        private static Dictionary<string, object?> BuildEmergencySummary(
            JsonElement source,
            int originalBytes,
            CompactionStats stats)
        {
            var root = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (source.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in source.EnumerateObject())
                {
                    if (root.Count >= 128) break;
                    if (property.Value.ValueKind == JsonValueKind.String ||
                        property.Value.ValueKind == JsonValueKind.Number ||
                        property.Value.ValueKind == JsonValueKind.True ||
                        property.Value.ValueKind == JsonValueKind.False ||
                        property.Value.ValueKind == JsonValueKind.Null)
                    {
                        root[property.Name] = Compact(property.Value, 0, stats);
                    }
                }
            }
            root["_operator_transport"] = Receipt(originalBytes, stats, emergencySummary: true);
            return root;
        }

        private static Dictionary<string, object?> Receipt(int originalBytes, CompactionStats stats, bool emergencySummary)
        {
            return new Dictionary<string, object?>
            {
                ["version"] = "revit-operator.courier-result-compaction.v1",
                ["compacted"] = true,
                ["requires_refinement_for_complete_rows"] = true,
                ["original_result_bytes"] = originalBytes,
                ["transport_result_bytes"] = 0,
                ["max_transport_result_bytes"] = MaxTransportResultBytes,
                ["omitted_array_items"] = stats.OmittedArrayItems,
                ["omitted_object_properties"] = stats.OmittedObjectProperties,
                ["truncated_strings"] = stats.TruncatedStrings,
                ["omitted_subtrees"] = stats.OmittedSubtrees,
                ["emergency_summary"] = emergencySummary
            };
        }

        private static (JsonElement element, int bytes) SerializeWithFinalByteCount(Dictionary<string, object?> root)
        {
            root.TryGetValue("_operator_transport", out var metadata);
            var receipt = metadata as Dictionary<string, object?>;
            var previousBytes = -1;
            for (var attempt = 0; attempt < 8; attempt++)
            {
                var current = JsonSerializer.SerializeToElement(root);
                var currentBytes = JsonSerializer.SerializeToUtf8Bytes(current).Length;
                if (receipt == null || currentBytes == previousBytes)
                    return (current, currentBytes);
                receipt["transport_result_bytes"] = currentBytes;
                previousBytes = currentBytes;
            }

            var final = JsonSerializer.SerializeToElement(root);
            var finalBytes = JsonSerializer.SerializeToUtf8Bytes(final).Length;
            if (receipt != null && !Equals(receipt["transport_result_bytes"], finalBytes))
                throw new InvalidOperationException("Courier result byte-count receipt did not stabilize.");
            return (final, finalBytes);
        }

        private sealed class CompactionStats
        {
            public int OmittedArrayItems { get; set; }
            public int OmittedObjectProperties { get; set; }
            public int TruncatedStrings { get; set; }
            public int OmittedSubtrees { get; set; }
        }
    }
}

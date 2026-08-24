using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;

namespace RevitBridge.Common
{
    /// <summary>
    /// Minimal native transaction truth returned by ordinary Revit handlers.
    /// The canonical settlement layer consumes this structure and never infers
    /// transaction outcome from presentation-oriented status or prose.
    /// </summary>
    public sealed class OperatorNativeTransactionReceipt
    {
        [JsonPropertyName("status")]
        public string Status { get; }

        [JsonPropertyName("committed")]
        public bool? CommittedValue { get; }

        [JsonPropertyName("modified_element_ids")]
        public IReadOnlyList<long> ModifiedElementIds { get; }

        [JsonPropertyName("affected_element_ids")]
        public IReadOnlyList<long> AffectedElementIds { get; }

        private OperatorNativeTransactionReceipt(
            string status,
            bool? committed,
            IEnumerable<long>? modifiedElementIds,
            IEnumerable<long>? affectedElementIds)
        {
            Status = status;
            CommittedValue = committed;
            ModifiedElementIds = Normalize(modifiedElementIds);
            AffectedElementIds = Normalize(affectedElementIds);
        }

        public static OperatorNativeTransactionReceipt Committed(IEnumerable<long> modifiedElementIds)
            => new OperatorNativeTransactionReceipt("committed", true, modifiedElementIds, modifiedElementIds);

        public static OperatorNativeTransactionReceipt RolledBack(IEnumerable<long> affectedElementIds)
            => new OperatorNativeTransactionReceipt("rolled_back", false, Array.Empty<long>(), affectedElementIds);

        public static OperatorNativeTransactionReceipt NotStarted(IEnumerable<long>? targetElementIds = null)
            => new OperatorNativeTransactionReceipt("not_started", false, Array.Empty<long>(), targetElementIds);

        public static OperatorNativeTransactionReceipt Unknown(string nativeStatus, IEnumerable<long>? targetElementIds = null)
        {
            var bounded = (nativeStatus ?? "").Trim();
            if (bounded.Length == 0) bounded = "unknown";
            if (bounded.Length > 80) bounded = bounded.Substring(0, 80);
            return new OperatorNativeTransactionReceipt(bounded.ToLowerInvariant(), null, Array.Empty<long>(), targetElementIds);
        }

        private static IReadOnlyList<long> Normalize(IEnumerable<long>? values)
            => (values ?? Array.Empty<long>()).Where(value => value > 0).Distinct().OrderBy(value => value).ToArray();
    }
}

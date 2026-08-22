using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitBridge.Common
{
    public static class OperatorAttemptSettlementProtocol
    {
        public const string Version = "revit-operator.native-attempt-settlement.v1";
    }

    /// <summary>
    /// Native host truth for one dispatched request. This is deliberately
    /// independent of assistant wording and of benchmark policy. Unknown is
    /// fail-closed: it may only be resolved by exact target reconciliation.
    /// </summary>
    public sealed class OperatorAttemptSettlement
    {
        [JsonPropertyName("schema")]
        public string Schema { get; set; } = OperatorAttemptSettlementProtocol.Version;
        [JsonPropertyName("assignment_id")]
        public string? AssignmentId { get; set; }
        [JsonPropertyName("attempt_id")]
        public string? AttemptId { get; set; }
        [JsonPropertyName("run_id")]
        public string? RunId { get; set; }
        [JsonPropertyName("generation")]
        public int? Generation { get; set; }
        [JsonPropertyName("requested_effect")]
        public string RequestedEffect { get; set; } = "read";
        [JsonPropertyName("method")]
        public string Method { get; set; } = "";
        [JsonPropertyName("path")]
        public string Path { get; set; } = "";
        [JsonPropertyName("action_signature")]
        public string? ActionSignature { get; set; }
        [JsonPropertyName("target_fingerprint")]
        public string? TargetFingerprint { get; set; }
        [JsonPropertyName("request_dispatched")]
        public bool RequestDispatched { get; set; }
        [JsonPropertyName("effect_state")]
        public string EffectState { get; set; } = "none";
        [JsonPropertyName("effect_reason")]
        public string EffectReason { get; set; } = "request_not_dispatched";
        [JsonPropertyName("effect_authority")]
        public string EffectAuthority { get; set; } = "native_host";
        [JsonPropertyName("affected_target_identities")]
        public IReadOnlyList<string> AffectedTargetIdentities { get; set; } = Array.Empty<string>();
        [JsonPropertyName("receipt_refs")]
        public IReadOnlyList<string> ReceiptRefs { get; set; } = Array.Empty<string>();
        [JsonPropertyName("evidence_refs")]
        public IReadOnlyList<string> EvidenceRefs { get; set; } = Array.Empty<string>();
        [JsonPropertyName("settled_at_utc")]
        public DateTimeOffset SettledAtUtc { get; set; } = DateTimeOffset.UtcNow;

        public static OperatorAttemptSettlement None(
            string requestedEffect,
            string method,
            string path,
            string reason,
            string authority = "native_host",
            bool requestDispatched = false)
            => Create(requestedEffect, method, path, requestDispatched, "none", reason, authority);

        public static OperatorAttemptSettlement Unknown(
            string requestedEffect,
            string method,
            string path,
            string reason,
            string authority = "native_host")
            => Create(requestedEffect, method, path, true, "unknown", reason, authority);

        public static OperatorAttemptSettlement Applied(
            string method,
            string path,
            string reason,
            string authority,
            IReadOnlyList<string>? affectedTargets = null,
            IReadOnlyList<string>? receiptRefs = null,
            IReadOnlyList<string>? evidenceRefs = null)
        {
            if (authority != "native_transaction" && authority != "native_receipt" && authority != "target_readback")
                throw new ArgumentException("Applied settlement requires native transaction, native receipt, or target readback authority.", nameof(authority));
            var value = Create("apply", method, path, true, "applied", reason, authority);
            value.AffectedTargetIdentities = affectedTargets ?? Array.Empty<string>();
            value.ReceiptRefs = receiptRefs ?? Array.Empty<string>();
            value.EvidenceRefs = evidenceRefs ?? Array.Empty<string>();
            return value;
        }

        public OperatorAttemptSettlement Bind(
            string? assignmentId,
            string? attemptId,
            string? runId,
            int? generation,
            string? actionSignature,
            string? targetFingerprint)
        {
            AssignmentId = Clean(assignmentId);
            AttemptId = Clean(attemptId);
            RunId = Clean(runId);
            Generation = generation >= 0 ? generation : null;
            ActionSignature = Clean(actionSignature);
            TargetFingerprint = Clean(targetFingerprint);
            return this;
        }

        private static OperatorAttemptSettlement Create(
            string requestedEffect,
            string method,
            string path,
            bool requestDispatched,
            string state,
            string reason,
            string authority)
            => new OperatorAttemptSettlement
            {
                RequestedEffect = NormalizeEffect(requestedEffect),
                Method = (method ?? "").Trim().ToUpperInvariant(),
                Path = (path ?? "").Trim(),
                RequestDispatched = requestDispatched,
                EffectState = state,
                EffectReason = string.IsNullOrWhiteSpace(reason) ? $"effect_{state}" : reason.Trim(),
                EffectAuthority = string.IsNullOrWhiteSpace(authority) ? "native_host" : authority.Trim(),
                SettledAtUtc = DateTimeOffset.UtcNow
            };

        private static string NormalizeEffect(string? value)
        {
            var effect = (value ?? "").Trim().ToLowerInvariant();
            return effect == "preview" || effect == "apply" ? effect : "read";
        }

        private static string? Clean(string? value)
        {
            var text = (value ?? "").Trim();
            return text.Length == 0 ? null : text;
        }
    }

    public static class OperatorAttemptSuccessfulSettlement
    {
        public static object Attach(
            object result,
            string requestedEffect,
            string method,
            string path,
            string? assignmentId = null,
            string? attemptId = null,
            string? runId = null,
            int? generation = null,
            string? actionSignature = null,
            string? targetFingerprint = null)
        {
            if (result == null) throw new ArgumentNullException(nameof(result));
            var settlement = Classify(result, requestedEffect, method, path)
                .Bind(assignmentId, attemptId, runId, generation, actionSignature, targetFingerprint);
            var serialized = JsonSerializer.Serialize(result);
            using var document = JsonDocument.Parse(serialized);
            var envelope = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (document.RootElement.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in document.RootElement.EnumerateObject())
                {
                    if (property.NameEquals("canonical_attempt_settlement")) continue;
                    envelope[property.Name] = property.Value.Clone();
                }
            }
            else envelope["result"] = document.RootElement.Clone();
            envelope["canonical_attempt_settlement"] = settlement;
            return envelope;
        }

        public static OperatorAttemptSettlement Classify(object result, string requestedEffect, string method, string path)
        {
            var effect = (requestedEffect ?? "").Trim().ToLowerInvariant();
            if (effect != "preview" && effect != "apply") effect = "read";
            if (effect == "read")
                return OperatorAttemptSettlement.None(effect, method, path, "read_has_no_persistent_effect", "native_host", requestDispatched: true);

            using var document = JsonDocument.Parse(JsonSerializer.Serialize(result));
            var root = document.RootElement;
            if (TryCertifiedReceipt(root, out var phase, out var receiptRef))
            {
                if (phase == "preview")
                {
                    var preview = OperatorAttemptSettlement.None("preview", method, path, "verified_native_rollback", "native_rollback", requestDispatched: true);
                    preview.ReceiptRefs = new[] { receiptRef };
                    return preview;
                }
                var applied = OperatorAttemptSettlement.Applied(method, path, "certified_native_apply_receipt", "native_receipt", receiptRefs: new[] { receiptRef });
                return applied;
            }
            if (TryTransactionSettlement(root, out var committed, out var affected))
            {
                if (!committed)
                {
                    var preview = OperatorAttemptSettlement.None(effect, method, path, "verified_native_rollback", "native_rollback", requestDispatched: true);
                    preview.AffectedTargetIdentities = affected;
                    return preview;
                }
                return OperatorAttemptSettlement.Applied(method, path, "native_transaction_committed", "native_transaction", affected);
            }
            return OperatorAttemptSettlement.Unknown(effect, method, path, "native_handler_returned_without_authoritative_settlement", "native_host");
        }

        private static bool TryCertifiedReceipt(JsonElement root, out string phase, out string receiptRef)
        {
            phase = "";
            receiptRef = "";
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("certified_execution_receipt", out var receipt)
                || receipt.ValueKind != JsonValueKind.Object
                || !receipt.TryGetProperty("schema", out var schema)
                || schema.GetString() != "revit-operator.certified-family-execution-receipt.v1"
                || !receipt.TryGetProperty("phase", out var phaseValue)) return false;
            phase = phaseValue.GetString() ?? "";
            if (phase != "preview" && phase != "apply") return false;
            receiptRef = receipt.TryGetProperty("native_attestation_signature", out var signature)
                ? $"native-attestation:{signature.GetString()}"
                : "native-certified-receipt";
            return OperatorCertifiedMovePreviewAuthority.IsIndependentlyVerifiedCertifiedFamilyResult(
                JsonSerializer.Deserialize<object>(root.GetRawText())!);
        }

        private static bool TryTransactionSettlement(JsonElement root, out bool committed, out IReadOnlyList<string> affected)
        {
            committed = false;
            affected = Array.Empty<string>();
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("transaction", out var transaction)
                || transaction.ValueKind != JsonValueKind.Object
                || !transaction.TryGetProperty("status", out var statusValue)) return false;
            var status = (statusValue.GetString() ?? "").Trim().ToLowerInvariant();
            if (status != "committed" && status != "rolled_back" && status != "rolledback") return false;
            if (transaction.TryGetProperty("committed", out var committedValue)
                && (committedValue.ValueKind != JsonValueKind.True && committedValue.ValueKind != JsonValueKind.False)) return false;
            committed = status == "committed";
            if (transaction.TryGetProperty("committed", out committedValue) && committedValue.GetBoolean() != committed) return false;
            var targets = new List<string>();
            foreach (var propertyName in new[] { "added_element_ids", "modified_element_ids", "deleted_element_ids", "affected_element_ids" })
            {
                if (!transaction.TryGetProperty(propertyName, out var ids) || ids.ValueKind != JsonValueKind.Array) continue;
                targets.AddRange(ids.EnumerateArray()
                    .Where(value => value.ValueKind == JsonValueKind.Number)
                    .Select(value => $"element_id:{value.GetInt64()}"));
            }
            affected = targets.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray();
            return true;
        }
    }

    public static class OperatorAttemptFailureSettlement
    {
        public static OperatorAttemptSettlement FromFailure(
            OperatorCourierFailureReceipt failure,
            string requestedEffect,
            string method,
            string path)
        {
            if (failure == null) throw new ArgumentNullException(nameof(failure));
            if (failure.OutcomeUnknown)
                return OperatorAttemptSettlement.Unknown(requestedEffect, method, path, failure.Code, "native_host");
            return OperatorAttemptSettlement.None(
                requestedEffect,
                method,
                path,
                failure.Code,
                FailureAuthority(failure),
                requestDispatched: false);
        }

        private static string FailureAuthority(OperatorCourierFailureReceipt failure)
        {
            var phase = (failure.Phase ?? "").Trim().ToLowerInvariant();
            if (phase.Contains("validation")) return "schema_validator";
            if (phase.Contains("authorization") || phase.Contains("admission")) return "admission_policy";
            if (phase.Contains("write_grant")) return "write_grant";
            return "native_host";
        }
    }
}

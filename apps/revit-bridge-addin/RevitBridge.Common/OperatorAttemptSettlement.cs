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
            if (OperatorNativeArtifactReceipt.TrySettlement(root, effect, method, path, out var artifactSettlement))
                return artifactSettlement ?? OperatorAttemptSettlement.Unknown(effect, method, path, "native_artifact_export_unverified", "native_host");
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
            if (TryExistingConditionsStageSettlement(root, effect, method, path, out var stageSettlement))
                return stageSettlement!;
            if (TryTransactionSettlement(root, out var transactionStatus, out var committed, out var affected))
            {
                if (transactionStatus == "not_started")
                {
                    var noEffect = OperatorAttemptSettlement.None(effect, method, path, "native_transaction_not_started", "native_transaction", requestDispatched: true);
                    noEffect.AffectedTargetIdentities = affected;
                    return noEffect;
                }
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

        private static bool TryExistingConditionsStageSettlement(JsonElement root, string effect, string method,
            string path, out OperatorAttemptSettlement? settlement)
        {
            settlement = null;
            if (!string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(path, "/revit/existing-conditions-mep-draft-workflow", StringComparison.OrdinalIgnoreCase)
                || root.ValueKind != JsonValueKind.Object) return false;
            bool IsTrue(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
            bool IsFalse(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.False;
            bool EmptyArray(string name) => root.TryGetProperty(name, out var value)
                && value.ValueKind == JsonValueKind.Array && value.GetArrayLength() == 0;
            if (!root.TryGetProperty("schema", out var schema) || schema.GetString() != "operator.existing_conditions_mep_draft_workflow.v1"
                || !root.TryGetProperty("status", out var status) || status.ValueKind != JsonValueKind.String
                || !IsTrue("rollbackVerified") || !IsTrue("atomic")
                || !EmptyArray("residualCreatedElementIds")) return false;
            // The child may reject a missing explicit duct type before opening
            // its own transaction. The outer stage still proves its rollback;
            // require every root and child effect list empty before crediting
            // this as no effect, never as a successful preview.
            if (effect == "preview" && status.GetString() == "Blocked"
                && IsTrue("dryRun") && IsTrue("transactionGroupRolledBack")
                && EmptyArray("createdElementIds") && EmptyArray("transientCreatedElementIds")
                && EmptyArray("operations") && EmptyArray("operationOutputs")
                && root.TryGetProperty("operationCount", out var branchCount) && branchCount.TryGetInt32(out var zeroBranchCount) && zeroBranchCount == 0
                && root.TryGetProperty("priorActionOutputCount", out var branchPrior) && branchPrior.TryGetInt32(out var zeroBranchPrior) && zeroBranchPrior == 0
                && root.TryGetProperty("stageKey", out var branchStage) && branchStage.ValueKind == JsonValueKind.String
                && root.TryGetProperty("error", out var branchError) && branchError.ValueKind == JsonValueKind.String
                && root.TryGetProperty("failedOperation", out var branchFailed) && branchFailed.ValueKind == JsonValueKind.Object
                && branchFailed.TryGetProperty("actionKey", out var branchAction) && branchAction.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(branchAction.GetString())
                && branchStage.GetString() == "operation:" + branchAction.GetString()
                && branchFailed.TryGetProperty("path", out var branchPath) && branchPath.GetString() == "/revit/connect-mep-branch"
                && branchFailed.TryGetProperty("createdElementIds", out var branchCreated) && branchCreated.ValueKind == JsonValueKind.Array && branchCreated.GetArrayLength() == 0
                && branchFailed.TryGetProperty("transientCreatedElementIds", out var branchTransient) && branchTransient.ValueKind == JsonValueKind.Array && branchTransient.GetArrayLength() == 0
                && branchFailed.TryGetProperty("response", out var branchResponse) && branchResponse.ValueKind == JsonValueKind.Object
                && branchResponse.TryGetProperty("status", out var branchStatus) && branchStatus.GetString() == "Blocked"
                && branchResponse.TryGetProperty("dryRun", out var branchDryRun) && branchDryRun.ValueKind == JsonValueKind.False
                && branchResponse.TryGetProperty("rolledBack", out var branchRolledBack) && branchRolledBack.ValueKind == JsonValueKind.True
                && branchResponse.TryGetProperty("kind", out var branchKind) && branchKind.GetString() == "duct"
                && branchResponse.TryGetProperty("error", out var branchChildError) && branchChildError.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(branchChildError.GetString())
                && branchError.GetString() == "operation_failed:" + branchAction.GetString() + ":" + branchChildError.GetString()
                && new[] { "splitMainSegmentIds", "createdBranchElementIds", "createdFittingIds" }
                    .All(name => branchResponse.TryGetProperty(name, out var ids) && ids.ValueKind == JsonValueKind.Array && ids.GetArrayLength() == 0))
            {
                settlement = OperatorAttemptSettlement.None(effect, method, path, "verified_native_rollback", "native_rollback", requestDispatched: true);
                return true;
            }
            if (effect == "preview" && status.GetString() == "Blocked"
                && IsTrue("dryRun") && IsTrue("transactionGroupRolledBack")
                && EmptyArray("createdElementIds") && EmptyArray("transientCreatedElementIds")
                && EmptyArray("operations") && EmptyArray("operationOutputs")
                && root.TryGetProperty("operationCount", out var preflightCount) && preflightCount.TryGetInt32(out var zeroPreflightCount) && zeroPreflightCount == 0
                && root.TryGetProperty("priorActionOutputCount", out var preflightPrior) && preflightPrior.TryGetInt32(out var zeroPreflightPrior) && zeroPreflightPrior == 0
                && root.TryGetProperty("stageKey", out var preflightStage) && preflightStage.ValueKind == JsonValueKind.String
                && root.TryGetProperty("error", out var preflightError) && preflightError.ValueKind == JsonValueKind.String
                && root.TryGetProperty("failedOperation", out var preflightFailed) && preflightFailed.ValueKind == JsonValueKind.Object
                && preflightFailed.TryGetProperty("actionKey", out var preflightAction) && preflightAction.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(preflightAction.GetString())
                && preflightStage.GetString() == "operation:" + preflightAction.GetString()
                && preflightFailed.TryGetProperty("path", out var preflightPath) && preflightPath.GetString() == "/revit/create-mep-route"
                && preflightFailed.TryGetProperty("createdElementIds", out var preflightCreated) && preflightCreated.ValueKind == JsonValueKind.Array && preflightCreated.GetArrayLength() == 0
                && preflightFailed.TryGetProperty("transientCreatedElementIds", out var preflightTransient) && preflightTransient.ValueKind == JsonValueKind.Array && preflightTransient.GetArrayLength() == 0
                && preflightFailed.TryGetProperty("response", out var preflightResponse) && preflightResponse.ValueKind == JsonValueKind.Object
                && preflightResponse.TryGetProperty("status", out var preflightStatus) && preflightStatus.GetString() == "Blocked"
                && preflightResponse.TryGetProperty("error", out var preflightChildError) && preflightChildError.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(preflightChildError.GetString())
                && preflightError.GetString() == "operation_failed:" + preflightAction.GetString() + ":" + preflightChildError.GetString()
                && preflightResponse.TryGetProperty("transaction", out var preflightTransaction) && preflightTransaction.ValueKind == JsonValueKind.Object
                && preflightTransaction.TryGetProperty("status", out var preflightTxStatus) && preflightTxStatus.GetString() == "not_started"
                && preflightTransaction.TryGetProperty("committed", out var preflightCommitted) && preflightCommitted.ValueKind == JsonValueKind.False
                && new[] { "added_element_ids", "modified_element_ids", "deleted_element_ids", "affected_element_ids" }
                    .All(name => preflightTransaction.TryGetProperty(name, out var ids) && ids.ValueKind == JsonValueKind.Array && ids.GetArrayLength() == 0))
            {
                settlement = OperatorAttemptSettlement.None(effect, method, path, "native_transaction_not_started", "native_transaction", requestDispatched: true);
                return true;
            }
            // A rejected child route can have transient affected IDs even after
            // Revit rolls its transaction back. The outer group and child receipt
            // together must prove that none survived before retry is permitted.
            if (effect == "preview" && status.GetString() == "Blocked"
                && IsTrue("dryRun") && IsTrue("transactionGroupRolledBack")
                && EmptyArray("createdElementIds") && EmptyArray("transientCreatedElementIds")
                && EmptyArray("operations") && EmptyArray("operationOutputs")
                && root.TryGetProperty("operationCount", out var blockedCount)
                && blockedCount.ValueKind == JsonValueKind.Number && blockedCount.TryGetInt32(out var zeroCount) && zeroCount == 0
                && root.TryGetProperty("priorActionOutputCount", out var priorCount)
                && priorCount.ValueKind == JsonValueKind.Number && priorCount.TryGetInt32(out var zeroPrior) && zeroPrior == 0
                && root.TryGetProperty("stageKey", out var stageKey) && stageKey.ValueKind == JsonValueKind.String
                && root.TryGetProperty("error", out var blockedError) && blockedError.ValueKind == JsonValueKind.String
                && root.TryGetProperty("failedOperation", out var failed) && failed.ValueKind == JsonValueKind.Object
                && failed.TryGetProperty("actionKey", out var actionKey) && actionKey.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(actionKey.GetString())
                && stageKey.GetString() == "operation:" + actionKey.GetString()
                && (blockedError.GetString() ?? "").StartsWith("operation_failed:" + actionKey.GetString() + ":", StringComparison.Ordinal)
                && failed.TryGetProperty("path", out var childPath) && childPath.ValueKind == JsonValueKind.String
                && childPath.GetString() == "/revit/create-mep-route"
                && failed.TryGetProperty("createdElementIds", out var childCreated)
                && childCreated.ValueKind == JsonValueKind.Array && childCreated.GetArrayLength() == 0
                && failed.TryGetProperty("transientCreatedElementIds", out var childTransient)
                && childTransient.ValueKind == JsonValueKind.Array && childTransient.GetArrayLength() == 0
                && failed.TryGetProperty("response", out var child) && child.ValueKind == JsonValueKind.Object
                && child.TryGetProperty("status", out var childStatus) && childStatus.GetString() == "Blocked"
                && child.TryGetProperty("error", out var childError) && childError.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(childError.GetString())
                && blockedError.GetString() == "operation_failed:" + actionKey.GetString() + ":" + childError.GetString()
                && child.TryGetProperty("dryRun", out var childDryRun) && childDryRun.ValueKind == JsonValueKind.False
                && child.TryGetProperty("rolledBack", out var childRollback) && childRollback.ValueKind == JsonValueKind.True
                && child.TryGetProperty("createdElementIds", out var responseCreated)
                && responseCreated.ValueKind == JsonValueKind.Array && responseCreated.GetArrayLength() == 0
                && child.TryGetProperty("transaction", out var transaction) && transaction.ValueKind == JsonValueKind.Object
                && transaction.TryGetProperty("status", out var transactionStatus) && transactionStatus.GetString() == "rolled_back"
                && transaction.TryGetProperty("committed", out var transactionCommitted) && transactionCommitted.ValueKind == JsonValueKind.False
                && transaction.TryGetProperty("added_element_ids", out var added) && added.ValueKind == JsonValueKind.Array && added.GetArrayLength() == 0
                && transaction.TryGetProperty("modified_element_ids", out var modified) && modified.ValueKind == JsonValueKind.Array && modified.GetArrayLength() == 0
                && transaction.TryGetProperty("deleted_element_ids", out var deleted) && deleted.ValueKind == JsonValueKind.Array && deleted.GetArrayLength() == 0)
            {
                settlement = OperatorAttemptSettlement.None(effect, method, path, "verified_native_rollback", "native_rollback", requestDispatched: true);
                return true;
            }
            if (!root.TryGetProperty("error", out var error) || error.ValueKind != JsonValueKind.Null
                || !root.TryGetProperty("operationCount", out var count) || count.ValueKind != JsonValueKind.Number
                || !count.TryGetInt32(out var operationCount) || operationCount < 1
                || !root.TryGetProperty("createdElementIds", out var created) || created.ValueKind != JsonValueKind.Array
                || !root.TryGetProperty("transientCreatedElementIds", out var transient) || transient.ValueKind != JsonValueKind.Array)
                return false;
            var preview = effect == "preview" && status.GetString() == "DryRunReady"
                && IsTrue("dryRun") && IsTrue("transactionGroupRolledBack")
                && created.GetArrayLength() == 0 && transient.GetArrayLength() > 0;
            var apply = effect == "apply" && status.GetString() == "Applied"
                && IsFalse("dryRun") && IsFalse("transactionGroupRolledBack")
                && created.GetArrayLength() > 0 && transient.GetArrayLength() == 0;
            if (!preview && !apply) return false;
            var ids = (preview ? transient : created).EnumerateArray().ToArray();
            if (ids.Any(id => id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var value) || value <= 0)
                || ids.Select(id => id.GetInt64()).Distinct().Count() != ids.Length) return false;
            settlement = preview
                ? OperatorAttemptSettlement.None(effect, method, path, "verified_native_rollback", "native_rollback", requestDispatched: true)
                : OperatorAttemptSettlement.Applied(method, path, "native_transaction_committed", "native_transaction",
                    ids.Select(id => $"element_id:{id.GetInt64()}").ToArray());
            return true;
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

        private static bool TryTransactionSettlement(JsonElement root, out string status, out bool committed, out IReadOnlyList<string> affected)
        {
            status = "";
            committed = false;
            affected = Array.Empty<string>();
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("transaction", out var transaction)
                || transaction.ValueKind != JsonValueKind.Object
                || !transaction.TryGetProperty("status", out var statusValue)) return false;
            status = (statusValue.GetString() ?? "").Trim().ToLowerInvariant();
            if (status != "committed" && status != "rolled_back" && status != "rolledback" && status != "not_started") return false;
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

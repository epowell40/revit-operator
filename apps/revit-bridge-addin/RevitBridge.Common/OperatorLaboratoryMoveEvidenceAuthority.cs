using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Common
{
    /// <summary>
    /// Process-local rollback-preview authority for laboratory evidence. A
    /// signed preview is recorded only after independent rollback readback; its
    /// exact canonical receipt is then a one-use capability consumed before an
    /// apply handler can run.
    /// </summary>
    public static class OperatorLaboratoryMoveEvidenceAuthority
    {
        private const int MaximumEntries = 4096;
        private static readonly TimeSpan MaximumAge = TimeSpan.FromMinutes(15);
        private static readonly object Gate = new object();
        private static readonly Dictionary<string, Entry> Issued = new Dictionary<string, Entry>(StringComparer.Ordinal);
        private static readonly Dictionary<string, RunFence> RunsByDocumentSession = new Dictionary<string, RunFence>(StringComparer.Ordinal);
        private static readonly HashSet<string> ProjectionKeys = new HashSet<string>(new[]
        {
            "admission_hash", "run_nonce", "request_family_id", "request_family_hash", "request_instance_hash", "admission_session_id",
            "phase", "effect_id", "effect_hash", "policy_hash", "policy_record_hash", "evidence_record_hash", "outbound_body_sha256", "document_fingerprint", "document_session_id",
            "source_scoped_id", "element_id", "observation_id", "observation_binding_hash", "native_attestation_key_id",
            "native_attestation_modulus_base64url", "native_attestation_exponent_base64url", "channel", "alias",
            "preview_lineage_receipt_hash"
        }, StringComparer.Ordinal);

        public static OperatorCertifiedMoveExecutionStart? CaptureStartAndConsumeApplyReceipt(
            UIApplication app,
            OperatorLaboratoryMoveEvidenceAdmission? admission,
            OperatorLaboratoryEvidenceDispatch laboratoryEvidence,
            string effectiveBodyJson)
        {
            if (admission == null) return null;
            if (laboratoryEvidence == null) throw Denied("Laboratory move is missing its authenticated evidence dispatch.");
            var familyAdmission = admission.RequireValidEffectiveBody(effectiveBodyJson);
            OperatorNativeDocumentSessionAuthority.RequireCurrent(app, familyAdmission);
            var element = app.ActiveUIDocument.Document.GetElement(ElementIdCompat.Create(admission.ElementId));
            if (element == null || !element.IsValidObject || !(element.Location is LocationPoint point))
                throw Denied("Laboratory move target is not an exact native LocationPoint immediately before dispatch.");
            if (element.Pinned || element.GroupId != ElementId.InvalidElementId)
                throw Denied("Laboratory move evidence requires an unpinned, ungrouped disposable target.");
            var vector = OperatorCertifiedMovePreviewAuthority.ReadVector(effectiveBodyJson);
            var executionStart = new OperatorCertifiedMoveExecutionStart(
                admission.RequestInstanceHash, admission.Phase, point.Point.X, point.Point.Y, point.Point.Z,
                vector.X, vector.Y, vector.Z);
            if (admission.Phase == "preview")
            {
                BeginRunFence(admission, laboratoryEvidence, executionStart);
                return executionStart;
            }

            var lineage = admission.Lineage ?? throw Denied("Laboratory move apply is missing its signed preview lineage.");
            JsonElement receipt;
            try
            {
                using var document = JsonDocument.Parse(lineage.PreviewExecutionReceiptJson);
                receipt = document.RootElement.Clone();
            }
            catch (JsonException) { throw Denied("Laboratory move preview receipt JSON is invalid."); }
            if (!OperatorLaboratoryExecutionReceiptAuthority.VerifyReceipt(
                    receipt,
                    admission.NativeAttestationKeyId,
                    admission.NativeAttestationModulusBase64Url,
                    admission.NativeAttestationExponentBase64Url))
                throw Denied("Laboratory move preview receipt signature or structure is invalid.");
            if (!receipt.TryGetProperty("laboratory_move_evidence", out var moveProjection)
                || !IsExactProjection(moveProjection)
                || !String(moveProjection, "phase", out var previewPhase) || previewPhase != "preview"
                || !String(moveProjection, "request_instance_hash", out var previewRequestHash)
                || previewRequestHash != lineage.PreviewRequestInstanceHash
                || !String(receipt, "outcome", out var outcome) || outcome != "rolled_back")
                throw Denied("Laboratory move apply lineage is not an exact signed rollback preview.");

            Entry? entry;
            lock (Gate)
            {
                Prune(DateTimeOffset.UtcNow);
                if (!Issued.TryGetValue(lineage.PreviewExecutionReceiptSha256, out entry))
                    throw Denied("Laboratory move preview receipt is unknown, expired, or already consumed.");
                // Consume before all remaining comparisons and before dispatch.
                Issued.Remove(lineage.PreviewExecutionReceiptSha256);
            }
            if (entry == null
                || entry.PreviewRequestInstanceHash != lineage.PreviewRequestInstanceHash
                || entry.CandidateSourceHash != admission.CandidateSourceHash
                || entry.EvidenceRunId != admission.EvidenceRunId
                || entry.AdmissionSessionId != admission.AdmissionSessionId
                || entry.PolicyHash != admission.PolicyHash || entry.PolicyRecordHash != admission.PolicyRecordHash
                || entry.EvidenceRecordHash != admission.EvidenceRecordHash
                || entry.FamilyId != admission.RequestFamilyId || entry.FamilyHash != admission.RequestFamilyHash
                || entry.DocumentFingerprint != admission.DocumentFingerprint || entry.DocumentSessionId != admission.DocumentSessionId
                || entry.SourceScopedId != admission.SourceScopedId || entry.ElementId != admission.ElementId
                || entry.ObservationId != admission.ObservationId || entry.ObservationBindingHash != admission.ObservationBindingHash
                || entry.Channel != admission.Channel || entry.Alias != admission.Alias)
                throw Denied("Laboratory move apply does not match its one-use native rollback preview.");
            if (entry.VectorX != vector.X || entry.VectorY != vector.Y || entry.VectorZ != vector.Z
                || !Near(entry.StartX, executionStart.StartX) || !Near(entry.StartY, executionStart.StartY) || !Near(entry.StartZ, executionStart.StartZ))
                throw Denied("Laboratory move target or vector changed after its rollback preview.");
            BeginRunFence(admission, laboratoryEvidence, executionStart);
            return executionStart;
        }

        public static Dictionary<string, object?> BuildProjectionAfterResult(
            UIApplication app,
            object handlerResult,
            OperatorLaboratoryMoveEvidenceAdmission admission,
            OperatorLaboratoryEvidenceDispatch laboratoryEvidence,
            OperatorCertifiedMoveExecutionStart executionStart,
            string effectiveBodyJson)
        {
            if (executionStart == null || executionStart.RequestInstanceHash != admission.RequestInstanceHash)
                throw Denied("Laboratory move result is missing its native pre-dispatch state.");
            if (laboratoryEvidence.CandidateSourceHash != admission.CandidateSourceHash
                || laboratoryEvidence.EvidenceRunId != admission.EvidenceRunId)
                throw Denied("Laboratory move result changed its evidence dispatch identity.");
            var familyAdmission = admission.RequireValidEffectiveBody(effectiveBodyJson);
            OperatorNativeDocumentSessionAuthority.RequireCurrent(app, familyAdmission);
            using var resultDocument = JsonDocument.Parse(JsonSerializer.Serialize(handlerResult));
            var result = resultDocument.RootElement;
            if (admission.Phase == "preview")
            {
                OperatorCertifiedMovePreviewAuthority.RequirePreviewResult(result, admission.ElementId, executionStart);
                OperatorCertifiedMovePreviewAuthority.RequireRollbackReadback(app.ActiveUIDocument.Document, admission.ElementId, executionStart);
            }
            else
            {
                OperatorCertifiedMovePreviewAuthority.RequireApplyResult(result, admission.ElementId, executionStart);
                OperatorCertifiedMovePreviewAuthority.RequireApplyReadback(app.ActiveUIDocument.Document, admission.ElementId, executionStart);
            }
            return new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["admission_hash"] = admission.AdmissionHash,
                ["run_nonce"] = admission.RunNonce,
                ["request_family_id"] = admission.RequestFamilyId,
                ["request_family_hash"] = admission.RequestFamilyHash,
                ["request_instance_hash"] = admission.RequestInstanceHash,
                ["admission_session_id"] = admission.AdmissionSessionId,
                ["phase"] = admission.Phase,
                ["effect_id"] = admission.EffectId,
                ["effect_hash"] = admission.EffectHash,
                ["policy_hash"] = admission.PolicyHash,
                ["policy_record_hash"] = admission.PolicyRecordHash,
                ["evidence_record_hash"] = admission.EvidenceRecordHash,
                ["outbound_body_sha256"] = admission.OutboundBodySha256,
                ["document_fingerprint"] = admission.DocumentFingerprint,
                ["document_session_id"] = admission.DocumentSessionId,
                ["source_scoped_id"] = admission.SourceScopedId,
                ["element_id"] = admission.ElementId,
                ["observation_id"] = admission.ObservationId,
                ["observation_binding_hash"] = admission.ObservationBindingHash,
                ["native_attestation_key_id"] = admission.NativeAttestationKeyId,
                ["native_attestation_modulus_base64url"] = admission.NativeAttestationModulusBase64Url,
                ["native_attestation_exponent_base64url"] = admission.NativeAttestationExponentBase64Url,
                ["channel"] = admission.Channel,
                ["alias"] = admission.Alias,
                ["preview_lineage_receipt_hash"] = admission.Lineage?.PreviewExecutionReceiptSha256
            };
        }

        public static void RecordVerifiedPreviewReceipt(
            OperatorLaboratoryMoveEvidenceAdmission admission,
            OperatorLaboratoryEvidenceDispatch laboratoryEvidence,
            OperatorCertifiedMoveExecutionStart executionStart,
            string canonicalSignedReceipt,
            DateTimeOffset issuedAtUtc)
        {
            if (admission.Phase != "preview" || admission.Lineage != null) return;
            var receiptHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(canonicalSignedReceipt);
            var entry = new Entry(admission, laboratoryEvidence, executionStart, issuedAtUtc);
            lock (Gate)
            {
                Prune(issuedAtUtc);
                if (Issued.Count >= MaximumEntries) throw Denied("Laboratory preview ledger is full; no reusable lineage was issued.");
                if (Issued.ContainsKey(receiptHash)) throw Denied("Laboratory preview receipt hash collided with an existing lineage.");
                Issued.Add(receiptHash, entry);
            }
        }

        public static void RecordSuccessfulMoveReceipt(
            OperatorLaboratoryMoveEvidenceAdmission admission,
            OperatorLaboratoryEvidenceDispatch laboratoryEvidence)
        {
            lock (Gate)
            {
                if (!RunsByDocumentSession.TryGetValue(admission.DocumentSessionId, out var run)
                    || run.EvidenceRunId != laboratoryEvidence.EvidenceRunId)
                    throw Denied("Laboratory move completion lost its native document-session run fence.");
                run.Complete(laboratoryEvidence.EvidenceStep, admission.Phase);
            }
        }

        private static void BeginRunFence(
            OperatorLaboratoryMoveEvidenceAdmission admission,
            OperatorLaboratoryEvidenceDispatch laboratoryEvidence,
            OperatorCertifiedMoveExecutionStart start)
        {
            lock (Gate)
            {
                if (!RunsByDocumentSession.TryGetValue(admission.DocumentSessionId, out var run))
                {
                    run = new RunFence(laboratoryEvidence.EvidenceRunId, admission.ElementId,
                        start.StartX, start.StartY, start.StartZ, start.VectorX, start.VectorY, start.VectorZ);
                    RunsByDocumentSession.Add(admission.DocumentSessionId, run);
                }
                if (run.EvidenceRunId != laboratoryEvidence.EvidenceRunId)
                    throw Denied("This native document session is already fenced to a different evidence run; reopen the pristine disposable model before another run.");
                run.Begin(laboratoryEvidence.EvidenceStep, admission.Phase, admission.ElementId, start);
            }
        }

        public static bool IsExactProjection(JsonElement value)
        {
            if (value.ValueKind != JsonValueKind.Object) return false;
            var remaining = new HashSet<string>(ProjectionKeys, StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject()) if (!remaining.Remove(property.Name)) return false;
            return remaining.Count == 0;
        }

        private static bool String(JsonElement value, string name, out string result)
        {
            result = "";
            return value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(result = property.GetString() ?? "");
        }

        private static bool Near(double left, double right) => Math.Abs(left - right) <= 1e-9;
        private static void Prune(DateTimeOffset now)
        {
            var expired = new List<string>();
            foreach (var pair in Issued) if (pair.Value.IssuedAtUtc + MaximumAge < now) expired.Add(pair.Key);
            foreach (var key in expired) Issued.Remove(key);
        }

        private sealed class Entry
        {
            public Entry(OperatorLaboratoryMoveEvidenceAdmission admission, OperatorLaboratoryEvidenceDispatch dispatch,
                OperatorCertifiedMoveExecutionStart start, DateTimeOffset issuedAtUtc)
            {
                PreviewRequestInstanceHash = admission.RequestInstanceHash; CandidateSourceHash = admission.CandidateSourceHash;
                EvidenceRunId = dispatch.EvidenceRunId; AdmissionSessionId = admission.AdmissionSessionId;
                PolicyHash = admission.PolicyHash; PolicyRecordHash = admission.PolicyRecordHash; EvidenceRecordHash = admission.EvidenceRecordHash;
                FamilyId = admission.RequestFamilyId; FamilyHash = admission.RequestFamilyHash;
                DocumentFingerprint = admission.DocumentFingerprint; DocumentSessionId = admission.DocumentSessionId;
                SourceScopedId = admission.SourceScopedId; ElementId = admission.ElementId; ObservationId = admission.ObservationId;
                ObservationBindingHash = admission.ObservationBindingHash; Channel = admission.Channel; Alias = admission.Alias;
                VectorX = start.VectorX; VectorY = start.VectorY; VectorZ = start.VectorZ;
                StartX = start.StartX; StartY = start.StartY; StartZ = start.StartZ; IssuedAtUtc = issuedAtUtc;
            }
            public string PreviewRequestInstanceHash { get; } public string CandidateSourceHash { get; } public string EvidenceRunId { get; }
            public string AdmissionSessionId { get; } public string FamilyId { get; } public string FamilyHash { get; }
            public string PolicyHash { get; } public string PolicyRecordHash { get; } public string EvidenceRecordHash { get; }
            public string DocumentFingerprint { get; } public string DocumentSessionId { get; } public string SourceScopedId { get; }
            public long ElementId { get; } public string ObservationId { get; } public string ObservationBindingHash { get; }
            public string Channel { get; } public string Alias { get; } public double VectorX { get; } public double VectorY { get; }
            public double VectorZ { get; } public double StartX { get; } public double StartY { get; } public double StartZ { get; }
            public DateTimeOffset IssuedAtUtc { get; }
        }

        internal sealed class RunFence
        {
            private int _state;
            public RunFence(string evidenceRunId, long elementId, double startX, double startY, double startZ, double vectorX, double vectorY, double vectorZ)
            {
                EvidenceRunId = evidenceRunId; ElementId = elementId; StartX = startX; StartY = startY; StartZ = startZ;
                VectorX = vectorX; VectorY = vectorY; VectorZ = vectorZ;
            }
            public string EvidenceRunId { get; }
            public long ElementId { get; }
            public double StartX { get; }
            public double StartY { get; }
            public double StartZ { get; }
            public double VectorX { get; }
            public double VectorY { get; }
            public double VectorZ { get; }

            public void Begin(string step, string phase, long elementId, OperatorCertifiedMoveExecutionStart start)
            {
                if (elementId != ElementId) throw Denied("Evidence run changed its fenced disposable target.");
                if (step == "move-preview" && phase == "preview" && _state == 0
                    && Same(start.StartX, StartX) && Same(start.StartY, StartY) && Same(start.StartZ, StartZ)
                    && Same(start.VectorX, VectorX) && Same(start.VectorY, VectorY) && Same(start.VectorZ, VectorZ)) { _state = 1; return; }
                if (step == "move-apply" && phase == "apply" && _state == 2
                    && Same(start.StartX, StartX) && Same(start.StartY, StartY) && Same(start.StartZ, StartZ)
                    && Same(start.VectorX, VectorX) && Same(start.VectorY, VectorY) && Same(start.VectorZ, VectorZ)) { _state = 3; return; }
                var recoveryPreview = step == "restore-preview" || step.StartsWith("recovery-restore-preview", StringComparison.Ordinal);
                if (recoveryPreview && phase == "preview" && (_state == 3 || _state == 4)
                    && Same(start.StartX, StartX + VectorX) && Same(start.StartY, StartY + VectorY) && Same(start.StartZ, StartZ + VectorZ)
                    && Same(start.VectorX, -VectorX) && Same(start.VectorY, -VectorY) && Same(start.VectorZ, -VectorZ)) { _state = 5; return; }
                var recoveryApply = step == "restore-apply" || step.StartsWith("recovery-restore-apply", StringComparison.Ordinal);
                if (recoveryApply && phase == "apply" && _state == 6
                    && Same(start.StartX, StartX + VectorX) && Same(start.StartY, StartY + VectorY) && Same(start.StartZ, StartZ + VectorZ)
                    && Same(start.VectorX, -VectorX) && Same(start.VectorY, -VectorY) && Same(start.VectorZ, -VectorZ)) { _state = 7; return; }
                throw Denied("Laboratory move step is duplicated, out of order, or differs from the native-fenced target/vector state.");
            }

            public void Complete(string step, string phase)
            {
                if (step == "move-preview" && phase == "preview" && _state == 1) { _state = 2; return; }
                if (step == "move-apply" && phase == "apply" && _state == 3) { _state = 4; return; }
                if ((step == "restore-preview" || step.StartsWith("recovery-restore-preview", StringComparison.Ordinal)) && phase == "preview" && _state == 5) { _state = 6; return; }
                if ((step == "restore-apply" || step.StartsWith("recovery-restore-apply", StringComparison.Ordinal)) && phase == "apply" && _state == 7) { _state = 8; return; }
                throw Denied("Laboratory move completion is duplicated or out of order.");
            }

            private static bool Same(double left, double right) => Math.Abs(left - right) <= 1e-9;
        }

        private static OperatorNativeHttpAdmissionException Denied(string message)
            => new OperatorNativeHttpAdmissionException("CERTIFICATION_LABORATORY_MOVE_EVIDENCE_DENIED", message, 403, false, "healthy");
    }
}

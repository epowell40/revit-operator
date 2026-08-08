using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorLaboratoryMoveEvidenceAdmissionTests
    {
        [Fact]
        public void Preview_admission_strictly_binds_dispatch_family_effect_target_key_channel_and_hash()
        {
            using var dispatchDocument = JsonDocument.Parse(DispatchJson());
            var dispatch = OperatorLaboratoryEvidenceDispatch.Parse(dispatchDocument.RootElement);
            var values = PreviewAdmissionValues();
            using var admissionDocument = JsonDocument.Parse(WithAdmissionHash(values));
            var admission = OperatorLaboratoryMoveEvidenceAdmission.Parse(admissionDocument.RootElement, dispatch);
            Assert.Equal("preview", admission.Phase);
            Assert.Equal(42, admission.ElementId);
            Assert.Null(admission.Lineage);

            foreach (var field in new[] { "effect_hash", "alias", "document_session_id", "observation_binding_hash", "native_attestation_key_id" })
            {
                var tampered = new Dictionary<string, object?>(values, StringComparer.Ordinal);
                tampered[field] = field == "alias" ? "revit_call_tool" : "sha256:" + new string('0', 64);
                Assert.Equal("CERTIFICATION_LABORATORY_MOVE_EVIDENCE_INVALID",
                    Assert.Throws<OperatorNativeHttpAdmissionException>(() => Parse(WithAdmissionHash(tampered), dispatch)).Code);
            }

            var staleHash = JsonSerializer.Deserialize<Dictionary<string, object?>>(WithAdmissionHash(values))!;
            staleHash["run_nonce"] = new string('9', 64);
            Assert.Equal("CERTIFICATION_LABORATORY_MOVE_EVIDENCE_INVALID",
                Assert.Throws<OperatorNativeHttpAdmissionException>(() => Parse(JsonSerializer.Serialize(staleHash), dispatch)).Code);
        }

        [Fact]
        public void Apply_lineage_requires_exact_canonical_signed_receipt_bytes_and_hash()
        {
            using var dispatchDocument = JsonDocument.Parse(DispatchJson(OperatorCertifiedRequestFamilyAdmission.MoveOneApplyEffectHash));
            var dispatch = OperatorLaboratoryEvidenceDispatch.Parse(dispatchDocument.RootElement);
            var values = PreviewAdmissionValues();
            values["phase"] = "apply";
            values["effect_id"] = OperatorLaboratoryMoveEvidenceAdmission.ApplyEffectId;
            values["effect_hash"] = OperatorCertifiedRequestFamilyAdmission.MoveOneApplyEffectHash;
            const string receiptJson = "{\"schema\":\"revit-operator.laboratory-execution-receipt.v1\"}";
            values["preview_lineage"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schema"] = OperatorLaboratoryMoveEvidenceAdmission.PreviewLineageSchemaName,
                ["preview_request_instance_hash"] = "sha256:" + new string('1', 64),
                ["preview_execution_receipt_sha256"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(receiptJson),
                ["preview_execution_receipt_json"] = receiptJson
            };
            Assert.NotNull(Parse(WithAdmissionHash(values), dispatch).Lineage);

            var lineage = (Dictionary<string, object?>)values["preview_lineage"]!;
            lineage["preview_execution_receipt_json"] = "{ \"schema\":\"revit-operator.laboratory-execution-receipt.v1\"}";
            lineage["preview_execution_receipt_sha256"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                (string)lineage["preview_execution_receipt_json"]!);
            Assert.Equal("CERTIFICATION_LABORATORY_MOVE_EVIDENCE_INVALID",
                Assert.Throws<OperatorNativeHttpAdmissionException>(() => Parse(WithAdmissionHash(values), dispatch)).Code);
        }

        [Fact]
        public void Native_document_session_run_fence_rejects_duplicate_out_of_order_or_changed_move_graph()
        {
            var fence = new OperatorLaboratoryMoveEvidenceAuthority.RunFence(new string('a', 32), 42, 1, 2, 3, .25, 0, 0);
            var forwardPreview = new OperatorCertifiedMoveExecutionStart("sha256:" + new string('1', 64), "preview", 1, 2, 3, .25, 0, 0);
            fence.Begin("move-preview", "preview", 42, forwardPreview);
            Assert.Throws<OperatorNativeHttpAdmissionException>(() => fence.Begin("move-preview", "preview", 42, forwardPreview));
            fence.Complete("move-preview", "preview");
            var forwardApply = new OperatorCertifiedMoveExecutionStart("sha256:" + new string('2', 64), "apply", 1, 2, 3, .25, 0, 0);
            fence.Begin("move-apply", "apply", 42, forwardApply);
            fence.Complete("move-apply", "apply");
            var inversePreview = new OperatorCertifiedMoveExecutionStart("sha256:" + new string('3', 64), "preview", 1.25, 2, 3, -.25, 0, 0);
            fence.Begin("restore-preview", "preview", 42, inversePreview);
            fence.Complete("restore-preview", "preview");
            var inverseApply = new OperatorCertifiedMoveExecutionStart("sha256:" + new string('4', 64), "apply", 1.25, 2, 3, -.25, 0, 0);
            fence.Begin("restore-apply", "apply", 42, inverseApply);
            fence.Complete("restore-apply", "apply");
            Assert.Throws<OperatorNativeHttpAdmissionException>(() => fence.Begin("move-preview", "preview", 42, forwardPreview));

            var changed = new OperatorLaboratoryMoveEvidenceAuthority.RunFence(new string('b', 32), 42, 1, 2, 3, .25, 0, 0);
            var wrongTarget = new OperatorCertifiedMoveExecutionStart("sha256:" + new string('5', 64), "preview", 1, 2, 3, .5, 0, 0);
            Assert.Throws<OperatorNativeHttpAdmissionException>(() => changed.Begin("move-preview", "preview", 42, wrongTarget));
        }

        private static OperatorLaboratoryMoveEvidenceAdmission Parse(string json, OperatorLaboratoryEvidenceDispatch dispatch)
        {
            using var document = JsonDocument.Parse(json);
            return OperatorLaboratoryMoveEvidenceAdmission.Parse(document.RootElement, dispatch);
        }

        private static Dictionary<string, object?> PreviewAdmissionValues()
        {
            const long elementId = 42;
            var documentFingerprint = "sha256:" + new string('2', 64);
            var documentSession = new string('3', 32);
            const string sourceScopedId = "host:42";
            const string observationId = "observation-1";
            var keyId = OperatorNativeExecutionAttestationAuthority.KeyId;
            var observationHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                observationId + "\n" + documentFingerprint + "\n" + documentSession + "\n" + sourceScopedId + "\n"
                + elementId.ToString(CultureInfo.InvariantCulture) + "\n" + keyId);
            return new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schema"] = OperatorLaboratoryMoveEvidenceAdmission.SchemaName,
                ["candidate_source_hash"] = OperatorLaboratoryEvidenceDispatch.Epic0437CandidateSourceHash,
                ["policy_hash"] = "sha256:" + new string('6', 64),
                ["policy_record_hash"] = "sha256:" + new string('7', 64),
                ["evidence_record_hash"] = "sha256:" + new string('8', 64),
                ["production_certified"] = false,
                ["evidence_run_id"] = new string('b', 32),
                ["run_nonce"] = new string('c', 64),
                ["request_family_id"] = OperatorCertifiedRequestFamilyAdmission.MoveOneFamilyId,
                ["request_family_hash"] = OperatorCertifiedRequestFamilyAdmission.MoveOneFamilyHash,
                ["request_instance_hash"] = "sha256:" + new string('1', 64),
                ["admission_session_id"] = new string('4', 32),
                ["phase"] = "preview",
                ["effect_id"] = OperatorLaboratoryMoveEvidenceAdmission.PreviewEffectId,
                ["effect_hash"] = OperatorCertifiedRequestFamilyAdmission.MoveOnePreviewEffectHash,
                ["method"] = "POST",
                ["path"] = "/revit/move-elements",
                ["outbound_body_sha256"] = "sha256:" + new string('5', 64),
                ["document_fingerprint"] = documentFingerprint,
                ["document_session_id"] = documentSession,
                ["source_scoped_id"] = sourceScopedId,
                ["element_id"] = elementId,
                ["observation_id"] = observationId,
                ["observation_binding_hash"] = observationHash,
                ["native_attestation_key_id"] = keyId,
                ["native_attestation_modulus_base64url"] = OperatorNativeExecutionAttestationAuthority.ModulusBase64Url,
                ["native_attestation_exponent_base64url"] = OperatorNativeExecutionAttestationAuthority.ExponentBase64Url,
                ["channel"] = "typed_mcp",
                ["alias"] = "revit_move_one_certified",
                ["preview_lineage"] = null
            };
        }

        private static string DispatchJson(string? effectHash = null) => JsonSerializer.Serialize(new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["schema"] = OperatorLaboratoryEvidenceDispatch.SchemaName,
            ["candidate_source_hash"] = OperatorLaboratoryEvidenceDispatch.Epic0437CandidateSourceHash,
            ["policy_hash"] = "sha256:" + new string('6', 64),
            ["policy_record_hash"] = "sha256:" + new string('7', 64),
            ["evidence_record_hash"] = "sha256:" + new string('8', 64),
            ["effect_hash"] = effectHash ?? OperatorCertifiedRequestFamilyAdmission.MoveOnePreviewEffectHash,
            ["evidence_run_id"] = new string('b', 32),
            ["evidence_step"] = "move-preview",
            ["transport_kind"] = "direct",
            ["job_id"] = null,
            ["correlation_id"] = null,
            ["workflow"] = "epic-0437-l3-move-preview",
            ["channel"] = "typed_mcp",
            ["alias"] = "revit_move_one_certified",
            ["production_certified"] = false
        });

        private static string WithAdmissionHash(Dictionary<string, object?> values)
        {
            var payload = new Dictionary<string, object?>(values, StringComparer.Ordinal);
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            payload["laboratory_move_evidence_admission_hash"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement));
            return JsonSerializer.Serialize(payload);
        }
    }
}

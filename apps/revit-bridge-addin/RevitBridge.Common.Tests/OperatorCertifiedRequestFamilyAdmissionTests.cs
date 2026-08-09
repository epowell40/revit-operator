using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorCertifiedRequestFamilyAdmissionTests
    {
        private const string Body = "{\"behavior\":\"allOrNothing\",\"dryRun\":true,\"ids\":[42],\"mode\":\"vector\",\"moveTogether\":false,\"options\":{\"failOnPinned\":true,\"unpinIfAllowed\":false},\"vectorX\":1,\"vectorY\":0,\"vectorZ\":0}";

        [Fact]
        public void Reviewed_preview_family_recomputes_exact_observation_body_and_instance_bindings()
        {
            using var document = JsonDocument.Parse(AdmissionJson());
            var admission = OperatorCertifiedRequestFamilyAdmissionVerifier.Parse(document.RootElement);
            OperatorCertifiedRequestFamilyAdmissionVerifier.RequireValidEffectiveBody(admission, Body);

            Assert.Equal(OperatorCertifiedRequestFamilyAdmission.MoveOneFamilyHash, admission.FamilyHash);
            Assert.Equal(OperatorCertifiedRequestFamilyAdmission.MoveOnePreviewEffectHash,
                OperatorCertifiedRequestFamilyAdmissionVerifier.ExpectedEffectHash(admission));
            Assert.Equal(ExpectedRequestInstanceHash(), admission.RequestInstanceHash);
            Assert.Equal(OperatorNativeExecutionAttestationAuthority.KeyId, admission.NativeAttestationKeyId);
            Assert.Throws<InvalidDataException>(() =>
                OperatorCertifiedRequestFamilyAdmissionVerifier.RequireValidEffectiveBody(
                    admission,
                    Body.Replace("\"dryRun\":true", "\"dryRun\":false")));
        }

        [Fact]
        public void Unknown_family_hash_and_caller_authored_preview_lineage_fail_closed()
        {
            using var wrongFamily = JsonDocument.Parse(AdmissionJson().Replace(
                OperatorCertifiedRequestFamilyAdmission.MoveOneFamilyHash,
                "sha256:" + new string('0', 64)));
            Assert.Throws<InvalidDataException>(() => OperatorCertifiedRequestFamilyAdmissionVerifier.Parse(wrongFamily.RootElement));

            using var forgedPreview = JsonDocument.Parse(AdmissionJson().Replace(
                "\"preview_receipt\":null",
                "\"preview_receipt\":\"cmpr1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\""));
            Assert.Throws<InvalidDataException>(() => OperatorCertifiedRequestFamilyAdmissionVerifier.Parse(forgedPreview.RootElement));
        }

        [Fact]
        public void Semantically_equivalent_noncanonical_body_is_rejected_even_when_its_raw_digest_is_bound()
        {
            const string reordered = "{\"dryRun\":true,\"behavior\":\"allOrNothing\",\"ids\":[42],\"mode\":\"vector\",\"moveTogether\":false,\"options\":{\"failOnPinned\":true,\"unpinIfAllowed\":false},\"vectorX\":1,\"vectorY\":0,\"vectorZ\":0}";
            var rawDigest = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(reordered);
            using var document = JsonDocument.Parse(AdmissionJson().Replace(
                "sha256:f087d9f264b40be7b2ea6e4f664cdd669a55828d5c5f6ba044ec86fcc790e24c",
                rawDigest));
            var admission = OperatorCertifiedRequestFamilyAdmissionVerifier.Parse(document.RootElement);

            Assert.Throws<InvalidDataException>(() =>
                OperatorCertifiedRequestFamilyAdmissionVerifier.RequireValidEffectiveBody(admission, reordered));
        }

        [Fact]
        public void Direct_native_envelope_rebinds_protected_channel_and_alias()
        {
            using var admission = JsonDocument.Parse(AdmissionJson());
            var payload = new Dictionary<string, object?>
            {
                ["schema"] = OperatorCourierCertificationEnvelope.FamilySchema,
                ["version"] = 2,
                ["canonicalization"] = OperatorCourierCertificationEnvelope.Canonicalization,
                ["policy_hash"] = "sha256:" + new string('1', 64),
                ["policy_record_hash"] = "sha256:" + new string('2', 64),
                ["evidence_record_hash"] = "sha256:" + new string('3', 64),
                ["request_hash"] = ExpectedRequestInstanceHash(),
                ["effect_hash"] = OperatorCertifiedRequestFamilyAdmission.MoveOnePreviewEffectHash,
                ["method"] = "POST",
                ["path"] = "/revit/move-elements",
                ["body_present"] = true,
                ["body_sha256"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(Body),
                ["channel"] = "typed_mcp",
                ["alias"] = "revit_move_one_certified",
                ["runtime_mode"] = "local",
                ["exposure_profile"] = "certified",
                ["policy_trust_source"] = "deployment",
                ["request_family_admission"] = admission.RootElement.Clone()
            };
            using var payloadDocument = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            payload["envelope_hash"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                OperatorCourierCertificationEnvelopeVerifier.Canonicalize(payloadDocument.RootElement));
            using var envelopeDocument = JsonDocument.Parse(JsonSerializer.Serialize(payload));

            Assert.NotNull(OperatorCourierCertificationEnvelopeVerifier.VerifyDirectEnvelope(
                envelopeDocument.RootElement, "POST", "/revit/move-elements", true, Body, "typed_mcp", "revit_move_one_certified"));
            Assert.Throws<OperatorNativeHttpAdmissionException>(() => OperatorCourierCertificationEnvelopeVerifier.VerifyDirectEnvelope(
                envelopeDocument.RootElement, "POST", "/revit/move-elements", true, Body, "generic_call", "revit_move_one_certified"));
            Assert.Throws<OperatorNativeHttpAdmissionException>(() => OperatorCourierCertificationEnvelopeVerifier.VerifyDirectEnvelope(
                envelopeDocument.RootElement, "POST", "/revit/move-elements", true, Body, "typed_mcp", "revit_call_tool"));
        }

        private static string AdmissionJson()
        {
            var observationBindingHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                "obs-1\nsha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
                + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nhost:42\n42\n"
                + OperatorNativeExecutionAttestationAuthority.KeyId);
            return "{"
                + "\"schema\":\"revit-operator.certified-request-family-admission.v1\","
                + "\"family_id\":\"revit-operator.certified-move-one.request-family.v1\","
                + "\"family_hash\":\"sha256:24906494c42d86326cfba2c4b76318e8172f83f9cb65cd8aa0c84f7e1281e0de\","
                + "\"request_instance_hash\":\"" + ExpectedRequestInstanceHash() + "\","
                + "\"admission_session_id\":\"cccccccccccccccccccccccccccccccc\","
                + "\"phase\":\"preview\",\"preview_instance_hash\":null,\"preview_receipt\":null,\"preview_receipt_hash\":null,"
                + "\"document_fingerprint\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
                + "\"document_session_id\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\","
                + "\"source_scoped_id\":\"host:42\",\"element_id\":42,\"observation_id\":\"obs-1\","
                + "\"observation_binding_hash\":\"" + observationBindingHash + "\","
                + "\"native_attestation_key_id\":\"" + OperatorNativeExecutionAttestationAuthority.KeyId + "\","
                + "\"native_attestation_modulus_base64url\":\"" + OperatorNativeExecutionAttestationAuthority.ModulusBase64Url + "\","
                + "\"native_attestation_exponent_base64url\":\"" + OperatorNativeExecutionAttestationAuthority.ExponentBase64Url + "\","
                + "\"outbound_body_sha256\":\"sha256:f087d9f264b40be7b2ea6e4f664cdd669a55828d5c5f6ba044ec86fcc790e24c\"}";
        }

        private static string ExpectedRequestInstanceHash()
        {
            var observationBindingHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                "obs-1\nsha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
                + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nhost:42\n42\n"
                + OperatorNativeExecutionAttestationAuthority.KeyId);
            var request = "{\"documentFingerprint\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\""
                + ",\"documentSessionId\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\""
                + ",\"elementId\":42"
                + ",\"nativeAttestationExponentBase64Url\":\"" + OperatorNativeExecutionAttestationAuthority.ExponentBase64Url + "\""
                + ",\"nativeAttestationKeyId\":\"" + OperatorNativeExecutionAttestationAuthority.KeyId + "\""
                + ",\"nativeAttestationModulusBase64Url\":\"" + OperatorNativeExecutionAttestationAuthority.ModulusBase64Url + "\""
                + ",\"observationBindingHash\":\"" + observationBindingHash + "\""
                + ",\"observationId\":\"obs-1\",\"phase\":\"preview\",\"sourceScopedId\":\"host:42\""
                + ",\"vectorFeet\":{\"x\":1,\"y\":0,\"z\":0}}";
            return OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                "{\"admissionSessionId\":\"cccccccccccccccccccccccccccccccc\""
                + ",\"familyHash\":\"" + OperatorCertifiedRequestFamilyAdmission.MoveOneFamilyHash + "\""
                + ",\"outboundBody\":" + Body + ",\"request\":" + request + "}");
        }
    }
}

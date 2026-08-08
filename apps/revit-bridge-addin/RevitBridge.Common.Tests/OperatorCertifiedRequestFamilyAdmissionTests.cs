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
            Assert.Equal("sha256:e60d81e84f446b280d1d63feab562b4a96e35b4ba4410d79eae4891c84bfe82a", admission.RequestInstanceHash);
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

        private static string AdmissionJson()
        {
            return "{"
                + "\"schema\":\"revit-operator.certified-request-family-admission.v1\","
                + "\"family_id\":\"revit-operator.certified-move-one.request-family.v1\","
                + "\"family_hash\":\"sha256:cef4b3d5613abd85772cb844a91376d057d7f835a0c4691d7c461bb010bf460b\","
                + "\"request_instance_hash\":\"sha256:e60d81e84f446b280d1d63feab562b4a96e35b4ba4410d79eae4891c84bfe82a\","
                + "\"admission_session_id\":\"cccccccccccccccccccccccccccccccc\","
                + "\"phase\":\"preview\",\"preview_instance_hash\":null,\"preview_receipt\":null,\"preview_receipt_hash\":null,"
                + "\"document_fingerprint\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
                + "\"document_session_id\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\","
                + "\"source_scoped_id\":\"host:42\",\"element_id\":42,\"observation_id\":\"obs-1\","
                + "\"observation_binding_hash\":\"sha256:f4ea0aba33994c3cf3d8d862146346328fd4f43a7c106ff632dbe1ceee67959f\","
                + "\"outbound_body_sha256\":\"sha256:f087d9f264b40be7b2ea6e4f664cdd669a55828d5c5f6ba044ec86fcc790e24c\"}";
        }
    }
}

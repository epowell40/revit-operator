using System;
using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeExecutionAttestationAuthorityTests
    {
        [Fact]
        public void Process_local_key_signs_exact_canonical_receipt_and_rejects_tamper()
        {
            var modulus = OperatorNativeExecutionAttestationAuthority.ModulusBase64Url
                .Replace('-', '+').Replace('_', '/');
            modulus += new string('=', (4 - modulus.Length % 4) % 4);
            Assert.Equal(256, Convert.FromBase64String(modulus).Length);

            var payload = new Dictionary<string, object?>
            {
                ["schema"] = "revit-operator.certified-family-execution-receipt.v1",
                ["request_instance_hash"] = "sha256:" + new string('a', 64),
                ["outcome"] = "rolled_back"
            };
            var signature = OperatorNativeExecutionAttestationAuthority.SignCanonicalPayload(payload);
            Assert.True(OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayload(payload, signature));
            payload["outcome"] = "committed";
            Assert.False(OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayload(payload, signature));
            Assert.Equal(
                OperatorNativeExecutionAttestationAuthority.KeyId,
                OperatorNativeExecutionAttestationAuthority.ComputeKeyId(
                    OperatorNativeExecutionAttestationAuthority.ModulusBase64Url,
                    OperatorNativeExecutionAttestationAuthority.ExponentBase64Url));
        }

        [Fact]
        public void Signed_execution_receipt_covers_preview_lineage_and_transport_identity()
        {
            var payload = new Dictionary<string, object?>
            {
                ["schema"] = "revit-operator.certified-family-execution-receipt.v1",
                ["transport_kind"] = "courier",
                ["dispatch_id"] = "job-a",
                ["correlation_id"] = "job-a",
                ["execution_session_id"] = "session-a",
                ["executor_id"] = "executor-a",
                ["certification_envelope_hash"] = "sha256:" + new string('a', 64),
                ["completion_challenge_hash"] = "sha256:" + new string('b', 64),
                ["preview_receipt_schema"] = OperatorCertifiedMovePreviewAuthority.ReceiptSchema,
                ["preview_receipt_hash"] = "sha256:" + new string('c', 64),
                ["preview_instance_hash"] = "sha256:" + new string('d', 64),
                ["preview_admission_session_id"] = "admission-a",
                ["preview_issued_at_utc"] = "2026-08-08T12:00:00.000Z"
            };
            var signature = OperatorNativeExecutionAttestationAuthority.SignCanonicalPayload(payload);
            Assert.True(OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayload(payload, signature));

            payload["transport_kind"] = "direct";
            Assert.False(OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayload(payload, signature));
            payload["transport_kind"] = "courier";
            payload["preview_instance_hash"] = "sha256:" + new string('e', 64);
            Assert.False(OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayload(payload, signature));
        }

        [Fact]
        public void Only_a_current_native_signed_result_can_survive_recovered_dialog_classification()
        {
            var result = new Dictionary<string, object?>
            {
                ["status"] = "Moved",
                ["movedIds"] = new[] { 42L },
                ["skipped"] = System.Array.Empty<object>(),
                ["warnings"] = System.Array.Empty<string>(),
                ["snapshots"] = new[]
                {
                    new Dictionary<string, object?>
                    {
                        ["id"] = 42L,
                        ["before"] = new { kind = "LocationPoint", pointXyz = new[] { 0d, 0d, 0d } },
                        ["after"] = new { kind = "LocationPoint", pointXyz = new[] { 1d, 0d, 0d } }
                    }
                },
                ["movedTogether"] = false,
                ["rolledBack"] = false
            };
            string resultHash;
            using (var resultDocument = System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(result)))
                resultHash = OperatorCertifiedMovePreviewAuthority.ComputeCertifiedMoveResultHash(resultDocument.RootElement);
            var receipt = new Dictionary<string, object?>
            {
                ["schema"] = "revit-operator.certified-family-execution-receipt.v1",
                ["phase"] = "apply",
                ["native_attestation_key_id"] = OperatorNativeExecutionAttestationAuthority.KeyId,
                ["outcome_unknown"] = false,
                ["result_hash"] = resultHash,
                ["preview_receipt_schema"] = null,
                ["preview_receipt_hash"] = null,
                ["preview_instance_hash"] = null,
                ["preview_admission_session_id"] = null,
                ["preview_issued_at_utc"] = null
            };
            receipt["native_attestation_signature"] =
                OperatorNativeExecutionAttestationAuthority.SignCanonicalPayload(receipt);
            result["certified_execution_receipt"] = receipt;

            Assert.True(OperatorCertifiedMovePreviewAuthority.IsIndependentlyVerifiedCertifiedFamilyResult(result));
            result["status"] = "Dry Run";
            Assert.False(OperatorCertifiedMovePreviewAuthority.IsIndependentlyVerifiedCertifiedFamilyResult(result));
        }
    }
}

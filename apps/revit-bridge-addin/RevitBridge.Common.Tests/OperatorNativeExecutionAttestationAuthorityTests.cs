using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
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

        [Fact]
        public void Laboratory_receipt_rejects_body_effect_alias_document_session_result_and_signature_tamper()
        {
            Assert.True(OperatorLaboratoryExecutionReceiptAuthority.VerifyAttachedReceipt(LaboratoryResult()));

            foreach (var field in new[]
            {
                "canonical_body_sha256", "effect_hash", "alias", "document_fingerprint", "document_session_id"
            })
            {
                var tampered = LaboratoryResult();
                ((Dictionary<string, object?>)tampered[OperatorLaboratoryExecutionReceiptAuthority.ResultField]!)[field] =
                    "sha256:" + new string('f', 64);
                Assert.False(OperatorLaboratoryExecutionReceiptAuthority.VerifyAttachedReceipt(tampered));
            }

            var resultTamper = LaboratoryResult();
            resultTamper["count"] = 2;
            Assert.False(OperatorLaboratoryExecutionReceiptAuthority.VerifyAttachedReceipt(resultTamper));

            var signatureTamper = LaboratoryResult();
            ((Dictionary<string, object?>)signatureTamper[OperatorLaboratoryExecutionReceiptAuthority.ResultField]!)["native_attestation_signature"] =
                "AAAA";
            Assert.False(OperatorLaboratoryExecutionReceiptAuthority.VerifyAttachedReceipt(signatureTamper));
        }

        [Fact]
        public void Laboratory_receipt_public_verifier_refuses_1024_bit_key_and_nonstandard_exponent()
        {
            var payload = new Dictionary<string, object?> { ["schema"] = OperatorLaboratoryExecutionReceiptAuthority.Schema };
            var modulus1024 = Convert.ToBase64String(new byte[128]).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            Assert.False(OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayloadWithPublicBinding(
                payload,
                "AAAA",
                OperatorNativeExecutionAttestationAuthority.ComputeKeyId(modulus1024, "AQAB"),
                modulus1024,
                "AQAB"));
            Assert.False(OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayloadWithPublicBinding(
                payload,
                "AAAA",
                OperatorNativeExecutionAttestationAuthority.KeyId,
                OperatorNativeExecutionAttestationAuthority.ModulusBase64Url,
                "Aw"));
        }

        [Fact]
        public void Laboratory_receipt_structurally_cross_checks_signed_dispatch_channel_and_transport_identity()
        {
            var result = LaboratoryResult();
            var receipt = (Dictionary<string, object?>)result[OperatorLaboratoryExecutionReceiptAuthority.ResultField]!;
            var dispatch = (Dictionary<string, object?>)receipt["laboratory_evidence"]!;
            dispatch["alias"] = "revit_read_move_targets_certified";
            using (var dispatchDocument = JsonDocument.Parse(JsonSerializer.Serialize(dispatch)))
                receipt["laboratory_evidence_hash"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(dispatchDocument.RootElement));
            receipt.Remove("native_attestation_signature");
            receipt["native_attestation_signature"] = OperatorNativeExecutionAttestationAuthority.SignCanonicalPayload(receipt);
            Assert.False(OperatorLaboratoryExecutionReceiptAuthority.VerifyAttachedReceipt(result));

            result = LaboratoryResult();
            receipt = (Dictionary<string, object?>)result[OperatorLaboratoryExecutionReceiptAuthority.ResultField]!;
            dispatch = (Dictionary<string, object?>)receipt["laboratory_evidence"]!;
            dispatch["transport_kind"] = "courier";
            dispatch["job_id"] = new string('7', 64);
            dispatch["correlation_id"] = new string('7', 64);
            using (var dispatchDocument = JsonDocument.Parse(JsonSerializer.Serialize(dispatch)))
                receipt["laboratory_evidence_hash"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(dispatchDocument.RootElement));
            receipt.Remove("native_attestation_signature");
            receipt["native_attestation_signature"] = OperatorNativeExecutionAttestationAuthority.SignCanonicalPayload(receipt);
            Assert.False(OperatorLaboratoryExecutionReceiptAuthority.VerifyAttachedReceipt(result));
        }

        [Fact]
        public void Laboratory_lane_rejects_caller_authored_reserved_receipt_field()
        {
            var error = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorLaboratoryExecutionReceiptAuthority.RequireNoCallerAuthoredReceipt(
                    true,
                    "{\"laboratory_execution_receipt\":{}}"));
            Assert.Equal("CERTIFICATION_LABORATORY_EXECUTION_EVIDENCE_DENIED", error.Code);
        }

        private static Dictionary<string, object?> LaboratoryResult()
        {
            var result = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["status"] = "ok",
                ["count"] = 1
            };
            string resultHash;
            using (var resultDocument = JsonDocument.Parse(JsonSerializer.Serialize(result)))
                resultHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(resultDocument.RootElement));
            var receipt = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schema"] = OperatorLaboratoryExecutionReceiptAuthority.Schema,
                ["request_id"] = new string('a', 32),
                ["dispatch_id"] = new string('a', 32),
                ["transport_request_nonce"] = new string('b', 32),
                ["transport_server_epoch"] = new string('c', 32),
                ["transport_issued_at_utc"] = "2026-08-08T12:00:00.000Z",
                ["laboratory_evidence"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["schema"] = OperatorLaboratoryEvidenceDispatch.SchemaName,
                    ["candidate_source_hash"] = OperatorLaboratoryEvidenceDispatch.Epic0437CandidateSourceHash,
                    ["policy_hash"] = "sha256:" + new string('4', 64),
                    ["policy_record_hash"] = "sha256:" + new string('5', 64),
                    ["evidence_record_hash"] = "sha256:" + new string('6', 64),
                    ["effect_hash"] = "sha256:" + new string('1', 64),
                    ["evidence_run_id"] = new string('8', 32),
                    ["evidence_step"] = "observation",
                    ["transport_kind"] = "direct",
                    ["job_id"] = null,
                    ["correlation_id"] = null,
                    ["workflow"] = "epic-0437-l3-observation",
                    ["channel"] = "typed_mcp",
                    ["alias"] = "revit_observe_model",
                    ["production_certified"] = false
                },
                ["laboratory_evidence_hash"] = "",
                ["laboratory_move_evidence"] = null,
                ["method"] = "POST",
                ["path"] = "/revit/export-visible-elements",
                ["body_present"] = true,
                ["raw_body_sha256"] = "sha256:" + new string('d', 64),
                ["canonical_body_sha256"] = "sha256:" + new string('e', 64),
                ["phase"] = "read",
                ["effect_id"] = "POST /revit/export-visible-elements#read",
                ["effect_hash"] = "sha256:" + new string('1', 64),
                ["channel"] = "typed_mcp",
                ["alias"] = "revit_observe_model",
                ["document_fingerprint"] = "sha256:" + new string('2', 64),
                ["document_session_id"] = new string('3', 32),
                ["revit_process_id"] = 4242,
                ["revit_process_start_utc"] = "2026-08-08T12:00:00.000Z",
                ["revit_process_image_path"] = @"C:\Program Files\Autodesk\Revit 2024\Revit.exe",
                ["native_common_assembly_path"] = @"C:\Operator\RevitBridge.Common.dll",
                ["native_common_assembly_sha256"] = "sha256:" + new string('7', 64),
                ["native_logic_assembly_path"] = @"C:\Operator\RevitBridge.Logic.dll",
                ["native_logic_assembly_sha256"] = "sha256:" + new string('8', 64),
                ["native_bridge_assembly_path"] = @"C:\Operator\RevitBridge.dll",
                ["native_bridge_assembly_sha256"] = "sha256:" + new string('9', 64),
                ["native_runtime_dependencies"] = new[]
                {
                    "Microsoft.Bcl.AsyncInterfaces.dll", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "Microsoft.Web.WebView2.Wpf.dll",
                    "RevitBridge.Common.dll", "RevitBridge.dll", "RevitBridge.Logic.dll", "System.Buffers.dll", "System.Memory.dll", "System.Numerics.Vectors.dll",
                    "System.Runtime.CompilerServices.Unsafe.dll", "System.Security.Cryptography.ProtectedData.dll", "System.Text.Encodings.Web.dll", "System.Text.Json.dll",
                    "System.Threading.Tasks.Extensions.dll", "System.ValueTuple.dll", "WebView2Loader.dll"
                }.Select((name, index) => new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["name"] = name, ["path"] = @"C:\Operator\" + name,
                    ["sha256"] = "sha256:" + index.ToString("x", CultureInfo.InvariantCulture).PadLeft(64, '0')
                }).ToArray(),
                ["native_runtime_dependencies_hash"] = "",
                ["native_attestation_algorithm"] = OperatorNativeExecutionAttestationAuthority.Algorithm,
                ["native_attestation_key_id"] = OperatorNativeExecutionAttestationAuthority.KeyId,
                ["native_attestation_modulus_base64url"] = OperatorNativeExecutionAttestationAuthority.ModulusBase64Url,
                ["native_attestation_exponent_base64url"] = OperatorNativeExecutionAttestationAuthority.ExponentBase64Url,
                ["result_hash"] = resultHash,
                ["outcome"] = "read_completed",
                ["outcome_unknown"] = false,
                ["issued_at_utc"] = "2026-08-08T12:00:01.000Z"
            };
            using (var laboratoryDocument = JsonDocument.Parse(JsonSerializer.Serialize(receipt["laboratory_evidence"])))
                receipt["laboratory_evidence_hash"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(laboratoryDocument.RootElement));
            using (var dependenciesDocument = JsonDocument.Parse(JsonSerializer.Serialize(receipt["native_runtime_dependencies"])))
                receipt["native_runtime_dependencies_hash"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(dependenciesDocument.RootElement));
            receipt["native_attestation_signature"] =
                OperatorNativeExecutionAttestationAuthority.SignCanonicalPayload(receipt);
            result[OperatorLaboratoryExecutionReceiptAuthority.ResultField] = receipt;
            return result;
        }
    }
}

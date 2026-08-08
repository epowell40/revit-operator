using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Common
{
    /// <summary>
    /// Native-only evidence for the explicitly selected protected laboratory lane.
    /// This is execution evidence, not a production certification decision.
    /// </summary>
    public static class OperatorLaboratoryExecutionReceiptAuthority
    {
        public const string Schema = "revit-operator.laboratory-execution-receipt.v1";
        public const string ResultField = "laboratory_execution_receipt";
        private static readonly string CourierProcessEpoch = RandomBase64Url(32);

        public static OperatorLaboratoryCourierReceiptContext BeginCourierExecution(
            OperatorLaboratoryEvidenceDispatch laboratoryEvidence,
            OperatorLaboratoryMoveEvidenceAdmission? moveAdmission,
            string method,
            string path,
            string bodyJson)
        {
            if (laboratoryEvidence == null || laboratoryEvidence.TransportKind != "courier"
                || laboratoryEvidence.JobId == null || laboratoryEvidence.CorrelationId == null
                || laboratoryEvidence.JobId != laboratoryEvidence.CorrelationId)
                throw Denied("Courier laboratory execution requires exact authenticated job/correlation identity.");
            RequireExactLaboratoryLane();
            OperatorNativeToolExposureEmbeddedAuthority.Instance.RequireLaboratoryEvidenceAuthorized(
                laboratoryEvidence, method, path, laboratoryEvidence.Channel, laboratoryEvidence.Alias, moveAdmission);
            var bodyPresent = string.Equals(method, "POST", StringComparison.Ordinal);
            var bytes = new UTF8Encoding(false, true).GetBytes(bodyJson ?? "");
            var request = OperatorNativeHttpRequestFence.Prepare(
                method, path, false, bodyPresent, bytes, laboratoryEvidence.CorrelationId,
                laboratoryEvidence.Channel, laboratoryEvidence.Alias);
            RequireNoCallerAuthoredReceipt(request.BodyPresent, request.BodyJson);
            var isMove = request.Method == "POST" && request.Path == "/revit/move-elements";
            if (isMove != (moveAdmission != null))
                throw Denied(isMove
                    ? "Courier laboratory move requires its exact reviewed family admission."
                    : "Courier move evidence admission is forbidden for every other route.");
            if (moveAdmission != null)
            {
                if (moveAdmission.EvidenceRunId != laboratoryEvidence.EvidenceRunId
                    || moveAdmission.CandidateSourceHash != laboratoryEvidence.CandidateSourceHash
                    || moveAdmission.Channel != laboratoryEvidence.Channel || moveAdmission.Alias != laboratoryEvidence.Alias)
                    throw Denied("Courier laboratory move admission changed its dispatch identity.");
                _ = moveAdmission.RequireValidEffectiveBody(request.BodyJson);
            }
            var nativeContext = new OperatorNativeTransportRequestContext(
                request,
                RandomBase64Url(32),
                CourierProcessEpoch,
                "",
                DateTimeOffset.UtcNow,
                laboratoryEvidence,
                moveAdmission);
            return new OperatorLaboratoryCourierReceiptContext(nativeContext);
        }

        public static object AttachAfterRevitThreadCompletion(
            UIApplication app,
            object result,
            OperatorLaboratoryCourierReceiptContext courierContext,
            DateTimeOffset issuedAtUtc,
            OperatorCertifiedMoveExecutionStart? laboratoryMoveExecutionStart = null)
        {
            if (courierContext == null) throw new ArgumentNullException(nameof(courierContext));
            return AttachAfterRevitThreadCompletion(
                app, result, courierContext.NativeTransportContext, issuedAtUtc, laboratoryMoveExecutionStart);
        }

        public static object AttachAfterRevitThreadCompletion(
            UIApplication app,
            object result,
            OperatorNativeTransportRequestContext transport,
            DateTimeOffset issuedAtUtc,
            OperatorCertifiedMoveExecutionStart? laboratoryMoveExecutionStart = null)
        {
            if (app == null) throw new ArgumentNullException(nameof(app));
            if (transport == null) throw new ArgumentNullException(nameof(transport));
            var request = transport.Request;
            if (request == null) throw new ArgumentNullException(nameof(request));
            RequireNoCallerAuthoredReceipt(request.BodyPresent, request.BodyJson);
            if (request.CertificationEnvelope != null)
                throw Denied("Protected laboratory evidence cannot carry a certification envelope or request-family admission.");
            if (transport.LaboratoryEvidence == null)
                throw Denied("Protected laboratory evidence is missing authenticated evidence dispatch metadata.");

            using var resultDocument = JsonDocument.Parse(JsonSerializer.Serialize(result));
            if (resultDocument.RootElement.ValueKind != JsonValueKind.Object)
                throw Denied("Protected laboratory evidence requires an object-shaped native handler result.");
            if (resultDocument.RootElement.TryGetProperty(ResultField, out _))
                throw Denied("Native handler result attempted to author the reserved laboratory receipt field.");

            var document = app.ActiveUIDocument?.Document;
            if (document == null || !document.IsValidObject)
                throw Denied("Protected laboratory evidence requires a current active Revit document.");

            var phase = DerivePhase(request.Method, request.Path, request.BodyPresent, request.BodyJson);
            var outcome = RequireSuccessfulOutcome(phase, resultDocument.RootElement);
            var canonicalResult = OperatorCourierCertificationEnvelopeVerifier.Canonicalize(resultDocument.RootElement);
            var resultHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(canonicalResult);
            var canonicalBody = CanonicalBody(request.BodyPresent, request.BodyJson);
            var effectId = DeriveEffectId(request.Method, request.Path, phase);
            var effectPayload = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["effect_id"] = effectId,
                ["method"] = request.Method,
                ["path"] = request.Path,
                ["phase"] = phase
            };
            using var effectDocument = JsonDocument.Parse(JsonSerializer.Serialize(effectPayload));
            var effectHash = DeriveEffectHash(request.Path, phase, effectDocument.RootElement);
            Dictionary<string, object?>? moveProjection = null;
            if (transport.LaboratoryMoveEvidenceAdmission != null)
            {
                if (laboratoryMoveExecutionStart == null)
                    throw Denied("Laboratory move evidence is missing its native pre-dispatch state.");
                moveProjection = OperatorLaboratoryMoveEvidenceAuthority.BuildProjectionAfterResult(
                    app, result, transport.LaboratoryMoveEvidenceAdmission, transport.LaboratoryEvidence,
                    laboratoryMoveExecutionStart, request.BodyJson);
                if (transport.LaboratoryMoveEvidenceAdmission.Phase != phase
                    || transport.LaboratoryMoveEvidenceAdmission.EffectId != effectId
                    || transport.LaboratoryMoveEvidenceAdmission.EffectHash != effectHash)
                    throw Denied("Laboratory move admission does not match the natively derived phase and effect.");
            }
            else if (string.Equals(request.Path, "/revit/move-elements", StringComparison.Ordinal))
            {
                throw Denied("Laboratory move evidence requires its exact reviewed family admission.");
            }

            string? projectUniqueId = null;
            try { projectUniqueId = document.ProjectInformation?.UniqueId; } catch { }
            var documentFingerprint = "sha256:" + OperatorRevitBatchBinding.ComputeProjectFingerprint(
                document.Title,
                document.PathName,
                projectUniqueId);
            using var hostProcess = Process.GetCurrentProcess();
            var processImagePath = hostProcess.MainModule?.FileName;
            if (string.IsNullOrWhiteSpace(processImagePath) || !File.Exists(processImagePath))
                throw Denied("Protected laboratory evidence cannot identify the exact Revit host process image.");

            var receipt = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schema"] = Schema,
                ["request_id"] = request.RequestId,
                ["dispatch_id"] = request.RequestId,
                ["transport_request_nonce"] = transport.RequestNonce,
                ["transport_server_epoch"] = transport.ServerEpoch,
                ["transport_issued_at_utc"] = transport.IssuedAtUtc.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                ["laboratory_evidence"] = transport.LaboratoryEvidence.CanonicalObject.Clone(),
                ["laboratory_evidence_hash"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(transport.LaboratoryEvidence.CanonicalObject)),
                ["laboratory_move_evidence"] = moveProjection,
                ["method"] = request.Method,
                ["path"] = request.Path,
                ["body_present"] = request.BodyPresent,
                ["raw_body_sha256"] = request.SourceBodySha256,
                ["canonical_body_sha256"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(canonicalBody),
                ["phase"] = phase,
                ["effect_id"] = effectId,
                ["effect_hash"] = effectHash,
                ["channel"] = request.Channel,
                ["alias"] = request.Alias,
                ["document_fingerprint"] = documentFingerprint,
                ["document_session_id"] = OperatorNativeDocumentSessionAuthority.GetSessionId(document),
                ["revit_process_id"] = hostProcess.Id,
                ["revit_process_start_utc"] = hostProcess.StartTime.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                ["revit_process_image_path"] = Path.GetFullPath(processImagePath),
                ["native_common_assembly_path"] = LoadedAssemblyPath("RevitBridge.Common"),
                ["native_common_assembly_sha256"] = LoadedAssemblySha256("RevitBridge.Common"),
                ["native_logic_assembly_path"] = LoadedAssemblyPath("RevitBridge.Logic"),
                ["native_logic_assembly_sha256"] = LoadedAssemblySha256("RevitBridge.Logic"),
                ["native_bridge_assembly_path"] = LoadedAssemblyPath("RevitBridge"),
                ["native_bridge_assembly_sha256"] = LoadedAssemblySha256("RevitBridge"),
                ["native_attestation_algorithm"] = OperatorNativeExecutionAttestationAuthority.Algorithm,
                ["native_attestation_key_id"] = OperatorNativeExecutionAttestationAuthority.KeyId,
                ["native_attestation_modulus_base64url"] = OperatorNativeExecutionAttestationAuthority.ModulusBase64Url,
                ["native_attestation_exponent_base64url"] = OperatorNativeExecutionAttestationAuthority.ExponentBase64Url,
                ["result_hash"] = resultHash,
                ["outcome"] = outcome,
                ["outcome_unknown"] = false,
                ["issued_at_utc"] = issuedAtUtc.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
            };
            receipt["native_attestation_signature"] =
                OperatorNativeExecutionAttestationAuthority.SignCanonicalPayload(receipt);
            using (var receiptDocument = JsonDocument.Parse(JsonSerializer.Serialize(receipt)))
            {
                var canonicalSignedReceipt = OperatorCourierCertificationEnvelopeVerifier.Canonicalize(receiptDocument.RootElement);
                if (transport.LaboratoryMoveEvidenceAdmission != null)
                    OperatorLaboratoryMoveEvidenceAuthority.RecordVerifiedPreviewReceipt(
                        transport.LaboratoryMoveEvidenceAdmission,
                        transport.LaboratoryEvidence,
                        laboratoryMoveExecutionStart!,
                        canonicalSignedReceipt,
                        issuedAtUtc);
            }

            var attached = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var property in resultDocument.RootElement.EnumerateObject())
                attached.Add(property.Name, property.Value.Clone());
            attached.Add(ResultField, receipt);
            return attached;
        }

        public static void RequireNoCallerAuthoredReceipt(bool bodyPresent, string bodyJson)
        {
            if (!bodyPresent) return;
            using var document = JsonDocument.Parse(bodyJson);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty(ResultField, out _))
                throw Denied("Caller-authored laboratory execution receipts are forbidden.");
        }

        private static string LoadedAssemblySha256(string simpleName)
        {
            using var stream = File.Open(LoadedAssemblyPath(simpleName), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var algorithm = SHA256.Create();
            var hash = algorithm.ComputeHash(stream);
            return "sha256:" + BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
        }

        private static string LoadedAssemblyPath(string simpleName)
        {
            var matches = AppDomain.CurrentDomain.GetAssemblies()
                .Where(value => string.Equals(value.GetName().Name, simpleName, StringComparison.Ordinal))
                .ToList();
            if (matches.Count != 1 || string.IsNullOrWhiteSpace(matches[0].Location) || !File.Exists(matches[0].Location))
                throw Denied("Protected laboratory evidence cannot identify the exact loaded " + simpleName + " binary.");
            return Path.GetFullPath(matches[0].Location);
        }

        public static bool VerifyAttachedReceipt(object attachedResult)
        {
            try
            {
                using var document = JsonDocument.Parse(JsonSerializer.Serialize(attachedResult));
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty(ResultField, out var receipt)
                    || receipt.ValueKind != JsonValueKind.Object
                    || !VerifyReceipt(receipt,
                        OperatorNativeExecutionAttestationAuthority.KeyId,
                        OperatorNativeExecutionAttestationAuthority.ModulusBase64Url,
                        OperatorNativeExecutionAttestationAuthority.ExponentBase64Url))
                    return false;

                var nativeResult = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var property in root.EnumerateObject())
                    if (property.Name != ResultField) nativeResult.Add(property.Name, property.Value.Clone());
                using var nativeResultDocument = JsonDocument.Parse(JsonSerializer.Serialize(nativeResult));
                return String(receipt, "result_hash", out var resultHash)
                    && resultHash == OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                        OperatorCourierCertificationEnvelopeVerifier.Canonicalize(nativeResultDocument.RootElement));
            }
            catch { return false; }
        }

        /// <summary>
        /// Strict receipt-only verification against an independently trusted
        /// native key binding. The receipt's self-presented RSA material is
        /// never treated as the trust root.
        /// </summary>
        public static bool VerifyReceipt(
            JsonElement receipt,
            string expectedKeyId,
            string expectedModulusBase64Url,
            string expectedExponentBase64Url)
        {
            try
            {
                if (!HasExactReceiptKeys(receipt)
                    || !String(receipt, "native_attestation_signature", out var signature)
                    || !String(receipt, "schema", out var schema) || schema != Schema
                    || !String(receipt, "native_attestation_algorithm", out var algorithm)
                    || algorithm != OperatorNativeExecutionAttestationAuthority.Algorithm
                    || !String(receipt, "native_attestation_key_id", out var keyId) || keyId != expectedKeyId
                    || !String(receipt, "native_attestation_modulus_base64url", out var modulus) || modulus != expectedModulusBase64Url
                    || !String(receipt, "native_attestation_exponent_base64url", out var exponent) || exponent != expectedExponentBase64Url
                    || !receipt.TryGetProperty("laboratory_evidence", out var laboratoryEvidence)
                    || !String(receipt, "laboratory_evidence_hash", out var laboratoryEvidenceHash)
                    || laboratoryEvidenceHash != OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                        OperatorCourierCertificationEnvelopeVerifier.Canonicalize(laboratoryEvidence))
                    || !receipt.TryGetProperty("laboratory_move_evidence", out var moveEvidence)
                    || (moveEvidence.ValueKind != JsonValueKind.Null && !OperatorLaboratoryMoveEvidenceAuthority.IsExactProjection(moveEvidence))
                    || !Boolean(receipt, "outcome_unknown", out var unknown) || unknown)
                    return false;
                var dispatch = OperatorLaboratoryEvidenceDispatch.Parse(laboratoryEvidence);
                if (!String(receipt, "channel", out var receiptChannel) || receiptChannel != dispatch.Channel
                    || !String(receipt, "alias", out var receiptAlias) || receiptAlias != dispatch.Alias
                    || !String(receipt, "request_id", out var requestId)
                    || !String(receipt, "dispatch_id", out var dispatchId)) return false;
                if (dispatch.TransportKind == "direct")
                {
                    if (dispatch.JobId != null || dispatch.CorrelationId != null || requestId != dispatchId) return false;
                }
                else if (requestId != dispatch.CorrelationId || dispatchId != dispatch.JobId) return false;
                if (!String(receipt, "path", out var path)
                    || !String(receipt, "phase", out var phase)
                    || !String(receipt, "effect_id", out var effectId)
                    || !String(receipt, "effect_hash", out var effectHash)
                    || effectHash != dispatch.EffectHash
                    || !String(receipt, "document_fingerprint", out var documentFingerprint)
                    || !String(receipt, "document_session_id", out var documentSessionId)
                    || !receipt.TryGetProperty("revit_process_id", out var processId) || processId.ValueKind != JsonValueKind.Number || !processId.TryGetInt32(out var parsedProcessId) || parsedProcessId <= 0
                    || !String(receipt, "revit_process_start_utc", out _)
                    || !String(receipt, "revit_process_image_path", out _)
                    || !String(receipt, "native_common_assembly_path", out _)
                    || !String(receipt, "native_common_assembly_sha256", out _)
                    || !String(receipt, "native_logic_assembly_path", out _)
                    || !String(receipt, "native_logic_assembly_sha256", out _)
                    || !String(receipt, "native_bridge_assembly_path", out _)
                    || !String(receipt, "native_bridge_assembly_sha256", out _)) return false;
                if (moveEvidence.ValueKind == JsonValueKind.Null)
                {
                    if (path == "/revit/move-elements") return false;
                }
                else if (path != "/revit/move-elements"
                    || !Matches(moveEvidence, "phase", phase)
                    || !Matches(moveEvidence, "effect_id", effectId)
                    || !Matches(moveEvidence, "effect_hash", effectHash)
                    || !Matches(moveEvidence, "policy_hash", dispatch.PolicyHash)
                    || !Matches(moveEvidence, "policy_record_hash", dispatch.PolicyRecordHash)
                    || !Matches(moveEvidence, "evidence_record_hash", dispatch.EvidenceRecordHash)
                    || !Matches(moveEvidence, "channel", receiptChannel)
                    || !Matches(moveEvidence, "alias", receiptAlias)
                    || !Matches(moveEvidence, "document_fingerprint", documentFingerprint)
                    || !Matches(moveEvidence, "document_session_id", documentSessionId)
                    || !Matches(moveEvidence, "native_attestation_key_id", expectedKeyId)
                    || !Matches(moveEvidence, "native_attestation_modulus_base64url", expectedModulusBase64Url)
                    || !Matches(moveEvidence, "native_attestation_exponent_base64url", expectedExponentBase64Url)) return false;
                var signedPayload = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var property in receipt.EnumerateObject())
                    if (property.Name != "native_attestation_signature") signedPayload.Add(property.Name, property.Value.Clone());
                return OperatorNativeExecutionAttestationAuthority.VerifyCanonicalPayloadWithPublicBinding(
                    signedPayload, signature, expectedKeyId, expectedModulusBase64Url, expectedExponentBase64Url);
            }
            catch { return false; }
        }

        private static string DerivePhase(string method, string path, bool bodyPresent, string bodyJson)
        {
            if (string.Equals(path, "/revit/move-elements", StringComparison.Ordinal))
            {
                if (!string.Equals(method, "POST", StringComparison.Ordinal) || !bodyPresent)
                    throw Denied("Laboratory move evidence requires exact POST body semantics.");
                using var document = JsonDocument.Parse(bodyJson);
                if (document.RootElement.ValueKind != JsonValueKind.Object
                    || !document.RootElement.TryGetProperty("dryRun", out var dryRun)
                    || (dryRun.ValueKind != JsonValueKind.True && dryRun.ValueKind != JsonValueKind.False))
                    throw Denied("Laboratory move evidence requires an explicit boolean dryRun phase selector.");
                return dryRun.GetBoolean() ? "preview" : "apply";
            }
            if (string.Equals(method, "GET", StringComparison.Ordinal)
                || string.Equals(path, "/revit/context", StringComparison.Ordinal)
                || string.Equals(path, "/revit/export-visible-elements", StringComparison.Ordinal))
                return "read";
            return "apply";
        }

        private static string RequireSuccessfulOutcome(string phase, JsonElement result)
        {
            if (result.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.False)
                throw Denied("Failed native results cannot receive successful laboratory execution evidence.");
            if (phase == "preview")
            {
                if (!result.TryGetProperty("rolledBack", out var rolledBack)
                    || rolledBack.ValueKind != JsonValueKind.True)
                    throw Denied("Preview evidence requires a native result proving rollback.");
                return "rolled_back";
            }
            if (phase == "apply")
            {
                if (result.TryGetProperty("rolledBack", out var rolledBack)
                    && rolledBack.ValueKind != JsonValueKind.False)
                    throw Denied("Apply evidence cannot claim a rolled-back or ambiguous mutation result.");
                return "committed";
            }
            return "read_completed";
        }

        private static string DeriveEffectId(string method, string path, string phase)
        {
            if (phase == "read") return "revit-operator.spatial-observation-readback.effect.v1";
            if (string.Equals(path, "/revit/move-elements", StringComparison.Ordinal))
                return phase == "preview"
                    ? "revit-operator.certified-move-one.preview.effect.v1"
                    : "revit-operator.certified-move-one.apply.effect.v1";
            return method + " " + path + "#" + phase;
        }

        private static string DeriveEffectHash(string path, string phase, JsonElement genericEffect)
        {
            // These are the independently reviewed candidate effect identities.
            // Native code selects one only after deriving the route/body phase.
            if (phase == "read")
                return "sha256:0f19ae675c51b10854e3977070ad34e4898a004c4a724058f933c17233f37bf8";
            if (string.Equals(path, "/revit/move-elements", StringComparison.Ordinal))
                return phase == "preview"
                    ? "sha256:4b9d9a0b4beb537b1db23b84aa3a2319497c0250fcc55ede2d87107d06ae428b"
                    : "sha256:4da2bf877ae0747d17dec5123defd1912193bd2b9c59b57f7dd8d4aa7b7e1e7b";
            return OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                OperatorCourierCertificationEnvelopeVerifier.Canonicalize(genericEffect));
        }

        private static string CanonicalBody(bool bodyPresent, string bodyJson)
        {
            if (!bodyPresent) return "";
            using var document = JsonDocument.Parse(bodyJson);
            return OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement);
        }

        private static void RequireExactLaboratoryLane()
        {
            if (!string.Equals(Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE"), "development", StringComparison.Ordinal)
                || !string.Equals(Environment.GetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE"), "laboratory", StringComparison.Ordinal)
                || !string.Equals(Environment.GetEnvironmentVariable("OPERATOR_CERTIFICATION_PROTECTED_LABORATORY"), "1", StringComparison.Ordinal))
                throw Denied("Courier laboratory execution is forbidden outside the exact protected development/laboratory lane.");
        }

        private static string RandomBase64Url(int byteCount)
        {
            var bytes = new byte[byteCount];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private static bool HasExactReceiptKeys(JsonElement receipt)
        {
            var expected = new HashSet<string>(new[]
            {
                "schema", "request_id", "dispatch_id", "transport_request_nonce", "transport_server_epoch",
                "transport_issued_at_utc", "laboratory_evidence", "laboratory_evidence_hash",
                "laboratory_move_evidence", "method", "path", "body_present",
                "raw_body_sha256", "canonical_body_sha256", "phase", "effect_id", "effect_hash",
                "channel", "alias", "document_fingerprint", "document_session_id",
                "revit_process_id", "revit_process_start_utc", "revit_process_image_path",
                "native_common_assembly_path", "native_common_assembly_sha256",
                "native_logic_assembly_path", "native_logic_assembly_sha256",
                "native_bridge_assembly_path", "native_bridge_assembly_sha256",
                "native_attestation_algorithm", "native_attestation_key_id",
                "native_attestation_modulus_base64url", "native_attestation_exponent_base64url",
                "result_hash", "outcome", "outcome_unknown", "issued_at_utc", "native_attestation_signature"
            }, StringComparer.Ordinal);
            foreach (var property in receipt.EnumerateObject())
                if (!expected.Remove(property.Name)) return false;
            return expected.Count == 0;
        }

        private static bool String(JsonElement value, string name, out string result)
        {
            result = "";
            return value.TryGetProperty(name, out var property)
                && property.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(result = property.GetString() ?? "");
        }

        private static bool Boolean(JsonElement value, string name, out bool result)
        {
            result = false;
            if (!value.TryGetProperty(name, out var property)
                || (property.ValueKind != JsonValueKind.True && property.ValueKind != JsonValueKind.False)) return false;
            result = property.GetBoolean();
            return true;
        }

        private static bool Matches(JsonElement value, string name, string expected)
            => String(value, name, out var actual) && actual == expected;

        private static OperatorNativeHttpAdmissionException Denied(string message)
            => new OperatorNativeHttpAdmissionException(
                "CERTIFICATION_LABORATORY_EXECUTION_EVIDENCE_DENIED",
                message,
                403,
                false,
                "healthy");
    }

    public sealed class OperatorLaboratoryCourierReceiptContext
    {
        internal OperatorLaboratoryCourierReceiptContext(OperatorNativeTransportRequestContext nativeTransportContext)
            => NativeTransportContext = nativeTransportContext ?? throw new ArgumentNullException(nameof(nativeTransportContext));
        internal OperatorNativeTransportRequestContext NativeTransportContext { get; }
        public OperatorLaboratoryEvidenceDispatch LaboratoryEvidence => NativeTransportContext.LaboratoryEvidence!;
        public OperatorLaboratoryMoveEvidenceAdmission? LaboratoryMoveEvidenceAdmission => NativeTransportContext.LaboratoryMoveEvidenceAdmission;
        public string NativeActionNonce => NativeTransportContext.RequestNonce;
        public string NativeProcessEpoch => NativeTransportContext.ServerEpoch;
        public DateTimeOffset IssuedAtUtc => NativeTransportContext.IssuedAtUtc;
    }
}

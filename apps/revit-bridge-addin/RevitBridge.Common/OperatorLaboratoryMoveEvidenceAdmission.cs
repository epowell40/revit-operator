using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    /// <summary>
    /// A laboratory-only, non-production admission for the one reviewed move
    /// request family. The protected transport authenticates this exact object;
    /// native code then independently validates every binding and the effective
    /// handler body. It is never accepted as a certification envelope.
    /// </summary>
    public sealed class OperatorLaboratoryMoveEvidenceAdmission
    {
        public const string SchemaName = "revit-operator.laboratory-move-evidence-admission.v1";
        public const string PreviewLineageSchemaName = "revit-operator.laboratory-move-preview-lineage.v1";
        public const string PreviewEffectId = "revit-operator.certified-move-one.preview.effect.v1";
        public const string ApplyEffectId = "revit-operator.certified-move-one.apply.effect.v1";

        private static readonly Regex Sha256 = new Regex("^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant);
        private static readonly Regex Hex32 = new Regex("^[0-9a-f]{32}$", RegexOptions.CultureInvariant);
        private static readonly Regex Hex64 = new Regex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
        private static readonly HashSet<string> Keys = Set(
            "schema", "candidate_source_hash", "policy_hash", "policy_record_hash", "evidence_record_hash", "production_certified", "evidence_run_id", "run_nonce",
            "request_family_id", "request_family_hash", "request_instance_hash", "admission_session_id",
            "phase", "effect_id", "effect_hash", "method", "path", "outbound_body_sha256",
            "document_fingerprint", "document_session_id", "source_scoped_id", "element_id", "observation_id",
            "observation_binding_hash", "native_attestation_key_id", "native_attestation_modulus_base64url",
            "native_attestation_exponent_base64url", "channel", "alias", "preview_lineage",
            "laboratory_move_evidence_admission_hash");
        private static readonly HashSet<string> LineageKeys = Set(
            "schema", "preview_request_instance_hash", "preview_execution_receipt_sha256",
            "preview_execution_receipt_json");

        private OperatorLaboratoryMoveEvidenceAdmission() { }

        public string CandidateSourceHash { get; private set; } = "";
        public string PolicyHash { get; private set; } = "";
        public string PolicyRecordHash { get; private set; } = "";
        public string EvidenceRecordHash { get; private set; } = "";
        public string EvidenceRunId { get; private set; } = "";
        public string RunNonce { get; private set; } = "";
        public string RequestFamilyId { get; private set; } = "";
        public string RequestFamilyHash { get; private set; } = "";
        public string RequestInstanceHash { get; private set; } = "";
        public string AdmissionSessionId { get; private set; } = "";
        public string Phase { get; private set; } = "";
        public string EffectId { get; private set; } = "";
        public string EffectHash { get; private set; } = "";
        public string OutboundBodySha256 { get; private set; } = "";
        public string DocumentFingerprint { get; private set; } = "";
        public string DocumentSessionId { get; private set; } = "";
        public string SourceScopedId { get; private set; } = "";
        public long ElementId { get; private set; }
        public string ObservationId { get; private set; } = "";
        public string ObservationBindingHash { get; private set; } = "";
        public string NativeAttestationKeyId { get; private set; } = "";
        public string NativeAttestationModulusBase64Url { get; private set; } = "";
        public string NativeAttestationExponentBase64Url { get; private set; } = "";
        public string Channel { get; private set; } = "";
        public string Alias { get; private set; } = "";
        public PreviewLineage? Lineage { get; private set; }
        public string AdmissionHash { get; private set; } = "";
        public JsonElement CanonicalObject { get; private set; }

        public static OperatorLaboratoryMoveEvidenceAdmission Parse(
            JsonElement value,
            OperatorLaboratoryEvidenceDispatch laboratoryEvidence)
        {
            if (laboratoryEvidence == null) throw Invalid("Move evidence admission is missing its laboratory dispatch binding.");
            RequireExactKeys(value, Keys, "move evidence admission");
            RequireString(value, "schema", SchemaName);
            RequireBoolean(value, "production_certified", false);
            var candidateSourceHash = RequireString(value, "candidate_source_hash", 71);
            var policyHash = RequireHash(value, "policy_hash");
            var policyRecordHash = RequireHash(value, "policy_record_hash");
            var evidenceRecordHash = RequireHash(value, "evidence_record_hash");
            var evidenceRunId = RequireString(value, "evidence_run_id", 32);
            if (candidateSourceHash != OperatorLaboratoryEvidenceDispatch.Epic0437CandidateSourceHash
                || candidateSourceHash != laboratoryEvidence.CandidateSourceHash
                || evidenceRunId != laboratoryEvidence.EvidenceRunId
                || policyHash != laboratoryEvidence.PolicyHash || policyRecordHash != laboratoryEvidence.PolicyRecordHash
                || evidenceRecordHash != laboratoryEvidence.EvidenceRecordHash)
                throw Invalid("Move evidence admission does not bind the exact reviewed candidate source and evidence run.");
            var runNonce = RequireString(value, "run_nonce", 64);
            if (!Hex64.IsMatch(runNonce)) throw Invalid("Move evidence run nonce is invalid.");
            var familyId = RequireString(value, "request_family_id", 256);
            var familyHash = RequireHash(value, "request_family_hash");
            if (familyId != OperatorCertifiedRequestFamilyAdmission.MoveOneFamilyId
                || familyHash != OperatorCertifiedRequestFamilyAdmission.MoveOneFamilyHash)
                throw Invalid("Move evidence admission names an unreviewed request family.");
            var requestInstanceHash = RequireHash(value, "request_instance_hash");
            var admissionSessionId = RequireString(value, "admission_session_id", 32);
            if (!Hex32.IsMatch(admissionSessionId)) throw Invalid("Move evidence admission session is invalid.");
            var phase = RequireString(value, "phase", 16);
            if (phase != "preview" && phase != "apply") throw Invalid("Move evidence phase is invalid.");
            var effectId = RequireString(value, "effect_id", 256);
            var effectHash = RequireHash(value, "effect_hash");
            var expectedEffectId = phase == "preview" ? PreviewEffectId : ApplyEffectId;
            var expectedEffectHash = phase == "preview"
                ? OperatorCertifiedRequestFamilyAdmission.MoveOnePreviewEffectHash
                : OperatorCertifiedRequestFamilyAdmission.MoveOneApplyEffectHash;
            if (effectId != expectedEffectId || effectHash != expectedEffectHash || effectHash != laboratoryEvidence.EffectHash)
                throw Invalid("Move evidence effect does not match its exact native phase.");
            RequireString(value, "method", "POST");
            RequireString(value, "path", "/revit/move-elements");
            var outboundBodySha256 = RequireHash(value, "outbound_body_sha256");
            var documentFingerprint = RequireHash(value, "document_fingerprint");
            var documentSessionId = RequireNfc(value, "document_session_id", 256);
            var sourceScopedId = RequireNfc(value, "source_scoped_id", 1024);
            var elementId = RequireSafeElementId(value);
            var observationId = RequireNfc(value, "observation_id", 1024);
            var observationBindingHash = RequireHash(value, "observation_binding_hash");
            var keyId = RequireHash(value, "native_attestation_key_id");
            var modulus = RequireString(value, "native_attestation_modulus_base64url", 512);
            var exponent = RequireString(value, "native_attestation_exponent_base64url", 16);
            RequireCurrentNativeKey(keyId, modulus, exponent);
            var expectedObservationBinding = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                observationId + "\n" + documentFingerprint + "\n" + documentSessionId + "\n" + sourceScopedId + "\n"
                + elementId.ToString(CultureInfo.InvariantCulture) + "\n" + keyId);
            if (observationBindingHash != expectedObservationBinding)
                throw Invalid("Move evidence observation does not bind the exact document/session/source/target/key lineage.");
            RequireString(value, "channel", "typed_mcp");
            RequireString(value, "alias", "revit_move_one_certified");
            if (laboratoryEvidence.Channel != "typed_mcp" || laboratoryEvidence.Alias != "revit_move_one_certified")
                throw Invalid("Move evidence admission does not match the authenticated dispatch channel and alias.");
            var lineage = ParseLineage(value, phase);
            var admissionHash = RequireHash(value, "laboratory_move_evidence_admission_hash");
            var hashPayload = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
                if (property.Name != "laboratory_move_evidence_admission_hash") hashPayload.Add(property.Name, property.Value.Clone());
            using (var hashDocument = JsonDocument.Parse(JsonSerializer.Serialize(hashPayload)))
            {
                var expectedAdmissionHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(hashDocument.RootElement));
                if (admissionHash != expectedAdmissionHash) throw Invalid("Move evidence admission hash is invalid.");
            }
            using var canonicalDocument = JsonDocument.Parse(OperatorCourierCertificationEnvelopeVerifier.Canonicalize(value));
            return new OperatorLaboratoryMoveEvidenceAdmission
            {
                CandidateSourceHash = candidateSourceHash, PolicyHash = policyHash, PolicyRecordHash = policyRecordHash,
                EvidenceRecordHash = evidenceRecordHash, EvidenceRunId = evidenceRunId, RunNonce = runNonce,
                RequestFamilyId = familyId, RequestFamilyHash = familyHash, RequestInstanceHash = requestInstanceHash,
                AdmissionSessionId = admissionSessionId, Phase = phase, EffectId = effectId, EffectHash = effectHash,
                OutboundBodySha256 = outboundBodySha256, DocumentFingerprint = documentFingerprint,
                DocumentSessionId = documentSessionId, SourceScopedId = sourceScopedId, ElementId = elementId,
                ObservationId = observationId, ObservationBindingHash = observationBindingHash,
                NativeAttestationKeyId = keyId, NativeAttestationModulusBase64Url = modulus,
                NativeAttestationExponentBase64Url = exponent, Channel = "typed_mcp", Alias = "revit_move_one_certified",
                Lineage = lineage, AdmissionHash = admissionHash, CanonicalObject = canonicalDocument.RootElement.Clone()
            };
        }

        public OperatorCertifiedRequestFamilyAdmission RequireValidEffectiveBody(string effectiveBodyJson)
        {
            var admission = new OperatorCertifiedRequestFamilyAdmission
            {
                FamilyId = RequestFamilyId, FamilyHash = RequestFamilyHash, RequestInstanceHash = RequestInstanceHash,
                AdmissionSessionId = AdmissionSessionId, Phase = Phase,
                PreviewInstanceHash = Lineage?.PreviewRequestInstanceHash,
                PreviewReceiptHash = Lineage?.PreviewExecutionReceiptSha256,
                DocumentFingerprint = DocumentFingerprint, DocumentSessionId = DocumentSessionId,
                SourceScopedId = SourceScopedId, ObservationId = ObservationId,
                ObservationBindingHash = ObservationBindingHash, NativeAttestationKeyId = NativeAttestationKeyId,
                NativeAttestationModulusBase64Url = NativeAttestationModulusBase64Url,
                NativeAttestationExponentBase64Url = NativeAttestationExponentBase64Url,
                ElementId = ElementId, OutboundBodySha256 = OutboundBodySha256
            };
            OperatorCertifiedRequestFamilyAdmissionVerifier.RequireValidEffectiveBody(admission, effectiveBodyJson);
            return admission;
        }

        public sealed class PreviewLineage
        {
            internal PreviewLineage(string requestHash, string receiptHash, string receiptJson)
            { PreviewRequestInstanceHash = requestHash; PreviewExecutionReceiptSha256 = receiptHash; PreviewExecutionReceiptJson = receiptJson; }
            public string PreviewRequestInstanceHash { get; }
            public string PreviewExecutionReceiptSha256 { get; }
            public string PreviewExecutionReceiptJson { get; }
        }

        private static PreviewLineage? ParseLineage(JsonElement value, string phase)
        {
            if (!value.TryGetProperty("preview_lineage", out var lineage)) throw Invalid("Move evidence preview lineage is missing.");
            if (phase == "preview")
            {
                if (lineage.ValueKind != JsonValueKind.Null) throw Invalid("Preview move evidence cannot carry apply lineage.");
                return null;
            }
            RequireExactKeys(lineage, LineageKeys, "move preview lineage");
            RequireString(lineage, "schema", PreviewLineageSchemaName);
            var requestHash = RequireHash(lineage, "preview_request_instance_hash");
            var receiptHash = RequireHash(lineage, "preview_execution_receipt_sha256");
            var receiptJson = RequireString(lineage, "preview_execution_receipt_json", 256 * 1024);
            if (receiptJson != receiptJson.Normalize(NormalizationForm.FormC)
                || OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(receiptJson) != receiptHash)
                throw Invalid("Move evidence preview receipt bytes do not match their exact lineage hash.");
            try
            {
                using var receiptDocument = JsonDocument.Parse(receiptJson);
                if (OperatorCourierCertificationEnvelopeVerifier.Canonicalize(receiptDocument.RootElement) != receiptJson)
                    throw Invalid("Move evidence preview receipt is not canonical JSON.");
            }
            catch (JsonException) { throw Invalid("Move evidence preview receipt JSON is invalid."); }
            return new PreviewLineage(requestHash, receiptHash, receiptJson);
        }

        private static void RequireCurrentNativeKey(string keyId, string modulus, string exponent)
        {
            byte[] modulusBytes;
            byte[] exponentBytes;
            try { modulusBytes = DecodeBase64Url(modulus); exponentBytes = DecodeBase64Url(exponent); }
            catch { throw Invalid("Move evidence native key encoding is invalid."); }
            if (modulusBytes.Length != 256 || !exponentBytes.SequenceEqual(new byte[] { 1, 0, 1 })
                || OperatorNativeExecutionAttestationAuthority.ComputeKeyId(modulus, exponent) != keyId
                || keyId != OperatorNativeExecutionAttestationAuthority.KeyId
                || modulus != OperatorNativeExecutionAttestationAuthority.ModulusBase64Url
                || exponent != OperatorNativeExecutionAttestationAuthority.ExponentBase64Url)
                throw Invalid("Move evidence native key is not the current 2048-bit Revit process authority.");
        }

        private static byte[] DecodeBase64Url(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Any(c => !(char.IsLetterOrDigit(c) || c == '-' || c == '_'))) throw new FormatException();
            var normalized = value.Replace('-', '+').Replace('_', '/');
            if (normalized.Length % 4 == 2) normalized += "==";
            else if (normalized.Length % 4 == 3) normalized += "=";
            else if (normalized.Length % 4 != 0) throw new FormatException();
            return Convert.FromBase64String(normalized);
        }

        private static long RequireSafeElementId(JsonElement value)
        {
            if (!value.TryGetProperty("element_id", out var element) || element.ValueKind != JsonValueKind.Number
                || !element.TryGetInt64(out var id) || id <= 0 || id > 9_007_199_254_740_991L) throw Invalid("Move evidence element id is invalid.");
            return id;
        }

        private static string RequireHash(JsonElement value, string name)
        {
            var result = RequireString(value, name, 71);
            if (!Sha256.IsMatch(result)) throw Invalid("Move evidence hash is invalid.");
            return result;
        }

        private static string RequireNfc(JsonElement value, string name, int maximumUtf8Bytes)
        {
            var result = RequireString(value, name, maximumUtf8Bytes);
            if (result != result.Normalize(NormalizationForm.FormC)) throw Invalid("Move evidence text is not NFC-normalized.");
            return result;
        }

        private static string RequireString(JsonElement value, string name, int maximumUtf8Bytes)
        {
            if (!value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String) throw Invalid("Move evidence string is missing.");
            var result = property.GetString() ?? "";
            if (result.Length == 0 || Encoding.UTF8.GetByteCount(result) > maximumUtf8Bytes) throw Invalid("Move evidence string is invalid.");
            return result;
        }

        private static void RequireString(JsonElement value, string name, string exact)
        { if (RequireString(value, name, Encoding.UTF8.GetByteCount(exact)) != exact) throw Invalid("Move evidence constant is invalid."); }

        private static void RequireBoolean(JsonElement value, string name, bool exact)
        {
            if (!value.TryGetProperty(name, out var property)
                || (property.ValueKind != JsonValueKind.True && property.ValueKind != JsonValueKind.False)
                || property.GetBoolean() != exact) throw Invalid("Move evidence boolean is invalid.");
        }

        private static void RequireExactKeys(JsonElement value, HashSet<string> expected, string location)
        {
            if (value.ValueKind != JsonValueKind.Object) throw Invalid("Native " + location + " must be an object.");
            var remaining = new HashSet<string>(expected, StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject()) if (!remaining.Remove(property.Name)) throw Invalid("Native " + location + " contains unknown or duplicate fields.");
            if (remaining.Count != 0) throw Invalid("Native " + location + " is missing required fields.");
        }

        private static HashSet<string> Set(params string[] names) => new HashSet<string>(names, StringComparer.Ordinal);
        private static OperatorNativeHttpAdmissionException Invalid(string message)
            => new OperatorNativeHttpAdmissionException("CERTIFICATION_LABORATORY_MOVE_EVIDENCE_INVALID", message, 403, false, "healthy");
    }
}

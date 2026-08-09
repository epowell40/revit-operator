using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    public sealed class OperatorLaboratoryEvidenceDispatch
    {
        public const string SchemaName = "revit-operator.laboratory-evidence-dispatch.v2";
        public const string Epic0437CandidateSourceHash = "sha256:daec4b624b7a0ca07d67fe78bd4f56bf5e5277e7254dfcddf0acc31c344604cc";
        private static readonly Regex Hash = new Regex("^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant);
        private static readonly Regex Hex32 = new Regex("^[0-9a-f]{32}$", RegexOptions.CultureInvariant);
        private static readonly Regex Hex64 = new Regex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
        private static readonly HashSet<string> Keys = new HashSet<string>(new[]
        {
            "schema", "candidate_source_hash", "policy_hash", "policy_record_hash", "evidence_record_hash", "effect_hash", "evidence_run_id", "evidence_step", "transport_kind",
            "job_id", "correlation_id", "workflow", "channel", "alias", "production_certified"
        }, StringComparer.Ordinal);

        private OperatorLaboratoryEvidenceDispatch(
            string candidateSourceHash,
            string policyHash,
            string policyRecordHash,
            string evidenceRecordHash,
            string effectHash,
            string evidenceRunId,
            string evidenceStep,
            string transportKind,
            string? jobId,
            string? correlationId,
            string workflow,
            string channel,
            string alias,
            JsonElement canonicalObject)
        {
            CandidateSourceHash = candidateSourceHash;
            PolicyHash = policyHash;
            PolicyRecordHash = policyRecordHash;
            EvidenceRecordHash = evidenceRecordHash;
            EffectHash = effectHash;
            EvidenceRunId = evidenceRunId;
            EvidenceStep = evidenceStep;
            TransportKind = transportKind;
            JobId = jobId;
            CorrelationId = correlationId;
            Workflow = workflow;
            Channel = channel;
            Alias = alias;
            CanonicalObject = canonicalObject;
        }

        public string CandidateSourceHash { get; }
        public string PolicyHash { get; }
        public string PolicyRecordHash { get; }
        public string EvidenceRecordHash { get; }
        public string EffectHash { get; }
        public string EvidenceRunId { get; }
        public string EvidenceStep { get; }
        public string TransportKind { get; }
        public string? JobId { get; }
        public string? CorrelationId { get; }
        public string Workflow { get; }
        public string Channel { get; }
        public string Alias { get; }
        public JsonElement CanonicalObject { get; }

        public static OperatorLaboratoryEvidenceDispatch Parse(JsonElement value)
        {
            if (value.ValueKind != JsonValueKind.Object) throw Invalid();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
                if (!Keys.Contains(property.Name) || !seen.Add(property.Name)) throw Invalid();
            if (seen.Count != Keys.Count
                || String(value, "schema", 128) != SchemaName
                || Boolean(value, "production_certified")) throw Invalid();
            var candidateSourceHash = String(value, "candidate_source_hash", 71);
            var policyHash = String(value, "policy_hash", 71);
            var policyRecordHash = String(value, "policy_record_hash", 71);
            var evidenceRecordHash = String(value, "evidence_record_hash", 71);
            var effectHash = String(value, "effect_hash", 71);
            var evidenceRunId = String(value, "evidence_run_id", 32);
            var evidenceStep = NormalizedString(value, "evidence_step", 128);
            var transportKind = String(value, "transport_kind", 16);
            var workflow = NormalizedString(value, "workflow", 256);
            var channel = NormalizedString(value, "channel", 32);
            var alias = NormalizedString(value, "alias", 128);
            if (candidateSourceHash != Epic0437CandidateSourceHash || !Hash.IsMatch(policyHash)
                || !Hash.IsMatch(policyRecordHash) || !Hash.IsMatch(evidenceRecordHash) || !Hash.IsMatch(effectHash) || !Hex32.IsMatch(evidenceRunId)
                || (transportKind != "direct" && transportKind != "courier")) throw Invalid();
            var jobId = NullableString(value, "job_id", 64);
            var correlationId = NullableString(value, "correlation_id", 64);
            if (transportKind == "direct")
            {
                if (jobId != null || correlationId != null) throw Invalid();
            }
            else if (jobId == null || correlationId == null || jobId != correlationId || !Hex64.IsMatch(jobId))
            {
                throw Invalid();
            }
            using var canonical = JsonDocument.Parse(OperatorCourierCertificationEnvelopeVerifier.Canonicalize(value));
            return new OperatorLaboratoryEvidenceDispatch(
                candidateSourceHash, policyHash, policyRecordHash, evidenceRecordHash, effectHash,
                evidenceRunId, evidenceStep, transportKind, jobId, correlationId,
                workflow, channel, alias, canonical.RootElement.Clone());
        }

        private static string String(JsonElement value, string name, int maximumUtf8Bytes)
        {
            if (!value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String)
                throw Invalid();
            var result = property.GetString() ?? "";
            if (result.Length == 0 || Encoding.UTF8.GetByteCount(result) > maximumUtf8Bytes) throw Invalid();
            return result;
        }

        private static string NormalizedString(JsonElement value, string name, int maximumUtf8Bytes)
        {
            var result = String(value, name, maximumUtf8Bytes);
            if (result != result.Normalize(NormalizationForm.FormC)) throw Invalid();
            return result;
        }

        private static string? NullableString(JsonElement value, string name, int maximumUtf8Bytes)
        {
            if (!value.TryGetProperty(name, out var property)) throw Invalid();
            if (property.ValueKind == JsonValueKind.Null) return null;
            if (property.ValueKind != JsonValueKind.String) throw Invalid();
            var result = property.GetString() ?? "";
            if (result.Length == 0 || Encoding.UTF8.GetByteCount(result) > maximumUtf8Bytes) throw Invalid();
            return result;
        }

        private static bool Boolean(JsonElement value, string name)
        {
            if (!value.TryGetProperty(name, out var property)
                || (property.ValueKind != JsonValueKind.True && property.ValueKind != JsonValueKind.False)) throw Invalid();
            return property.GetBoolean();
        }

        private static OperatorNativeHttpAdmissionException Invalid()
            => new OperatorNativeHttpAdmissionException(
                "CERTIFICATION_LABORATORY_EVIDENCE_DISPATCH_INVALID",
                "Protected laboratory evidence dispatch metadata is invalid.",
                403,
                false,
                "healthy");
    }
}

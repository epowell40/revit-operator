using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    /// <summary>
    /// Immutable, verified certification facts carried by a v2 courier job.
    /// This is deliberately a transport verifier, not a policy authority: the
    /// workstation must still compare these facts to its current trusted policy
    /// immediately before it calls Revit.
    /// </summary>
    public sealed class OperatorCourierCertificationEnvelope
    {
        public const string Schema = "revit-operator.revit-tool-certification-envelope.v1";
        public const string Canonicalization = "revit-operator.canonical-json.nfc-key-sorted.v1";
        public const string JobVersion = "revit-operator.revit-tool-job.v2";
        public const string IdempotencySchema = "revit-operator.revit-tool-job-idempotency.v2";

        public string EnvelopeSchema { get; internal set; } = Schema;
        public int Version { get; internal set; } = 1;
        public string CanonicalizationVersion { get; internal set; } = Canonicalization;
        public string PolicyHash { get; internal set; } = "";
        public string PolicyRecordHash { get; internal set; } = "";
        public string EvidenceRecordHash { get; internal set; } = "";
        public string RequestHash { get; internal set; } = "";
        public string EffectHash { get; internal set; } = "";
        public string Method { get; internal set; } = "";
        public string Path { get; internal set; } = "";
        public bool BodyPresent { get; internal set; }
        public string BodySha256 { get; internal set; } = "";
        public string Channel { get; internal set; } = "";
        public string Alias { get; internal set; } = "";
        public string? Workflow { get; internal set; }
        public string RuntimeMode { get; internal set; } = "";
        public string ExposureProfile { get; internal set; } = "certified";
        public string PolicyTrustSource { get; internal set; } = "";
        public string EnvelopeHash { get; internal set; } = "";
    }

    /// <summary>
    /// Pure validation output for a courier worker. A false result is terminal
    /// no-execute input; callers must not retry it as an ordinary Revit error.
    /// ParsedBody is populated only after every hash and binding check passes.
    /// </summary>
    public sealed class OperatorCourierCertificationEnvelopeValidationResult
    {
        public bool IsValid { get; internal set; }
        public string Code { get; internal set; } = "CERT_COURIER_ENVELOPE_INVALID";
        public string Error { get; internal set; } = "Courier certification envelope is invalid.";
        public OperatorCourierCertificationEnvelope? Envelope { get; internal set; }
        public JsonElement? ParsedBody { get; internal set; }
        public string? IdempotencyKey { get; internal set; }

        internal static OperatorCourierCertificationEnvelopeValidationResult Invalid(string code, string error)
        {
            return new OperatorCourierCertificationEnvelopeValidationResult
            {
                IsValid = false,
                Code = code,
                Error = error
            };
        }

        internal static OperatorCourierCertificationEnvelopeValidationResult Valid(
            OperatorCourierCertificationEnvelope envelope,
            JsonElement? parsedBody,
            string idempotencyKey)
        {
            return new OperatorCourierCertificationEnvelopeValidationResult
            {
                IsValid = true,
                Code = "CERT_COURIER_ENVELOPE_VALID",
                Error = "",
                Envelope = envelope,
                ParsedBody = parsedBody,
                IdempotencyKey = idempotencyKey
            };
        }
    }

    /// <summary>
    /// Verifies the immutable v2 courier envelope before a worker is permitted
    /// to deserialize or execute its body. The producer's raw body_json is the
    /// sole execution payload; the legacy/display body field is intentionally
    /// never read here.
    /// </summary>
    public static class OperatorCourierCertificationEnvelopeVerifier
    {
        private static readonly Regex Sha256Pattern = new Regex("^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant);
        private static readonly Regex DigestPattern = new Regex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
        private static readonly Regex AliasPattern = new Regex("^[a-z][a-z0-9_]*$", RegexOptions.CultureInvariant);
        private static readonly HashSet<string> Channels = new HashSet<string>(StringComparer.Ordinal)
        {
            "search", "generic_call", "typed_mcp", "deterministic_workflow"
        };
        private static readonly HashSet<string> EnvelopeKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            "schema", "version", "canonicalization", "policy_hash", "policy_record_hash",
            "evidence_record_hash", "request_hash", "effect_hash", "method", "path",
            "body_present", "body_sha256", "channel", "alias", "workflow", "runtime_mode",
            "exposure_profile", "policy_trust_source", "envelope_hash"
        };
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        /// <summary>
        /// Parses a v2 courier job. JSON parsing failures are returned as a
        /// typed terminal validation result rather than thrown to the worker.
        /// </summary>
        public static OperatorCourierCertificationEnvelopeValidationResult VerifyJobJson(string? jobJson)
        {
            if (string.IsNullOrWhiteSpace(jobJson))
                return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_JOB_MALFORMED", "Courier job JSON is missing.");

            try
            {
                using (var document = JsonDocument.Parse(jobJson!))
                {
                    return VerifyJob(document.RootElement);
                }
            }
            catch (JsonException)
            {
                return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_JOB_MALFORMED", "Courier job JSON is malformed.");
            }
            catch (ArgumentException error)
            {
                return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_JOB_MALFORMED", error.Message);
            }
        }

        /// <summary>
        /// Verifies a parsed v2 job. The result intentionally contains no
        /// parsed body until the raw body hash, envelope hash, method/path, and
        /// idempotency binding all verify.
        /// </summary>
        public static OperatorCourierCertificationEnvelopeValidationResult VerifyJob(JsonElement job)
        {
            try
            {
                if (job.ValueKind != JsonValueKind.Object)
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_JOB_MALFORMED", "Courier job must be a JSON object.");

                if (!TryGetRequiredString(job, "version", out var version, out var error)) return error!;
                if (!string.Equals(version, OperatorCourierCertificationEnvelope.JobVersion, StringComparison.Ordinal))
                {
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid(
                        string.Equals(version, "revit-operator.revit-tool-job.v1", StringComparison.Ordinal)
                            ? "CERT_COURIER_LEGACY_JOB_REJECTED"
                            : "CERT_COURIER_JOB_VERSION_INVALID",
                        "Courier execution requires a certified revit-tool-job.v2 receipt.");
                }

                if (!TryGetRequiredString(job, "method", out var jobMethod, out error)) return error!;
                if (!TryGetRequiredString(job, "path", out var jobPath, out error)) return error!;
                if (!IsMethod(jobMethod) || !IsRevitPath(jobPath))
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_METHOD_PATH_INVALID", "Courier job method or path is invalid.");

                if (!TryGetRequiredBoolean(job, "body_present", out var jobBodyPresent, out error)) return error!;
                if (!TryGetRequiredRawString(job, "body_json", out var bodyJson, out error)) return error!;
                if (!jobBodyPresent && bodyJson.Length != 0)
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_BODY_PRESENCE_INVALID", "An absent courier body must persist body_json as the exact empty string.");

                if (!TryGetRequiredElement(job, "certification_envelope", JsonValueKind.Object, out var envelopeElement, out error)) return error!;
                if (!TryReadEnvelope(envelopeElement, out var envelope, out error)) return error!;

                if (!string.Equals(envelope.Method, jobMethod, StringComparison.Ordinal)
                    || !string.Equals(envelope.Path, jobPath, StringComparison.Ordinal))
                {
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_METHOD_PATH_MISMATCH", "Courier job method/path do not match its certification envelope.");
                }
                if (envelope.BodyPresent != jobBodyPresent)
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_BODY_PRESENCE_MISMATCH", "Courier job body_present does not match its certification envelope.");

                var bodyHash = Sha256Prefixed(bodyJson);
                if (!string.Equals(envelope.BodySha256, bodyHash, StringComparison.Ordinal))
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_BODY_HASH_MISMATCH", "Courier body_json does not match the certified UTF-8 SHA-256 digest.");

                var canonicalEnvelopePayload = CanonicalizeEnvelopePayload(envelopeElement);
                var computedEnvelopeHash = Sha256Prefixed(canonicalEnvelopePayload);
                if (!string.Equals(envelope.EnvelopeHash, computedEnvelopeHash, StringComparison.Ordinal))
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ENVELOPE_HASH_MISMATCH", "Courier certification envelope hash is invalid.");

                if (!TryGetRequiredString(job, "id", out var jobId, out error)) return error!;
                if (!TryGetRequiredString(job, "idempotency_key", out var idempotencyKey, out error)) return error!;
                if (!DigestPattern.IsMatch(jobId) || !DigestPattern.IsMatch(idempotencyKey))
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_IDEMPOTENCY_INVALID", "Courier v2 idempotency identifiers must be lowercase SHA-256 hex digests.");

                if (!TryGetRequiredRawString(job, "session_id", out var sessionId, out error)) return error!;
                if (string.IsNullOrWhiteSpace(sessionId))
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_SESSION_INVALID", "Courier v2 session_id is required.");
                if (!TryGetOptionalStringOrNull(job, "message_id", out var messageId, out error)) return error!;
                if (!TryGetOptionalStringOrNull(job, "turn_token_sha256", out var turnTokenSha256, out error)) return error!;
                if (turnTokenSha256 != null && !Sha256Pattern.IsMatch(turnTokenSha256))
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_TOKEN_DIGEST_INVALID", "Courier v2 turn_token_sha256 is invalid.");
                if (HasProperty(job, "turn_token"))
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_RAW_TOKEN_FORBIDDEN", "Courier v2 jobs must not persist a raw turn token.");
                if (!TryGetOptionalStringOrNull(job, "target_executor_id", out var targetExecutorId, out error)) return error!;
                if (!TryGetOptionalStringOrNull(job, "target_document_title", out var targetDocumentTitle, out error)) return error!;
                if (!TryGetOptionalStringOrNull(job, "target_document_path", out var targetDocumentPath, out error)) return error!;

                var computedIdempotencyKey = ComputeV2IdempotencyKey(
                    envelope,
                    sessionId,
                    messageId,
                    turnTokenSha256,
                    targetExecutorId,
                    targetDocumentTitle,
                    targetDocumentPath,
                    jobBodyPresent,
                    bodyHash);
                if (!string.Equals(jobId, computedIdempotencyKey, StringComparison.Ordinal)
                    || !string.Equals(idempotencyKey, computedIdempotencyKey, StringComparison.Ordinal))
                {
                    return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_IDEMPOTENCY_MISMATCH", "Courier v2 idempotency identity does not bind the certified envelope and exact request target.");
                }

                // body_json is authoritative. Do not inspect the legacy body
                // display field at all; it may be reordered, normalized, or
                // maliciously changed without becoming executable input.
                JsonElement? parsedBody = null;
                if (jobBodyPresent)
                {
                    try
                    {
                        using (var bodyDocument = JsonDocument.Parse(bodyJson))
                        {
                            parsedBody = bodyDocument.RootElement.Clone();
                        }
                    }
                    catch (JsonException)
                    {
                        return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_BODY_JSON_INVALID", "Certified courier body_json is not valid JSON.");
                    }
                }

                return OperatorCourierCertificationEnvelopeValidationResult.Valid(envelope, parsedBody, computedIdempotencyKey);
            }
            catch (OperatorCourierCanonicalizationException error)
            {
                return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_CANONICALIZATION_INVALID", error.Message);
            }
            catch (EncoderFallbackException)
            {
                return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_UTF8_INVALID", "Courier certification data cannot be represented as strict UTF-8.");
            }
            catch (ArgumentException error)
            {
                return OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_JOB_MALFORMED", error.Message);
            }
        }

        /// <summary>
        /// Producer-compatible canonical JSON for envelope and idempotency
        /// values: CRLF/CR folding, NFC, normalized ordinal key sorting, and
        /// JavaScript-compatible minimal JSON string escaping.
        /// </summary>
        public static string Canonicalize(JsonElement value)
        {
            var builder = new StringBuilder();
            WriteCanonicalValue(builder, value, null);
            return builder.ToString();
        }

        /// <summary>
        /// Computes the unprefixed v2 durable job idempotency key. This helper
        /// never receives or serializes a raw turn token.
        /// </summary>
        public static string ComputeV2IdempotencyKey(
            OperatorCourierCertificationEnvelope envelope,
            string sessionId,
            string? messageId,
            string? turnTokenSha256,
            string? targetExecutorId,
            string? targetDocumentTitle,
            string? targetDocumentPath,
            bool bodyPresent,
            string bodySha256)
        {
            if (envelope == null) throw new ArgumentNullException(nameof(envelope));
            return ComputeV2IdempotencyKey(
                envelope.EnvelopeHash,
                envelope.Method,
                envelope.Path,
                sessionId,
                messageId,
                turnTokenSha256,
                targetExecutorId,
                targetDocumentTitle,
                targetDocumentPath,
                bodyPresent,
                bodySha256);
        }

        /// <summary>
        /// Computes the v2 idempotency identity from verified immutable values.
        /// This overload is useful to a job publisher before it materializes a
        /// consumer envelope object; callers must supply the exact values that
        /// were included in the canonical certification envelope.
        /// </summary>
        public static string ComputeV2IdempotencyKey(
            string certificationEnvelopeHash,
            string method,
            string path,
            string sessionId,
            string? messageId,
            string? turnTokenSha256,
            string? targetExecutorId,
            string? targetDocumentTitle,
            string? targetDocumentPath,
            bool bodyPresent,
            string bodySha256)
        {
            if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("sessionId is required.", nameof(sessionId));
            if (!Sha256Pattern.IsMatch(bodySha256)) throw new ArgumentException("bodySha256 is invalid.", nameof(bodySha256));
            if (!Sha256Pattern.IsMatch(certificationEnvelopeHash)) throw new ArgumentException("certificationEnvelopeHash is invalid.", nameof(certificationEnvelopeHash));
            if (!IsMethod(method) || !IsRevitPath(path)) throw new ArgumentException("method or path is invalid.");

            var values = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schema"] = OperatorCourierCertificationEnvelope.IdempotencySchema,
                ["canonicalization"] = OperatorCourierCertificationEnvelope.Canonicalization,
                ["session_id"] = sessionId,
                ["message_id"] = messageId,
                ["turn_token_sha256"] = turnTokenSha256,
                ["target_executor_id"] = targetExecutorId,
                ["target_document_title"] = targetDocumentTitle,
                ["target_document_path"] = targetDocumentPath,
                ["method"] = method,
                ["path"] = path,
                ["body_present"] = bodyPresent,
                ["body_sha256"] = bodySha256,
                ["certification_envelope_hash"] = certificationEnvelopeHash
            };

            var json = JsonSerializer.Serialize(values);
            using (var document = JsonDocument.Parse(json))
            {
                return Sha256Hex(Canonicalize(document.RootElement));
            }
        }

        public static string Sha256Prefixed(string value)
        {
            return "sha256:" + Sha256Hex(value);
        }

        private static bool TryReadEnvelope(
            JsonElement element,
            out OperatorCourierCertificationEnvelope envelope,
            out OperatorCourierCertificationEnvelopeValidationResult? error)
        {
            envelope = new OperatorCourierCertificationEnvelope();
            error = null;
            var fields = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                var normalizedName = NormalizeText(property.Name);
                if (!EnvelopeKeys.Contains(normalizedName))
                {
                    error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ENVELOPE_UNKNOWN_FIELD", "Certification envelope contains an unknown field: " + normalizedName + ".");
                    return false;
                }
                if (fields.ContainsKey(normalizedName))
                {
                    error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ENVELOPE_DUPLICATE_KEY", "Certification envelope contains duplicate normalized key: " + normalizedName + ".");
                    return false;
                }
                fields.Add(normalizedName, property.Value);
            }

            if (!TryEnvelopeString(fields, "schema", out var schema, out error)) return false;
            if (!string.Equals(schema, OperatorCourierCertificationEnvelope.Schema, StringComparison.Ordinal))
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ENVELOPE_SCHEMA_INVALID", "Certification envelope schema is invalid.");
                return false;
            }
            if (!fields.TryGetValue("version", out var versionElement) || versionElement.ValueKind != JsonValueKind.Number || !versionElement.TryGetInt32(out var version) || version != 1)
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ENVELOPE_VERSION_INVALID", "Certification envelope version must be the integer 1.");
                return false;
            }
            if (!TryEnvelopeString(fields, "canonicalization", out var canonicalization, out error)) return false;
            if (!string.Equals(canonicalization, OperatorCourierCertificationEnvelope.Canonicalization, StringComparison.Ordinal))
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_CANONICALIZATION_VERSION_INVALID", "Certification envelope canonicalization is invalid.");
                return false;
            }

            if (!TryEnvelopeHash(fields, "policy_hash", out var policyHash, out error)
                || !TryEnvelopeHash(fields, "policy_record_hash", out var policyRecordHash, out error)
                || !TryEnvelopeHash(fields, "evidence_record_hash", out var evidenceRecordHash, out error)
                || !TryEnvelopeHash(fields, "request_hash", out var requestHash, out error)
                || !TryEnvelopeHash(fields, "effect_hash", out var effectHash, out error)
                || !TryEnvelopeHash(fields, "body_sha256", out var bodySha256, out error)
                || !TryEnvelopeHash(fields, "envelope_hash", out var envelopeHash, out error)) return false;

            if (!TryEnvelopeString(fields, "method", out var method, out error)
                || !TryEnvelopeString(fields, "path", out var path, out error)
                || !TryEnvelopeBoolean(fields, "body_present", out var bodyPresent, out error)
                || !TryEnvelopeString(fields, "channel", out var channel, out error)
                || !TryEnvelopeString(fields, "alias", out var alias, out error)
                || !TryEnvelopeString(fields, "runtime_mode", out var runtimeMode, out error)
                || !TryEnvelopeString(fields, "exposure_profile", out var exposureProfile, out error)
                || !TryEnvelopeString(fields, "policy_trust_source", out var policyTrustSource, out error)) return false;

            if (!IsMethod(method) || !IsRevitPath(path))
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_METHOD_PATH_INVALID", "Certification envelope method or path is invalid.");
                return false;
            }
            if (!Channels.Contains(channel))
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_CHANNEL_INVALID", "Certification envelope channel is invalid.");
                return false;
            }
            if (!AliasPattern.IsMatch(alias) || (channel == "generic_call" && alias != "revit_call_tool"))
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ALIAS_INVALID", "Certification envelope alias is invalid for its channel.");
                return false;
            }
            if (string.IsNullOrWhiteSpace(runtimeMode) || exposureProfile != "certified" || (policyTrustSource != "bundled" && policyTrustSource != "deployment"))
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_RUNTIME_PROFILE_INVALID", "Certification envelope runtime/profile/trust source is invalid.");
                return false;
            }

            string? workflow = null;
            if (fields.TryGetValue("workflow", out var workflowElement))
            {
                if (workflowElement.ValueKind != JsonValueKind.String)
                {
                    error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_WORKFLOW_INVALID", "Certification envelope workflow must be a string when present.");
                    return false;
                }
                workflow = NormalizeText(workflowElement.GetString() ?? "");
            }

            envelope = new OperatorCourierCertificationEnvelope
            {
                EnvelopeSchema = schema,
                Version = version,
                CanonicalizationVersion = canonicalization,
                PolicyHash = policyHash,
                PolicyRecordHash = policyRecordHash,
                EvidenceRecordHash = evidenceRecordHash,
                RequestHash = requestHash,
                EffectHash = effectHash,
                Method = method,
                Path = path,
                BodyPresent = bodyPresent,
                BodySha256 = bodySha256,
                Channel = channel,
                Alias = alias,
                Workflow = workflow,
                RuntimeMode = runtimeMode,
                ExposureProfile = exposureProfile,
                PolicyTrustSource = policyTrustSource,
                EnvelopeHash = envelopeHash
            };
            return true;
        }

        private static bool TryEnvelopeHash(
            IDictionary<string, JsonElement> fields,
            string name,
            out string value,
            out OperatorCourierCertificationEnvelopeValidationResult? error)
        {
            if (!TryEnvelopeString(fields, name, out value, out error)) return false;
            if (Sha256Pattern.IsMatch(value)) return true;
            error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ENVELOPE_HASH_FIELD_INVALID", "Certification envelope " + name + " is not a lowercase sha256 digest.");
            return false;
        }

        private static bool TryEnvelopeString(
            IDictionary<string, JsonElement> fields,
            string name,
            out string value,
            out OperatorCourierCertificationEnvelopeValidationResult? error)
        {
            value = "";
            error = null;
            if (!fields.TryGetValue(name, out var element))
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ENVELOPE_FIELD_MISSING", "Certification envelope is missing " + name + ".");
                return false;
            }
            if (element.ValueKind != JsonValueKind.String)
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ENVELOPE_FIELD_INVALID", "Certification envelope " + name + " must be a string.");
                return false;
            }
            value = NormalizeText(element.GetString() ?? "");
            return true;
        }

        private static bool TryEnvelopeBoolean(
            IDictionary<string, JsonElement> fields,
            string name,
            out bool value,
            out OperatorCourierCertificationEnvelopeValidationResult? error)
        {
            value = false;
            error = null;
            if (!fields.TryGetValue(name, out var element))
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ENVELOPE_FIELD_MISSING", "Certification envelope is missing " + name + ".");
                return false;
            }
            if (element.ValueKind != JsonValueKind.True && element.ValueKind != JsonValueKind.False)
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_ENVELOPE_FIELD_INVALID", "Certification envelope " + name + " must be a boolean.");
                return false;
            }
            value = element.GetBoolean();
            return true;
        }

        private static bool TryGetRequiredString(
            JsonElement objectValue,
            string name,
            out string value,
            out OperatorCourierCertificationEnvelopeValidationResult? error)
        {
            value = "";
            error = null;
            if (!TryGetRequiredElement(objectValue, name, JsonValueKind.String, out var element, out error)) return false;
            value = element.GetString() ?? "";
            return true;
        }

        private static bool TryGetRequiredRawString(
            JsonElement objectValue,
            string name,
            out string value,
            out OperatorCourierCertificationEnvelopeValidationResult? error)
        {
            return TryGetRequiredString(objectValue, name, out value, out error);
        }

        private static bool TryGetRequiredBoolean(
            JsonElement objectValue,
            string name,
            out bool value,
            out OperatorCourierCertificationEnvelopeValidationResult? error)
        {
            value = false;
            error = null;
            if (!TryGetUniqueElement(objectValue, name, out var element, out error)) return false;
            if (element.ValueKind != JsonValueKind.True && element.ValueKind != JsonValueKind.False)
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_JOB_FIELD_INVALID", "Courier job " + name + " must be a boolean.");
                return false;
            }
            value = element.GetBoolean();
            return true;
        }

        private static bool TryGetOptionalStringOrNull(
            JsonElement objectValue,
            string name,
            out string? value,
            out OperatorCourierCertificationEnvelopeValidationResult? error)
        {
            value = null;
            error = null;
            if (!TryGetUniqueElement(objectValue, name, out var element, out error)) return false;
            if (element.ValueKind == JsonValueKind.Null) return true;
            if (element.ValueKind != JsonValueKind.String)
            {
                error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_JOB_FIELD_INVALID", "Courier job " + name + " must be a string or null.");
                return false;
            }
            value = element.GetString();
            return true;
        }

        private static bool TryGetRequiredElement(
            JsonElement objectValue,
            string name,
            JsonValueKind kind,
            out JsonElement value,
            out OperatorCourierCertificationEnvelopeValidationResult? error)
        {
            value = default;
            error = null;
            if (!TryGetUniqueElement(objectValue, name, out value, out error)) return false;
            if (value.ValueKind == kind) return true;
            error = OperatorCourierCertificationEnvelopeValidationResult.Invalid("CERT_COURIER_JOB_FIELD_INVALID", "Courier job " + name + " has an invalid JSON type.");
            return false;
        }

        private static bool TryGetUniqueElement(
            JsonElement objectValue,
            string name,
            out JsonElement value,
            out OperatorCourierCertificationEnvelopeValidationResult? error)
        {
            value = default;
            error = null;
            var count = 0;
            foreach (var property in objectValue.EnumerateObject())
            {
                if (!string.Equals(property.Name, name, StringComparison.Ordinal)) continue;
                value = property.Value;
                count++;
            }
            if (count == 1) return true;
            error = OperatorCourierCertificationEnvelopeValidationResult.Invalid(
                count == 0 ? "CERT_COURIER_JOB_FIELD_MISSING" : "CERT_COURIER_JOB_DUPLICATE_KEY",
                count == 0 ? "Courier job is missing " + name + "." : "Courier job contains duplicate key " + name + ".");
            return false;
        }

        private static bool HasProperty(JsonElement objectValue, string name)
        {
            foreach (var property in objectValue.EnumerateObject())
            {
                if (string.Equals(property.Name, name, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        private static string CanonicalizeEnvelopePayload(JsonElement envelope)
        {
            var builder = new StringBuilder();
            WriteCanonicalValue(builder, envelope, "envelope_hash");
            return builder.ToString();
        }

        private static void WriteCanonicalValue(StringBuilder builder, JsonElement value, string? excludedRootProperty)
        {
            switch (value.ValueKind)
            {
                case JsonValueKind.Object:
                    var properties = new List<KeyValuePair<string, JsonElement>>();
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var property in value.EnumerateObject())
                    {
                        var normalizedName = NormalizeText(property.Name);
                        if (!seen.Add(normalizedName))
                            throw new OperatorCourierCanonicalizationException("Canonical JSON rejects duplicate normalized object key: " + normalizedName + ".");
                        if (excludedRootProperty != null && string.Equals(normalizedName, excludedRootProperty, StringComparison.Ordinal)) continue;
                        properties.Add(new KeyValuePair<string, JsonElement>(normalizedName, property.Value));
                    }
                    properties.Sort((left, right) => StringComparer.Ordinal.Compare(left.Key, right.Key));
                    builder.Append('{');
                    for (var index = 0; index < properties.Count; index++)
                    {
                        if (index > 0) builder.Append(',');
                        WriteJsonString(builder, properties[index].Key);
                        builder.Append(':');
                        WriteCanonicalValue(builder, properties[index].Value, null);
                    }
                    builder.Append('}');
                    return;
                case JsonValueKind.Array:
                    builder.Append('[');
                    var first = true;
                    foreach (var item in value.EnumerateArray())
                    {
                        if (!first) builder.Append(',');
                        WriteCanonicalValue(builder, item, null);
                        first = false;
                    }
                    builder.Append(']');
                    return;
                case JsonValueKind.String:
                    WriteJsonString(builder, NormalizeText(value.GetString() ?? ""));
                    return;
                case JsonValueKind.Number:
                    builder.Append(CanonicalNumber(value));
                    return;
                case JsonValueKind.True:
                    builder.Append("true");
                    return;
                case JsonValueKind.False:
                    builder.Append("false");
                    return;
                case JsonValueKind.Null:
                    builder.Append("null");
                    return;
                default:
                    throw new OperatorCourierCanonicalizationException("Canonical JSON encountered an unsupported JSON value.");
            }
        }

        private static string CanonicalNumber(JsonElement element)
        {
            if (element.TryGetInt64(out var signed)) return signed.ToString(CultureInfo.InvariantCulture);
            if (element.TryGetUInt64(out var unsigned)) return unsigned.ToString(CultureInfo.InvariantCulture);
            if (decimal.TryParse(element.GetRawText(), NumberStyles.Float, CultureInfo.InvariantCulture, out var decimalValue))
                return decimalValue.ToString("G29", CultureInfo.InvariantCulture);
            if (!element.TryGetDouble(out var doubleValue) || double.IsNaN(doubleValue) || double.IsInfinity(doubleValue))
                throw new OperatorCourierCanonicalizationException("Canonical JSON number is invalid.");
            if (doubleValue == 0d) return "0";
            return NormalizeExponent(doubleValue.ToString("R", CultureInfo.InvariantCulture));
        }

        private static string NormalizeExponent(string value)
        {
            var exponentAt = value.IndexOf('E');
            if (exponentAt < 0) exponentAt = value.IndexOf('e');
            if (exponentAt < 0) return value;
            var mantissa = value.Substring(0, exponentAt);
            var exponent = int.Parse(value.Substring(exponentAt + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            return mantissa + "e" + exponent.ToString(CultureInfo.InvariantCulture);
        }

        private static void WriteJsonString(StringBuilder builder, string value)
        {
            EnsureWellFormedUnicode(value);
            builder.Append('"');
            foreach (var character in value)
            {
                switch (character)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\b': builder.Append("\\b"); break;
                    case '\t': builder.Append("\\t"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\f': builder.Append("\\f"); break;
                    case '\r': builder.Append("\\r"); break;
                    default:
                        if (character < 0x20)
                        {
                            builder.Append("\\u00");
                            builder.Append(((int)character).ToString("x2", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            // In particular, retain literal U+2028/U+2029 so
                            // output hashes match JSON.stringify in the MCP producer.
                            builder.Append(character);
                        }
                        break;
                }
            }
            builder.Append('"');
        }

        private static string NormalizeText(string value)
        {
            EnsureWellFormedUnicode(value);
            return value.Replace("\r\n", "\n").Replace("\r", "\n").Normalize(NormalizationForm.FormC);
        }

        private static void EnsureWellFormedUnicode(string value)
        {
            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                if (!char.IsSurrogate(character)) continue;
                if (char.IsHighSurrogate(character)
                    && index + 1 < value.Length
                    && char.IsLowSurrogate(value[index + 1]))
                {
                    index++;
                    continue;
                }
                throw new OperatorCourierCanonicalizationException("Canonical JSON rejects malformed Unicode surrogate data.");
            }
        }

        private static bool IsMethod(string value)
        {
            return string.Equals(value, "GET", StringComparison.Ordinal) || string.Equals(value, "POST", StringComparison.Ordinal);
        }

        private static bool IsRevitPath(string value)
        {
            return value.StartsWith("/revit/", StringComparison.Ordinal)
                && value.IndexOf('\r') < 0
                && value.IndexOf('\n') < 0;
        }

        private static string Sha256Hex(string value)
        {
            using (var sha256 = SHA256.Create())
            {
                var bytes = sha256.ComputeHash(StrictUtf8.GetBytes(value));
                var builder = new StringBuilder(bytes.Length * 2);
                foreach (var valueByte in bytes) builder.Append(valueByte.ToString("x2", CultureInfo.InvariantCulture));
                return builder.ToString();
            }
        }

        private sealed class OperatorCourierCanonicalizationException : Exception
        {
            public OperatorCourierCanonicalizationException(string message) : base(message) { }
        }
    }
}

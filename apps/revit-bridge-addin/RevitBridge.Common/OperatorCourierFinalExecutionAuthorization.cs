using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace RevitBridge.Common
{
    /// <summary>
    /// A fresh backend receipt for one exact v2 courier execution attempt. It
    /// deliberately contains no endpoint, credential, policy path, or mutable
    /// policy input. The worker only accepts this after binding it to the
    /// previously verified durable claim.
    /// </summary>
    public sealed class OperatorCourierFinalExecutionAuthorization
    {
        public const string Schema = "revit-operator.revit-tool-final-authorization.v1";
        public const string FamilySchema = "revit-operator.revit-tool-final-authorization.v2";
        public const string Phase = "certification_final_execution";

        public string JobId { get; internal set; } = "";
        public string CorrelationId { get; internal set; } = "";
        public string SessionId { get; internal set; } = "";
        public string ExecutorId { get; internal set; } = "";
        public string? TargetExecutorId { get; internal set; }
        public string? TargetDocumentTitle { get; internal set; }
        public string? TargetDocumentPath { get; internal set; }
        public string Method { get; internal set; } = "";
        public string Path { get; internal set; } = "";
        public bool BodyPresent { get; internal set; }
        public string BodyJson { get; internal set; } = "";
        public JsonElement? ParsedBody { get; internal set; }
        public string PolicyHash { get; internal set; } = "";
        public string PolicyRecordHash { get; internal set; } = "";
        public string EvidenceRecordHash { get; internal set; } = "";
        public string RequestHash { get; internal set; } = "";
        public string EffectHash { get; internal set; } = "";
        public string Channel { get; internal set; } = "";
        public string Alias { get; internal set; } = "";
        public string? Workflow { get; internal set; }
        public string RuntimeMode { get; internal set; } = "";
        public string ExposureProfile { get; internal set; } = "";
        public string PolicyTrustSource { get; internal set; } = "";
        public string CertificationEnvelopeHash { get; internal set; } = "";
        public OperatorCertifiedRequestFamilyAdmission? RequestFamilyAdmission { get; internal set; }
        public string? AuthorizationStage { get; internal set; }
        public string? CompletionChallenge { get; internal set; }
        public string? CompletionChallengeHash { get; internal set; }
        public DateTimeOffset AuthorizedAtUtc { get; internal set; }
        /// <summary>
        /// The receipt is bounded by the immutable v2 job expiry. The current
        /// backend authorization schema intentionally does not carry a second
        /// wider expiry that a stale authorization could exploit.
        /// </summary>
        public DateTimeOffset ExpiresAtUtc { get; internal set; }
    }

    public sealed class OperatorCourierFinalExecutionAuthorizationValidationResult
    {
        public bool IsValid { get; internal set; }
        public string Code { get; internal set; } = "CERTIFICATION_FINAL_EXECUTION_INVALID";
        public string Error { get; internal set; } = "Courier final execution authorization is invalid.";
        public OperatorCourierFinalExecutionAuthorization? Authorization { get; internal set; }

        internal static OperatorCourierFinalExecutionAuthorizationValidationResult Invalid(string code, string error)
        {
            return new OperatorCourierFinalExecutionAuthorizationValidationResult
            {
                IsValid = false,
                Code = code,
                Error = error
            };
        }

        internal static OperatorCourierFinalExecutionAuthorizationValidationResult Valid(OperatorCourierFinalExecutionAuthorization authorization)
        {
            return new OperatorCourierFinalExecutionAuthorizationValidationResult
            {
                IsValid = true,
                Code = "CERTIFICATION_FINAL_EXECUTION_VALID",
                Error = "",
                Authorization = authorization
            };
        }
    }

    /// <summary>
    /// Strictly parses the fixed /authorize-execution response and binds both
    /// its returned job and authorization receipt to an already verified raw
    /// v2 claim. Any denial, transport change, malformed response, expiry, or
    /// field mismatch is a terminal no-execute result.
    /// </summary>
    public static class OperatorCourierFinalExecutionAuthorizationBinder
    {
        private const int MaximumResponseUtf8Bytes = 6 * 1024 * 1024;
        private const int MaximumJsonDepth = 64;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly JsonDocumentOptions StrictJsonOptions = new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = MaximumJsonDepth
        };
        private static readonly HashSet<string> ResponseKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            "ok", "job", "authorization"
        };
        private static readonly HashSet<string> AuthorizationRequiredKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            "version", "phase", "authorized_at", "job_id", "correlation_id", "session_id", "executor_id",
            "target_executor_id", "target_document_title", "target_document_path", "method", "path",
            "body_present", "body_json", "policy_hash", "policy_record_hash", "evidence_record_hash",
            "request_hash", "effect_hash", "channel", "alias", "runtime_mode", "exposure_profile",
            "policy_trust_source", "certification_envelope_hash"
        };
        private static readonly HashSet<string> FamilyAuthorizationRequiredKeys = new HashSet<string>(AuthorizationRequiredKeys, StringComparer.Ordinal)
        {
            "request_family_admission", "authorization_stage", "completion_challenge", "completion_challenge_hash"
        };
        // 32 raw bytes encoded as unpadded canonical base64url. Restricting the
        // final character rejects alternate encodings with non-zero pad bits.
        private static readonly Regex CompletionChallengePattern = new Regex(
            "^cmcc1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",
            RegexOptions.CultureInvariant);
        private static readonly HashSet<string> AuthorizationOptionalKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            "workflow"
        };

        /// <summary>
        /// A v2 courier receipt is executable only on the exact process it was
        /// addressed to. Missing targets are intentionally rejected here rather
        /// than treated as broadcast authorization.
        /// </summary>
        public static bool IsTargetExecutorBound(
            OperatorCourierCertificationEnvelopeValidationResult? claimed,
            string? expectedExecutorId)
        {
            return claimed != null
                && claimed.IsValid
                && claimed.Job != null
                && !string.IsNullOrWhiteSpace(claimed.Job.TargetExecutorId)
                && !string.IsNullOrWhiteSpace(expectedExecutorId)
                && string.Equals(claimed.Job.TargetExecutorId, expectedExecutorId, StringComparison.Ordinal);
        }

        /// <summary>
        /// Checks that a final receipt remains addressed to this process after
        /// its transport response has been bound to the original v2 claim.
        /// </summary>
        public static bool IsBoundToExecutor(
            OperatorCourierFinalExecutionAuthorization? authorization,
            string? expectedExecutorId)
        {
            return authorization != null
                && !string.IsNullOrWhiteSpace(expectedExecutorId)
                && string.Equals(authorization.ExecutorId, expectedExecutorId, StringComparison.Ordinal)
                && string.Equals(authorization.TargetExecutorId, expectedExecutorId, StringComparison.Ordinal);
        }

        /// <summary>
        /// Executes one authoritative final-refresh operation. Callers provide
        /// a transport delegate that uses <see cref="Bind"/> against the
        /// original claim; this common gate makes executor pinning explicit so
        /// dispatch code has no fallback path around a denied refresh.
        /// </summary>
        public static async Task<OperatorCourierFinalExecutionAuthorization> RequireFreshBoundAuthorizationAsync(
            Func<CancellationToken, Task<OperatorCourierFinalExecutionAuthorization>> refreshAsync,
            OperatorCourierCertificationEnvelopeValidationResult? claimed,
            string? expectedExecutorId,
            CancellationToken cancellationToken)
        {
            if (refreshAsync == null) throw new ArgumentNullException(nameof(refreshAsync));
            if (!IsTargetExecutorBound(claimed, expectedExecutorId))
            {
                throw new InvalidOperationException(
                    "Certified courier job target_executor_id does not exactly match the local executor.");
            }

            var authorization = await refreshAsync(cancellationToken).ConfigureAwait(false);
            if (!IsBoundToExecutor(authorization, expectedExecutorId))
            {
                throw new InvalidOperationException(
                    "Fresh courier final-execution authorization is not pinned to the local executor.");
            }
            if (authorization.RequestFamilyAdmission != null
                && !string.Equals(authorization.AuthorizationStage, "final", StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "Fresh courier request-family authorization is not a final-stage receipt.");
            }
            if (authorization.RequestFamilyAdmission != null
                && !ValidateCompletionChallenge(
                    authorization.AuthorizationStage,
                    authorization.CompletionChallenge,
                    authorization.CompletionChallengeHash))
            {
                throw new InvalidOperationException(
                    "Fresh courier request-family authorization is not bound to an exact completion challenge.");
            }
            return authorization;
        }

        public static OperatorCourierFinalExecutionAuthorizationValidationResult Bind(
            string? responseJson,
            OperatorCourierCertificationEnvelopeValidationResult? claimed,
            string? expectedExecutorId,
            DateTimeOffset? nowUtc = null,
            string authorizationStage = "final")
        {
            if (claimed == null || !claimed.IsValid || claimed.Job == null || claimed.Envelope == null)
                return OperatorCourierFinalExecutionAuthorizationValidationResult.Invalid(
                    "CERTIFICATION_FINAL_CLAIM_INVALID",
                    "Courier final execution requires a previously verified v2 claim.");
            if (string.IsNullOrWhiteSpace(expectedExecutorId))
                return OperatorCourierFinalExecutionAuthorizationValidationResult.Invalid(
                    "CERTIFICATION_FINAL_EXECUTOR_INVALID",
                    "Courier final execution requires a non-empty local executor identity.");
            if (!IsTargetExecutorBound(claimed, expectedExecutorId))
                return OperatorCourierFinalExecutionAuthorizationValidationResult.Invalid(
                    "CERTIFICATION_FINAL_TARGET_EXECUTOR_MISMATCH",
                    "Certified courier job target_executor_id does not exactly match the local executor.");
            if (string.IsNullOrWhiteSpace(responseJson))
                return OperatorCourierFinalExecutionAuthorizationValidationResult.Invalid(
                    "CERTIFICATION_FINAL_RESPONSE_MISSING",
                    "Courier final execution authorization response is missing.");
            var responseText = responseJson!;
            var executorIdentity = expectedExecutorId!;

            try
            {
                if (StrictUtf8.GetByteCount(responseText) > MaximumResponseUtf8Bytes)
                    return Invalid("CERTIFICATION_FINAL_RESPONSE_TOO_LARGE", "Courier final execution authorization response exceeds the 6 MiB limit.");
            }
            catch (EncoderFallbackException)
            {
                return Invalid("CERTIFICATION_FINAL_UTF8_INVALID", "Courier final execution authorization response cannot be represented as strict UTF-8.");
            }

            try
            {
                using (var document = JsonDocument.Parse(responseText, StrictJsonOptions))
                {
                    var root = document.RootElement;
                    if (!HasExactKeys(root, ResponseKeys, EmptyKeys, out var responseError)) return responseError!;
                    if (!TryGetUnique(root, "ok", JsonValueKind.True, out _, out responseError)) return responseError!;
                    if (!TryGetUnique(root, "job", JsonValueKind.Object, out var returnedJobElement, out responseError)) return responseError!;
                    if (!TryGetUnique(root, "authorization", JsonValueKind.Object, out var authorizationElement, out responseError)) return responseError!;

                    var returnedJob = OperatorCourierCertificationEnvelopeVerifier.VerifyJob(returnedJobElement);
                    if (!returnedJob.IsValid || returnedJob.Job == null || returnedJob.Envelope == null)
                    {
                        return Invalid(
                            "CERTIFICATION_FINAL_RETURNED_JOB_INVALID",
                            "Courier final execution response returned an invalid v2 job: " + returnedJob.Code + ".");
                    }
                    if (!SameClaim(claimed, returnedJob))
                    {
                        return Invalid(
                            "CERTIFICATION_FINAL_RETURNED_JOB_MISMATCH",
                            "Courier final execution response does not bind to the claimed v2 job.");
                    }

                    return BindAuthorization(
                        authorizationElement,
                        claimed,
                        executorIdentity,
                        nowUtc ?? DateTimeOffset.UtcNow,
                        authorizationStage);
                }
            }
            catch (JsonException)
            {
                return Invalid("CERTIFICATION_FINAL_RESPONSE_MALFORMED", "Courier final execution authorization response is malformed JSON.");
            }
            catch (ArgumentException error)
            {
                return Invalid("CERTIFICATION_FINAL_RESPONSE_MALFORMED", error.Message);
            }
        }

        /// <summary>
        /// This is intentionally small and side-effect free so the external
        /// event can perform its last check on the Revit thread immediately
        /// before handler invocation. Authorization is never cached or renewed
        /// from this gate; retry loops must obtain a new backend receipt.
        /// </summary>
        public static bool IsCurrent(OperatorCourierFinalExecutionAuthorization? authorization, DateTimeOffset nowUtc)
        {
            return authorization != null
                && authorization.ExpiresAtUtc > nowUtc.ToUniversalTime()
                && authorization.AuthorizedAtUtc <= authorization.ExpiresAtUtc
                && string.Equals(authorization.Method, authorization.Method.ToUpperInvariant(), StringComparison.Ordinal)
                && authorization.Path.StartsWith("/revit/", StringComparison.Ordinal)
                && (!authorization.BodyPresent || authorization.ParsedBody.HasValue);
        }

        /// <summary>
        /// Pure final gate for the workstation's queued action. The caller
        /// supplies the raw body it is about to hand to Revit; any difference
        /// from the fresh authorization is terminal no-execute.
        /// </summary>
        public static bool IsBoundToAction(
            OperatorCourierFinalExecutionAuthorization? authorization,
            DateTimeOffset? jobExpiresAtUtc,
            string? actionId,
            string? correlationId,
            string? method,
            string? path,
            string? targetDocumentTitle,
            string? targetDocumentPath,
            bool bodyPresent,
            string? bodyJson,
            DateTimeOffset nowUtc)
        {
            return authorization != null
                && jobExpiresAtUtc.HasValue
                && jobExpiresAtUtc.Value == authorization.ExpiresAtUtc
                && IsCurrent(authorization, nowUtc)
                && Same(actionId, authorization.JobId)
                && Same(correlationId, authorization.CorrelationId)
                && Same(method, authorization.Method)
                && Same(path, authorization.Path)
                && Same(targetDocumentTitle ?? "", authorization.TargetDocumentTitle ?? "")
                && Same(targetDocumentPath ?? "", authorization.TargetDocumentPath ?? "")
                && bodyPresent == authorization.BodyPresent
                && Same(bodyJson ?? "", authorization.BodyJson)
                && (authorization.RequestFamilyAdmission == null
                    || ValidateCompletionChallenge(
                        authorization.AuthorizationStage,
                        authorization.CompletionChallenge,
                        authorization.CompletionChallengeHash));
        }

        private static OperatorCourierFinalExecutionAuthorizationValidationResult BindAuthorization(
            JsonElement authorization,
            OperatorCourierCertificationEnvelopeValidationResult claimed,
            string expectedExecutorId,
            DateTimeOffset nowUtc,
            string expectedAuthorizationStage)
        {
            var hasFamilyAdmission = authorization.ValueKind == JsonValueKind.Object
                && authorization.EnumerateObject().Any(property => property.Name == "request_family_admission");
            if (!HasExactKeys(authorization, hasFamilyAdmission ? FamilyAuthorizationRequiredKeys : AuthorizationRequiredKeys, AuthorizationOptionalKeys, out var error)) return error!;
            if (!TryString(authorization, "version", out var version, out error)
                || !TryString(authorization, "phase", out var phase, out error)
                || !TryString(authorization, "authorized_at", out var authorizedAtText, out error)
                || !TryString(authorization, "job_id", out var jobId, out error)
                || !TryString(authorization, "correlation_id", out var correlationId, out error)
                || !TryString(authorization, "session_id", out var sessionId, out error)
                || !TryString(authorization, "executor_id", out var executorId, out error)
                || !TryStringOrNull(authorization, "target_executor_id", out var targetExecutorId, out error)
                || !TryStringOrNull(authorization, "target_document_title", out var targetDocumentTitle, out error)
                || !TryStringOrNull(authorization, "target_document_path", out var targetDocumentPath, out error)
                || !TryString(authorization, "method", out var method, out error)
                || !TryString(authorization, "path", out var path, out error)
                || !TryBoolean(authorization, "body_present", out var bodyPresent, out error)
                || !TryString(authorization, "body_json", out var bodyJson, out error)
                || !TryString(authorization, "policy_hash", out var policyHash, out error)
                || !TryString(authorization, "policy_record_hash", out var policyRecordHash, out error)
                || !TryString(authorization, "evidence_record_hash", out var evidenceRecordHash, out error)
                || !TryString(authorization, "request_hash", out var requestHash, out error)
                || !TryString(authorization, "effect_hash", out var effectHash, out error)
                || !TryString(authorization, "channel", out var channel, out error)
                || !TryString(authorization, "alias", out var alias, out error)
                || !TryOptionalString(authorization, "workflow", out var workflow, out error)
                || !TryString(authorization, "runtime_mode", out var runtimeMode, out error)
                || !TryString(authorization, "exposure_profile", out var exposureProfile, out error)
                || !TryString(authorization, "policy_trust_source", out var policyTrustSource, out error)
                || !TryString(authorization, "certification_envelope_hash", out var envelopeHash, out error)) return error!;

            OperatorCertifiedRequestFamilyAdmission? requestFamilyAdmission = null;
            string? authorizationStage = null;
            string? completionChallenge = null;
            string? completionChallengeHash = null;
            if (hasFamilyAdmission)
            {
                if (!TryGetUnique(authorization, "request_family_admission", JsonValueKind.Object, out var familyElement, out error)) return error!;
                if (!TryString(authorization, "authorization_stage", out authorizationStage, out error)) return error!;
                if (!TryStringOrNull(authorization, "completion_challenge", out completionChallenge, out error)
                    || !TryStringOrNull(authorization, "completion_challenge_hash", out completionChallengeHash, out error)) return error!;
                try { requestFamilyAdmission = OperatorCertifiedRequestFamilyAdmissionVerifier.Parse(familyElement); }
                catch (System.IO.InvalidDataException invalid)
                {
                    return Invalid("CERTIFICATION_FINAL_REQUEST_FAMILY_INVALID", invalid.Message);
                }
                if ((!string.Equals(authorizationStage, "preflight", StringComparison.Ordinal)
                        && !string.Equals(authorizationStage, "final", StringComparison.Ordinal))
                    || !string.Equals(authorizationStage, expectedAuthorizationStage, StringComparison.Ordinal))
                {
                    return Invalid(
                        "CERTIFICATION_FINAL_AUTHORIZATION_STAGE_INVALID",
                        "Courier request-family authorization stage is invalid or does not match the requested stage.");
                }
                if (!ValidateCompletionChallenge(
                    authorizationStage,
                    completionChallenge,
                    completionChallengeHash))
                {
                    return Invalid(
                        "CERTIFICATION_FINAL_COMPLETION_CHALLENGE_INVALID",
                        "Courier request-family completion challenge is missing, malformed, mismatched, or present at preflight.");
                }
            }

            var claimedFamilyAdmission = claimed.Envelope!.RequestFamilyAdmission;
            if ((claimedFamilyAdmission == null && (!string.Equals(version, OperatorCourierFinalExecutionAuthorization.Schema, StringComparison.Ordinal) || requestFamilyAdmission != null))
                || (claimedFamilyAdmission != null && (!string.Equals(version, OperatorCourierFinalExecutionAuthorization.FamilySchema, StringComparison.Ordinal) || requestFamilyAdmission == null))
                || !string.Equals(phase, OperatorCourierFinalExecutionAuthorization.Phase, StringComparison.Ordinal))
            {
                return Invalid("CERTIFICATION_FINAL_SCHEMA_INVALID", "Courier final execution authorization schema or phase is invalid.");
            }
            if (!TryCanonicalUtc(authorizedAtText, out var authorizedAtUtc)
                || authorizedAtUtc < claimed.Job!.CreatedAtUtc
                || authorizedAtUtc > claimed.Job!.ExpiresAtUtc
                || authorizedAtUtc > nowUtc.ToUniversalTime().AddMinutes(1))
            {
                return Invalid("CERTIFICATION_FINAL_AUTHORIZED_AT_INVALID", "Courier final execution authorization timestamp is invalid or outside the job lifetime.");
            }
            if (claimed.Job.ExpiresAtUtc <= nowUtc.ToUniversalTime())
            {
                return Invalid("CERTIFICATION_FINAL_JOB_EXPIRED", "Courier final execution authorization arrived after the claimed job expired.");
            }

            var job = claimed.Job!;
            var envelope = claimed.Envelope!;
            if (!Same(jobId, job.Id) || !Same(correlationId, job.CorrelationId) || !Same(sessionId, job.SessionId)
                || !Same(executorId, expectedExecutorId) || !Same(targetExecutorId, job.TargetExecutorId)
                || !Same(targetDocumentTitle, job.TargetDocumentTitle) || !Same(targetDocumentPath, job.TargetDocumentPath)
                || !Same(method, job.Method) || !Same(path, job.Path) || bodyPresent != job.BodyPresent
                || !Same(bodyJson, job.BodyJson) || !Same(policyHash, envelope.PolicyHash)
                || !Same(policyRecordHash, envelope.PolicyRecordHash) || !Same(evidenceRecordHash, envelope.EvidenceRecordHash)
                || !Same(requestHash, envelope.RequestHash) || !Same(effectHash, envelope.EffectHash)
                || !Same(channel, envelope.Channel) || !Same(alias, envelope.Alias) || !Same(workflow, envelope.Workflow)
                || !Same(runtimeMode, envelope.RuntimeMode) || !Same(exposureProfile, envelope.ExposureProfile)
                || !Same(policyTrustSource, envelope.PolicyTrustSource) || !Same(envelopeHash, envelope.EnvelopeHash))
            {
                return Invalid("CERTIFICATION_FINAL_BINDING_MISMATCH", "Courier final execution authorization does not exactly match the verified claim.");
            }
            if (claimedFamilyAdmission != null)
            {
                if (!SameAdmission(claimedFamilyAdmission, requestFamilyAdmission!)
                    || !Same(requestHash, requestFamilyAdmission!.RequestInstanceHash)
                    || !Same(envelope.BodySha256, requestFamilyAdmission.OutboundBodySha256))
                    return Invalid("CERTIFICATION_FINAL_REQUEST_FAMILY_MISMATCH", "Courier final authorization changed the sealed request-family instance.");
                try { OperatorCertifiedRequestFamilyAdmissionVerifier.RequireValidEffectiveBody(requestFamilyAdmission, bodyJson); }
                catch (System.IO.InvalidDataException invalid)
                {
                    return Invalid("CERTIFICATION_FINAL_REQUEST_FAMILY_INVALID", invalid.Message);
                }
            }
            if (bodyPresent != claimed.ParsedBody.HasValue)
            {
                return Invalid("CERTIFICATION_FINAL_BODY_PRESENCE_MISMATCH", "Courier final execution authorization body presence does not match the verified claim.");
            }

            JsonElement? parsedBody = null;
            if (bodyPresent)
            {
                try
                {
                    using (var bodyDocument = JsonDocument.Parse(bodyJson, StrictJsonOptions))
                    {
                        parsedBody = bodyDocument.RootElement.Clone();
                    }
                }
                catch (JsonException)
                {
                    return Invalid("CERTIFICATION_FINAL_BODY_JSON_INVALID", "Courier final execution authorization body_json is invalid.");
                }
            }

            try
            {
                if (requestFamilyAdmission != null)
                    OperatorNativeToolExposureEmbeddedAuthority.Instance.RequireAuthorized(new OperatorNativeToolExposureBinding(
                    method,
                    path,
                    bodyJson,
                    policyHash,
                    policyRecordHash,
                    evidenceRecordHash,
                    requestHash,
                    effectHash,
                    channel,
                    alias,
                    requestFamilyAdmission));
            }
            catch (OperatorNativeHttpAdmissionException denied)
            {
                return Invalid(denied.Code, denied.Message);
            }

            return OperatorCourierFinalExecutionAuthorizationValidationResult.Valid(new OperatorCourierFinalExecutionAuthorization
            {
                JobId = jobId,
                CorrelationId = correlationId,
                SessionId = sessionId,
                ExecutorId = executorId,
                TargetExecutorId = targetExecutorId,
                TargetDocumentTitle = targetDocumentTitle,
                TargetDocumentPath = targetDocumentPath,
                Method = method,
                Path = path,
                BodyPresent = bodyPresent,
                BodyJson = bodyJson,
                ParsedBody = parsedBody,
                PolicyHash = policyHash,
                PolicyRecordHash = policyRecordHash,
                EvidenceRecordHash = evidenceRecordHash,
                RequestHash = requestHash,
                EffectHash = effectHash,
                Channel = channel,
                Alias = alias,
                Workflow = workflow,
                RuntimeMode = runtimeMode,
                ExposureProfile = exposureProfile,
                PolicyTrustSource = policyTrustSource,
                CertificationEnvelopeHash = envelopeHash,
                RequestFamilyAdmission = requestFamilyAdmission,
                AuthorizationStage = authorizationStage,
                CompletionChallenge = completionChallenge,
                CompletionChallengeHash = completionChallengeHash,
                AuthorizedAtUtc = authorizedAtUtc,
                ExpiresAtUtc = job.ExpiresAtUtc
            });
        }

        private static bool SameClaim(
            OperatorCourierCertificationEnvelopeValidationResult claimed,
            OperatorCourierCertificationEnvelopeValidationResult returned)
        {
            var leftJob = claimed.Job!;
            var rightJob = returned.Job!;
            var leftEnvelope = claimed.Envelope!;
            var rightEnvelope = returned.Envelope!;
            return Same(leftJob.Id, rightJob.Id) && Same(leftJob.CorrelationId, rightJob.CorrelationId)
                && Same(leftJob.SessionId, rightJob.SessionId) && Same(leftJob.MessageId, rightJob.MessageId)
                && Same(leftJob.TurnTokenSha256, rightJob.TurnTokenSha256)
                && Same(leftJob.TargetExecutorId, rightJob.TargetExecutorId)
                && Same(leftJob.TargetDocumentTitle, rightJob.TargetDocumentTitle)
                && Same(leftJob.TargetDocumentPath, rightJob.TargetDocumentPath)
                && Same(leftJob.Method, rightJob.Method) && Same(leftJob.Path, rightJob.Path)
                && leftJob.BodyPresent == rightJob.BodyPresent && Same(leftJob.BodyJson, rightJob.BodyJson)
                && Same(leftJob.CreatedAtIsoUtc, rightJob.CreatedAtIsoUtc) && Same(leftJob.ExpiresAtIsoUtc, rightJob.ExpiresAtIsoUtc)
                && Same(leftEnvelope.EnvelopeSchema, rightEnvelope.EnvelopeSchema) && leftEnvelope.Version == rightEnvelope.Version
                && Same(leftEnvelope.CanonicalizationVersion, rightEnvelope.CanonicalizationVersion)
                && Same(leftEnvelope.PolicyHash, rightEnvelope.PolicyHash) && Same(leftEnvelope.PolicyRecordHash, rightEnvelope.PolicyRecordHash)
                && Same(leftEnvelope.EvidenceRecordHash, rightEnvelope.EvidenceRecordHash) && Same(leftEnvelope.RequestHash, rightEnvelope.RequestHash)
                && Same(leftEnvelope.EffectHash, rightEnvelope.EffectHash) && Same(leftEnvelope.Method, rightEnvelope.Method)
                && Same(leftEnvelope.Path, rightEnvelope.Path) && leftEnvelope.BodyPresent == rightEnvelope.BodyPresent
                && Same(leftEnvelope.BodySha256, rightEnvelope.BodySha256) && Same(leftEnvelope.Channel, rightEnvelope.Channel)
                && Same(leftEnvelope.Alias, rightEnvelope.Alias) && Same(leftEnvelope.Workflow, rightEnvelope.Workflow)
                && Same(leftEnvelope.RuntimeMode, rightEnvelope.RuntimeMode) && Same(leftEnvelope.ExposureProfile, rightEnvelope.ExposureProfile)
                && Same(leftEnvelope.PolicyTrustSource, rightEnvelope.PolicyTrustSource)
                && SameAdmission(leftEnvelope.RequestFamilyAdmission, rightEnvelope.RequestFamilyAdmission)
                && Same(leftEnvelope.EnvelopeHash, rightEnvelope.EnvelopeHash);
        }

        private static bool SameAdmission(OperatorCertifiedRequestFamilyAdmission? left, OperatorCertifiedRequestFamilyAdmission? right)
        {
            if (left == null || right == null) return left == null && right == null;
            return Same(left.FamilyId, right.FamilyId)
                && Same(left.FamilyHash, right.FamilyHash)
                && Same(left.RequestInstanceHash, right.RequestInstanceHash)
                && Same(left.AdmissionSessionId, right.AdmissionSessionId)
                && Same(left.Phase, right.Phase)
                && Same(left.PreviewInstanceHash, right.PreviewInstanceHash)
                && Same(left.PreviewReceipt, right.PreviewReceipt)
                && Same(left.PreviewReceiptHash, right.PreviewReceiptHash)
                && Same(left.DocumentFingerprint, right.DocumentFingerprint)
                && Same(left.DocumentSessionId, right.DocumentSessionId)
                && Same(left.SourceScopedId, right.SourceScopedId)
                && Same(left.ObservationId, right.ObservationId)
                && Same(left.ObservationBindingHash, right.ObservationBindingHash)
                && left.ElementId == right.ElementId
                && Same(left.OutboundBodySha256, right.OutboundBodySha256);
        }

        private static readonly HashSet<string> EmptyKeys = new HashSet<string>(StringComparer.Ordinal);

        private static bool HasExactKeys(
            JsonElement value,
            ISet<string> required,
            ISet<string> optional,
            out OperatorCourierFinalExecutionAuthorizationValidationResult? error)
        {
            error = null;
            if (value.ValueKind != JsonValueKind.Object)
            {
                error = Invalid("CERTIFICATION_FINAL_RESPONSE_MALFORMED", "Courier final execution authorization field must be an object.");
                return false;
            }
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!seen.Add(property.Name) || (!required.Contains(property.Name) && !optional.Contains(property.Name)))
                {
                    error = Invalid("CERTIFICATION_FINAL_RESPONSE_MALFORMED", "Courier final execution authorization response contains duplicate or unknown field " + property.Name + ".");
                    return false;
                }
            }
            foreach (var field in required)
            {
                if (!seen.Contains(field))
                {
                    error = Invalid("CERTIFICATION_FINAL_RESPONSE_MALFORMED", "Courier final execution authorization response is missing " + field + ".");
                    return false;
                }
            }
            return true;
        }

        private static bool TryGetUnique(
            JsonElement objectValue,
            string name,
            JsonValueKind expectedKind,
            out JsonElement value,
            out OperatorCourierFinalExecutionAuthorizationValidationResult? error)
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
            if (count != 1 || value.ValueKind != expectedKind)
            {
                error = Invalid("CERTIFICATION_FINAL_RESPONSE_MALFORMED", "Courier final execution authorization response has invalid " + name + ".");
                return false;
            }
            return true;
        }

        private static bool TryString(JsonElement objectValue, string name, out string value, out OperatorCourierFinalExecutionAuthorizationValidationResult? error)
        {
            value = "";
            if (!TryGetUnique(objectValue, name, JsonValueKind.String, out var element, out error)) return false;
            value = element.GetString() ?? "";
            return true;
        }

        private static bool TryStringOrNull(JsonElement objectValue, string name, out string? value, out OperatorCourierFinalExecutionAuthorizationValidationResult? error)
        {
            value = null;
            error = null;
            var count = 0;
            JsonElement element = default;
            foreach (var property in objectValue.EnumerateObject())
            {
                if (!string.Equals(property.Name, name, StringComparison.Ordinal)) continue;
                element = property.Value;
                count++;
            }
            if (count != 1 || (element.ValueKind != JsonValueKind.String && element.ValueKind != JsonValueKind.Null))
            {
                error = Invalid("CERTIFICATION_FINAL_RESPONSE_MALFORMED", "Courier final execution authorization response has invalid " + name + ".");
                return false;
            }
            value = element.ValueKind == JsonValueKind.Null ? null : element.GetString();
            return true;
        }

        private static bool TryOptionalString(JsonElement objectValue, string name, out string? value, out OperatorCourierFinalExecutionAuthorizationValidationResult? error)
        {
            value = null;
            error = null;
            var count = 0;
            JsonElement element = default;
            foreach (var property in objectValue.EnumerateObject())
            {
                if (!string.Equals(property.Name, name, StringComparison.Ordinal)) continue;
                element = property.Value;
                count++;
            }
            if (count == 0) return true;
            if (count != 1 || element.ValueKind != JsonValueKind.String)
            {
                error = Invalid("CERTIFICATION_FINAL_RESPONSE_MALFORMED", "Courier final execution authorization response has invalid " + name + ".");
                return false;
            }
            value = element.GetString();
            return true;
        }

        private static bool TryBoolean(JsonElement objectValue, string name, out bool value, out OperatorCourierFinalExecutionAuthorizationValidationResult? error)
        {
            value = false;
            error = null;
            var count = 0;
            JsonElement element = default;
            foreach (var property in objectValue.EnumerateObject())
            {
                if (!string.Equals(property.Name, name, StringComparison.Ordinal)) continue;
                element = property.Value;
                count++;
            }
            if (count != 1 || (element.ValueKind != JsonValueKind.True && element.ValueKind != JsonValueKind.False))
            {
                error = Invalid("CERTIFICATION_FINAL_RESPONSE_MALFORMED", "Courier final execution authorization response has invalid " + name + ".");
                return false;
            }
            value = element.GetBoolean();
            return true;
        }

        private static bool TryCanonicalUtc(string value, out DateTimeOffset parsed)
        {
            parsed = default;
            if (string.IsNullOrWhiteSpace(value)) return false;
            if (!DateTimeOffset.TryParseExact(
                value,
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out parsed)) return false;
            return string.Equals(
                value,
                parsed.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                StringComparison.Ordinal);
        }

        private static bool Same(string? left, string? right)
        {
            return string.Equals(left, right, StringComparison.Ordinal);
        }

        internal static bool ValidateCompletionChallenge(string? stage, string? challenge, string? challengeHash)
        {
            if (string.Equals(stage, "preflight", StringComparison.Ordinal))
                return challenge == null && challengeHash == null;
            if (!string.Equals(stage, "final", StringComparison.Ordinal)
                || challenge == null
                || challengeHash == null
                || !CompletionChallengePattern.IsMatch(challenge)) return false;
            return string.Equals(
                challengeHash,
                OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(challenge),
                StringComparison.Ordinal);
        }

        private static OperatorCourierFinalExecutionAuthorizationValidationResult Invalid(string code, string error)
        {
            return OperatorCourierFinalExecutionAuthorizationValidationResult.Invalid(code, error);
        }
    }
}

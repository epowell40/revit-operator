using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace RevitBridge.Common
{
    public static class OperatorNativeHttpRuntimeProfile
    {
        public static bool IsExactDevelopmentLaboratory(string? runtimeMode, string? exposureProfile)
        {
            return string.Equals(runtimeMode, "development", StringComparison.Ordinal)
                && string.Equals(exposureProfile, "laboratory", StringComparison.Ordinal);
        }

        public static bool IsExactDeploymentGeneralAgent(string? runtimeMode, string? exposureProfile, string? trustSource)
        {
            return (string.Equals(runtimeMode, "local", StringComparison.Ordinal)
                    || string.Equals(runtimeMode, "hosted", StringComparison.Ordinal)
                    || string.Equals(runtimeMode, "production", StringComparison.Ordinal))
                && string.Equals(exposureProfile, "general", StringComparison.Ordinal)
                && string.Equals(trustSource, "deployment", StringComparison.Ordinal);
        }

        public static string NormalizeCertifiedRuntimeMode(string? runtimeMode)
        {
            var normalized = (runtimeMode ?? "local").Trim().ToLowerInvariant().Replace('-', '_');
            return normalized.Length == 0 ? "local" : normalized;
        }
    }

    public sealed class OperatorNativeHttpRequest
    {
        internal OperatorNativeHttpRequest(string requestId, string method, string path, bool bodyPresent, string bodyJson, string channel, string alias, OperatorCourierCertificationEnvelope? certificationEnvelope = null, string? certificationEnvelopeJson = null)
        {
            RequestId = requestId;
            Method = method;
            Path = path;
            BodyPresent = bodyPresent;
            BodyJson = bodyJson;
            Channel = channel;
            Alias = alias;
            SourceBodySha256 = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(bodyJson);
            CertificationEnvelope = certificationEnvelope;
            CertificationEnvelopeJson = certificationEnvelopeJson;
        }

        public string RequestId { get; }
        public string Method { get; }
        public string Path { get; }
        public bool BodyPresent { get; }
        public string Channel { get; }
        public string Alias { get; }
        public string BodyJson { get; }
        public string SourceBodySha256 { get; }
        public OperatorCourierCertificationEnvelope? CertificationEnvelope { get; }
        public string? CertificationEnvelopeJson { get; }
    }

    public sealed class OperatorNativeHttpAdmissionException : InvalidOperationException, IOperatorRevitFailureMetadata
    {
        public OperatorNativeHttpAdmissionException(
            string code,
            string message,
            int httpStatusCode,
            bool retryable,
            string hostHealth,
            bool opensCircuit = false)
            : base(message)
        {
            Code = code;
            HttpStatusCode = httpStatusCode;
            Retryable = retryable;
            HostHealth = hostHealth;
            OpensCircuit = opensCircuit;
        }

        public string Code { get; }
        public int HttpStatusCode { get; }
        public bool Retryable { get; }
        public string Phase => OperatorNativeHttpAuthorizationReceipt.Phase;
        public string HostHealth { get; }
        public bool OpensCircuit { get; }
        public bool OutcomeUnknown => false;

        public static OperatorNativeHttpAdmissionException InvalidRequest(string message)
            => new OperatorNativeHttpAdmissionException("CERTIFICATION_DIRECT_REQUEST_MALFORMED", message, 400, false, "healthy");

        public static OperatorNativeHttpAdmissionException Unavailable(string message, bool retryable = true)
            => new OperatorNativeHttpAdmissionException("CERTIFICATION_DIRECT_AUTHORIZATION_UNAVAILABLE", message, 503, retryable, "unavailable", retryable);

        public static OperatorNativeHttpAdmissionException Protocol(string code, string message)
            => new OperatorNativeHttpAdmissionException(code, message, 503, false, "degraded", true);
    }

    public static class OperatorNativeHttpRequestFence
    {
        public const int MaximumBodyUtf8Bytes = 2 * 1024 * 1024;
        public const int MaximumJsonDepth = 64;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly Regex CanonicalPath = new Regex(
            @"^/revit/[a-z0-9][a-z0-9._~/-]*$",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex ToolAlias = new Regex(
            @"^[a-z][a-z0-9_]*$",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly JsonDocumentOptions StrictJson = new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = MaximumJsonDepth
        };

        public static OperatorNativeHttpRequest Prepare(
            string? method,
            string? rawPath,
            bool hasQuery,
            bool hasEntityBody,
            byte[]? bodyBytes,
            string? requestId = null,
            string? channel = "generic_call",
            string? alias = "revit_call_tool",
            OperatorCourierCertificationEnvelope? certificationEnvelope = null,
            string? certificationEnvelopeJson = null)
        {
            if (!string.Equals(method, "GET", StringComparison.Ordinal)
                && !string.Equals(method, "POST", StringComparison.Ordinal))
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit requests require canonical GET or POST.");

            var path = rawPath ?? "";
            if (!CanonicalPath.IsMatch(path)
                || path.EndsWith("/", StringComparison.Ordinal)
                || path.Contains("//")
                || HasDotSegment(path))
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit requests require an exact lowercase canonical /revit path.");

            if (hasQuery)
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit requests cannot include an unsigned query string.");

            if ((channel != "search" && channel != "generic_call" && channel != "typed_mcp")
                || string.IsNullOrEmpty(alias)
                || !ToolAlias.IsMatch(alias)
                || (channel == "generic_call" && alias != "revit_call_tool")
                || (channel != "generic_call" && alias == "revit_call_tool"))
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit request channel or alias is invalid.");

            var bytes = bodyBytes ?? Array.Empty<byte>();
            if (bytes.Length > MaximumBodyUtf8Bytes)
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit request body exceeds the 2 MiB UTF-8 limit.");

            if (method == "GET")
            {
                if (hasEntityBody || bytes.Length != 0)
                    throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit GET requests cannot include a body.");
                if (certificationEnvelope != null)
                    throw OperatorNativeHttpAdmissionException.InvalidRequest("Parameterized certification envelopes require a POST body.");
                return new OperatorNativeHttpRequest(ValidateOrCreateRequestId(requestId), method!, path, false, "", channel!, alias!);
            }

            if (!hasEntityBody || bytes.Length == 0)
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit POST requests require a present JSON body.");

            string bodyJson;
            try
            {
                bodyJson = StrictUtf8.GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit request body is not strict UTF-8.");
            }

            try
            {
                using (var document = JsonDocument.Parse(bodyJson, StrictJson))
                {
                    RejectNormalizationChangesAndDuplicateKeys(document.RootElement, "body");
                }
            }
            catch (OperatorNativeHttpAdmissionException)
            {
                throw;
            }
            catch (JsonException)
            {
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit request body must be strict JSON with depth at most 64.");
            }
            catch (ArgumentException)
            {
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit request body contains invalid Unicode normalization data.");
            }

            if ((certificationEnvelope == null) != (certificationEnvelopeJson == null))
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Native certification envelope representation is incomplete.");
            return new OperatorNativeHttpRequest(ValidateOrCreateRequestId(requestId), method!, path, true, bodyJson, channel!, alias!, certificationEnvelope, certificationEnvelopeJson);
        }

        public static bool IsLoopbackEndpoint(IPEndPoint? endpoint)
        {
            if (endpoint?.Address == null) return false;
            var address = endpoint.Address;
            if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
            return IPAddress.IsLoopback(address);
        }

        public static bool TryNormalizeLoopbackPrefix(string? value, out string prefix)
        {
            prefix = "";
            var raw = (value ?? "").Trim();
            if (raw.Length == 0) return false;
            if (!raw.EndsWith("/", StringComparison.Ordinal)) raw += "/";
            if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri)) return false;
            if (!string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
                || !string.IsNullOrEmpty(uri.UserInfo)
                || uri.Port <= 0
                || uri.Port > 65535
                || uri.AbsolutePath != "/"
                || !string.IsNullOrEmpty(uri.Query)
                || !string.IsNullOrEmpty(uri.Fragment)) return false;
            if (!string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase))
            {
                if (!IPAddress.TryParse(uri.Host, out var address) || !IPAddress.IsLoopback(address)) return false;
            }
            prefix = uri.AbsoluteUri;
            return true;
        }

        private static string ValidateOrCreateRequestId(string? requestId)
        {
            var value = string.IsNullOrWhiteSpace(requestId) ? Guid.NewGuid().ToString("N") : requestId!;
            if (value.Length != 32 && value.Length != 64)
                throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit request_id must be 32 or 64 lowercase hexadecimal characters.");
            foreach (var character in value)
            {
                if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
                    throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit request_id must be 32 or 64 lowercase hexadecimal characters.");
            }
            return value;
        }

        private static bool HasDotSegment(string path)
        {
            foreach (var segment in path.Split('/'))
            {
                if (segment == "." || segment == "..") return true;
            }
            return false;
        }

        private static void RejectNormalizationChangesAndDuplicateKeys(JsonElement value, string location)
        {
            switch (value.ValueKind)
            {
                case JsonValueKind.Object:
                    var keys = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var property in value.EnumerateObject())
                    {
                        RequirePolicyNormalized(property.Name, location + " key");
                        var normalized = NormalizeForPolicy(property.Name);
                        if (!keys.Add(normalized))
                            throw OperatorNativeHttpAdmissionException.InvalidRequest("Certified native Revit request body contains duplicate or normalization-colliding object keys.");
                        RejectNormalizationChangesAndDuplicateKeys(property.Value, location + "." + property.Name);
                    }
                    break;
                case JsonValueKind.Array:
                    var index = 0;
                    foreach (var item in value.EnumerateArray())
                    {
                        RejectNormalizationChangesAndDuplicateKeys(item, location + "[" + index.ToString(CultureInfo.InvariantCulture) + "]");
                        index++;
                    }
                    break;
                case JsonValueKind.String:
                    RequirePolicyNormalized(value.GetString() ?? "", location + " string");
                    break;
            }
        }

        private static void RequirePolicyNormalized(string value, string location)
        {
            if (!string.Equals(value, NormalizeForPolicy(value), StringComparison.Ordinal))
                throw OperatorNativeHttpAdmissionException.InvalidRequest(
                    "Certified native Revit request " + location + " must already use NFC and LF-only policy normalization.");
        }

        private static string NormalizeForPolicy(string value)
        {
            return value.Replace("\r\n", "\n").Replace("\r", "\n").Normalize(NormalizationForm.FormC);
        }
    }

    public interface IOperatorNativeHttpAuthorizer
    {
        Task<OperatorNativeHttpAuthorizationReceipt> AuthorizeAsync(
            OperatorNativeHttpRequest request,
            CancellationToken cancellationToken,
            string authorizationStage = "final");
    }

    public sealed class OperatorNativeHttpAuthorizationReceipt
    {
        public const string Version = "revit-operator.revit-direct-final-authorization.v1";
        public const string FamilyVersion = "revit-operator.revit-direct-final-authorization.v2";
        public const string Phase = "certification_native_direct_admission";
        // Exact request binding plus one-use consumption prevents replay. The
        // local window must also survive healthy background/minimized Revit
        // ExternalEvent scheduling, which can exceed five seconds.
        public const int ValidForMilliseconds = 30000;
        private int _consumed;

        internal OperatorNativeHttpAuthorizationReceipt(
            string requestId,
            string method,
            string path,
            bool bodyPresent,
            string channel,
            string alias,
            string sourceBodySha256,
            string canonicalBodyJson,
            string bodySha256,
            string exposureProfile,
            DateTimeOffset authorizedAtUtc,
            DateTimeOffset localExpiresAtUtc,
            string authorizationHash)
        {
            RequestId = requestId;
            Method = method;
            Path = path;
            BodyPresent = bodyPresent;
            Channel = channel;
            Alias = alias;
            SourceBodySha256 = sourceBodySha256;
            CanonicalBodyJson = canonicalBodyJson;
            BodySha256 = bodySha256;
            ExposureProfile = exposureProfile;
            AuthorizedAtUtc = authorizedAtUtc;
            ExpiresAtUtc = localExpiresAtUtc;
            AuthorizationHash = authorizationHash;
        }

        public string RequestId { get; }
        public string Method { get; }
        public string Path { get; }
        public bool BodyPresent { get; }
        public string Channel { get; }
        public string Alias { get; }
        public string SourceBodySha256 { get; }
        public string CanonicalBodyJson { get; }
        public string BodySha256 { get; }
        public string ExposureProfile { get; }
        public bool IsDeploymentGeneralAgent => string.Equals(ExposureProfile, "general", StringComparison.Ordinal);
        public DateTimeOffset AuthorizedAtUtc { get; }
        public DateTimeOffset ExpiresAtUtc { get; }
        public string AuthorizationHash { get; }

        internal bool TryConsume(OperatorNativeHttpRequest request, DateTimeOffset nowUtc, out string code, out string error)
        {
            if (!string.Equals(RequestId, request.RequestId, StringComparison.Ordinal)
                || !string.Equals(Method, request.Method, StringComparison.Ordinal)
                || !string.Equals(Path, request.Path, StringComparison.Ordinal)
                || BodyPresent != request.BodyPresent
                || !string.Equals(Channel, request.Channel, StringComparison.Ordinal)
                || !string.Equals(Alias, request.Alias, StringComparison.Ordinal)
                || !string.Equals(SourceBodySha256, request.SourceBodySha256, StringComparison.Ordinal))
            {
                code = "CERTIFICATION_DIRECT_AUTHORIZATION_MISMATCH";
                error = "Native Revit authorization receipt does not bind the exact request.";
                return false;
            }
            var now = nowUtc.ToUniversalTime();
            if (now >= ExpiresAtUtc)
            {
                code = "CERTIFICATION_DIRECT_AUTHORIZATION_EXPIRED";
                error = "Native Revit authorization receipt is not current.";
                return false;
            }
            if (Interlocked.CompareExchange(ref _consumed, 1, 0) != 0)
            {
                code = "CERTIFICATION_DIRECT_AUTHORIZATION_REPLAY";
                error = "Native Revit authorization receipt has already been consumed.";
                return false;
            }
            code = "CERTIFICATION_DIRECT_AUTHORIZATION_VALID";
            error = "";
            return true;
        }
    }

    public static class OperatorNativeHttpDispatchFence
    {
        public static string RequireFreshOneUse(
            OperatorNativeHttpAuthorizationReceipt? receipt,
            OperatorNativeHttpRequest request,
            DateTimeOffset nowUtc,
            string? expectedCanonicalBodyJson = null)
        {
            if (receipt == null)
                throw OperatorNativeHttpAdmissionException.Protocol(
                    "CERTIFICATION_DIRECT_AUTHORIZATION_MISSING",
                    "Native Revit execution requires a fresh backend authorization receipt.");
            if (expectedCanonicalBodyJson != null
                && !string.Equals(receipt.CanonicalBodyJson, expectedCanonicalBodyJson, StringComparison.Ordinal))
                throw OperatorNativeHttpAdmissionException.Protocol(
                    "CERTIFICATION_DIRECT_EFFECTIVE_BODY_MISMATCH",
                    "Fresh native Revit authorization changed the effective request body.");
            if (receipt.TryConsume(request, nowUtc, out var code, out var error)) return receipt.CanonicalBodyJson;
            if (code == "CERTIFICATION_DIRECT_AUTHORIZATION_EXPIRED")
                throw new OperatorNativeHttpAdmissionException(code, error, 503, true, "unavailable", true);
            if (code == "CERTIFICATION_DIRECT_AUTHORIZATION_REPLAY")
                throw new OperatorNativeHttpAdmissionException(code, error, 409, false, "degraded");
            throw OperatorNativeHttpAdmissionException.Protocol(code, error);
        }

        public static OperatorNativeHttpRequest CreateFreshEffectiveRequest(
            OperatorNativeHttpRequest sourceRequest,
            string canonicalBodyJson)
        {
            if (sourceRequest == null) throw new ArgumentNullException(nameof(sourceRequest));
            var bytes = sourceRequest.BodyPresent
                ? new UTF8Encoding(false, true).GetBytes(canonicalBodyJson ?? "")
                : Array.Empty<byte>();
            return OperatorNativeHttpRequestFence.Prepare(
                sourceRequest.Method,
                sourceRequest.Path,
                hasQuery: false,
                hasEntityBody: sourceRequest.BodyPresent,
                bodyBytes: bytes,
                channel: sourceRequest.Channel,
                alias: sourceRequest.Alias,
                certificationEnvelope: sourceRequest.CertificationEnvelope,
                certificationEnvelopeJson: sourceRequest.CertificationEnvelopeJson);
        }
    }

    public static class OperatorNativeHttpAuthorizationVerifier
    {
        // The backend returns canonical_body_json as a JSON string. Allow for
        // the strict 2 MiB effective body to be escaped at the conservative
        // maximum JSON expansion (for example, one byte becoming a six-byte
        // unicode escape), plus a fixed allowance for the signed receipt.
        public const int MaximumJsonStringExpansionFactor = 6;
        public const int MaximumReceiptOverheadUtf8Bytes = 64 * 1024;
        public const int MaximumSuccessResponseUtf8Bytes =
            (OperatorNativeHttpRequestFence.MaximumBodyUtf8Bytes * MaximumJsonStringExpansionFactor)
            + MaximumReceiptOverheadUtf8Bytes;
        public const int MaximumFailureResponseUtf8Bytes = 64 * 1024;
        public const int MaximumResponseUtf8Bytes = MaximumSuccessResponseUtf8Bytes;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly Regex Sha256 = new Regex("^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly JsonDocumentOptions StrictJson = new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 16
        };
        private static readonly HashSet<string> ResponseKeys = new HashSet<string>(StringComparer.Ordinal) { "ok", "authorization" };
        private static readonly HashSet<string> AuthorizationKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            "version", "phase", "authorized_at", "valid_for_ms", "request_id", "method", "path", "body_present",
            "source_body_sha256", "canonical_body_json", "body_sha256", "policy_hash", "policy_record_hash", "evidence_record_hash", "request_hash", "effect_hash",
            "channel", "alias", "runtime_mode", "exposure_profile", "policy_trust_source", "authorization_hash"
        };
        private static readonly HashSet<string> FamilyAuthorizationKeys = new HashSet<string>(AuthorizationKeys, StringComparer.Ordinal)
        {
            "request_family_admission", "authorization_stage"
        };
        private static readonly HashSet<string> FailureKeys = new HashSet<string>(StringComparer.Ordinal) { "ok", "code", "error", "retryable" };

        public static OperatorNativeHttpAuthorizationReceipt VerifySuccess(
            byte[]? responseBytes,
            OperatorNativeHttpRequest request,
            string? expectedRuntimeMode,
            DateTimeOffset nowUtc,
            TimeSpan? authorizationRoundTrip = null,
            string authorizationStage = "final")
        {
            return VerifySuccess(
                responseBytes,
                request,
                expectedRuntimeMode,
                nowUtc,
                authorizationRoundTrip,
                OperatorNativeToolExposureEmbeddedAuthority.Instance,
                authorizationStage);
        }

        /// <summary>
        /// Explicit authority-injection seam for structural unit tests. Native
        /// production callers use the overload above, which is permanently
        /// anchored to the policy embedded in RevitBridge.Common.
        /// </summary>
        public static OperatorNativeHttpAuthorizationReceipt VerifySuccess(
            byte[]? responseBytes,
            OperatorNativeHttpRequest request,
            string? expectedRuntimeMode,
            DateTimeOffset nowUtc,
            TimeSpan? authorizationRoundTrip,
            IOperatorNativeToolExposureAuthority authority,
            string authorizationStage = "final")
        {
            if (authority == null) throw new ArgumentNullException(nameof(authority));
            var document = ParseResponse(responseBytes, MaximumSuccessResponseUtf8Bytes);
            using (document)
            {
                var root = document.RootElement;
                RequireExactObjectKeys(root, ResponseKeys, "authorization response");
                RequireBoolean(root, "ok", true);
                var authorization = RequireUnique(root, "authorization", JsonValueKind.Object);
                var hasFamilyAdmission = authorization.EnumerateObject().Any(property => property.Name == "request_family_admission");
                RequireExactObjectKeys(authorization, hasFamilyAdmission ? FamilyAuthorizationKeys : AuthorizationKeys, "authorization receipt");

                var version = RequireString(authorization, "version");
                var phase = RequireString(authorization, "phase");
                var authorizedAtText = RequireString(authorization, "authorized_at");
                var validForMs = RequireInt32(authorization, "valid_for_ms");
                var requestId = RequireString(authorization, "request_id");
                var method = RequireString(authorization, "method");
                var path = RequireString(authorization, "path");
                var bodyPresent = RequireBooleanValue(authorization, "body_present");
                var sourceBodySha256 = RequireString(authorization, "source_body_sha256");
                var canonicalBodyJson = RequirePossiblyEmptyString(authorization, "canonical_body_json");
                var bodySha256 = RequireString(authorization, "body_sha256");
                var policyHash = RequireString(authorization, "policy_hash");
                var policyRecordHash = RequireString(authorization, "policy_record_hash");
                var evidenceRecordHash = RequireString(authorization, "evidence_record_hash");
                var requestHash = RequireString(authorization, "request_hash");
                var effectHash = RequireString(authorization, "effect_hash");
                var channel = RequireString(authorization, "channel");
                var alias = RequireString(authorization, "alias");
                var runtimeMode = RequireString(authorization, "runtime_mode");
                var exposureProfile = RequireString(authorization, "exposure_profile");
                var trustSource = RequireString(authorization, "policy_trust_source");
                var authorizationHash = RequireString(authorization, "authorization_hash");

                OperatorCertifiedRequestFamilyAdmission? requestFamilyAdmission = null;
                string? returnedAuthorizationStage = null;
                if (hasFamilyAdmission)
                {
                    returnedAuthorizationStage = RequireString(authorization, "authorization_stage");
                    try { requestFamilyAdmission = OperatorCertifiedRequestFamilyAdmissionVerifier.Parse(RequireUnique(authorization, "request_family_admission", JsonValueKind.Object)); }
                    catch (InvalidDataException invalid)
                    {
                        throw Protocol("CERTIFICATION_DIRECT_REQUEST_FAMILY_INVALID", invalid.Message);
                    }
                }

                var sourceFamilyAdmission = request.CertificationEnvelope?.RequestFamilyAdmission;
                if ((sourceFamilyAdmission == null && (version != OperatorNativeHttpAuthorizationReceipt.Version || requestFamilyAdmission != null))
                    || (sourceFamilyAdmission != null && (version != OperatorNativeHttpAuthorizationReceipt.FamilyVersion || requestFamilyAdmission == null
                        || (authorizationStage != "preflight" && authorizationStage != "final")
                        || returnedAuthorizationStage != authorizationStage))
                    || phase != OperatorNativeHttpAuthorizationReceipt.Phase
                    || validForMs != OperatorNativeHttpAuthorizationReceipt.ValidForMilliseconds)
                    throw Protocol("CERTIFICATION_DIRECT_AUTHORIZATION_SCHEMA_INVALID", "Native Revit authorization schema, phase, or validity is invalid.");
                if (requestId != request.RequestId || method != request.Method || path != request.Path
                    || bodyPresent != request.BodyPresent || sourceBodySha256 != request.SourceBodySha256
                    || channel != request.Channel || alias != request.Alias)
                    throw Protocol("CERTIFICATION_DIRECT_AUTHORIZATION_MISMATCH", "Native Revit authorization response does not bind the exact request.");
                if (!Sha256.IsMatch(sourceBodySha256) || !Sha256.IsMatch(bodySha256) || !Sha256.IsMatch(policyHash) || !Sha256.IsMatch(policyRecordHash)
                    || !Sha256.IsMatch(evidenceRecordHash) || !Sha256.IsMatch(requestHash) || !Sha256.IsMatch(effectHash)
                    || !Sha256.IsMatch(authorizationHash))
                    throw Protocol("CERTIFICATION_DIRECT_AUTHORIZATION_HASH_INVALID", "Native Revit authorization response contains an invalid digest.");
                var deploymentGeneralAgent = OperatorNativeHttpRuntimeProfile.IsExactDeploymentGeneralAgent(
                    runtimeMode,
                    exposureProfile,
                    trustSource);
                if ((channel != "search" && channel != "generic_call" && channel != "typed_mcp")
                    || (exposureProfile != "certified" && !deploymentGeneralAgent)
                    || (trustSource != "bundled" && trustSource != "deployment")
                    || runtimeMode != OperatorNativeHttpRuntimeProfile.NormalizeCertifiedRuntimeMode(expectedRuntimeMode))
                    throw Protocol("CERTIFICATION_DIRECT_AUTHORIZATION_PROFILE_INVALID", "Native Revit authorization response has an invalid channel, runtime, profile, or trust source.");
                if ((!bodyPresent && canonicalBodyJson.Length != 0)
                    || (bodyPresent && canonicalBodyJson.Length == 0)
                    || !string.Equals(
                        bodySha256,
                        OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(canonicalBodyJson),
                        StringComparison.Ordinal))
                    throw Protocol("CERTIFICATION_DIRECT_CANONICAL_BODY_INVALID", "Native Revit authorization response contains an invalid effective body binding.");
                ValidateEffectiveBody(canonicalBodyJson, bodyPresent);
                if (sourceFamilyAdmission != null)
                {
                    var envelope = request.CertificationEnvelope!;
                    if (!SameAdmission(sourceFamilyAdmission, requestFamilyAdmission!)
                        || policyHash != envelope.PolicyHash
                        || policyRecordHash != envelope.PolicyRecordHash
                        || evidenceRecordHash != envelope.EvidenceRecordHash
                        || effectHash != envelope.EffectHash
                        || requestHash != sourceFamilyAdmission.RequestInstanceHash
                        || bodySha256 != sourceFamilyAdmission.OutboundBodySha256)
                        throw Protocol("CERTIFICATION_DIRECT_REQUEST_FAMILY_MISMATCH", "Native Revit authorization changed a sealed request-family or policy binding.");
                    try { OperatorCertifiedRequestFamilyAdmissionVerifier.RequireValidEffectiveBody(requestFamilyAdmission!, canonicalBodyJson); }
                    catch (InvalidDataException invalid)
                    {
                        throw Protocol("CERTIFICATION_DIRECT_REQUEST_FAMILY_INVALID", invalid.Message);
                    }
                }
                if (!DateTimeOffset.TryParseExact(authorizedAtText, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var authorizedAtUtc))
                    throw Protocol("CERTIFICATION_DIRECT_AUTHORIZATION_TIME_INVALID", "Native Revit authorization timestamp is invalid.");

                var computedHash = ComputeAuthorizationHash(authorization);
                if (!string.Equals(computedHash, authorizationHash, StringComparison.Ordinal))
                    throw Protocol("CERTIFICATION_DIRECT_AUTHORIZATION_HASH_MISMATCH", "Native Revit authorization hash is invalid.");

                // authorization_hash is deliberately only an unkeyed receipt
                // mix-up/corruption binding. Certified-profile authority comes
                // from the compiled policy below. Hosted General Agent authority
                // comes from the exact deployment-backed profile returned by the
                // configured authenticated HTTPS backend; it intentionally is not
                // reduced to the static certified allowlist.
                var independentlyComputedRequestHash = requestFamilyAdmission == null
                    ? OperatorNativeToolExposureRequestHash.Compute(method, path, canonicalBodyJson)
                    : requestFamilyAdmission.RequestInstanceHash;
                if (!string.Equals(independentlyComputedRequestHash, requestHash, StringComparison.Ordinal))
                    throw Protocol(
                        "CERTIFICATION_DIRECT_REQUEST_HASH_MISMATCH",
                        "Native Revit authorization request hash does not bind the exact effective request bytes.");
                if (!deploymentGeneralAgent)
                {
                    authority.RequireAuthorized(new OperatorNativeToolExposureBinding(
                        method,
                        path,
                        canonicalBodyJson,
                        policyHash,
                        policyRecordHash,
                        evidenceRecordHash,
                        requestHash,
                        effectHash,
                        channel,
                        alias,
                        requestFamilyAdmission));
                }

                var elapsed = authorizationRoundTrip ?? TimeSpan.Zero;
                if (elapsed < TimeSpan.Zero)
                    throw Protocol("CERTIFICATION_DIRECT_AUTHORIZATION_TIME_INVALID", "Native Revit authorization duration is invalid.");
                var receipt = new OperatorNativeHttpAuthorizationReceipt(
                    requestId,
                    method,
                    path,
                    bodyPresent,
                    channel,
                    alias,
                    sourceBodySha256,
                    canonicalBodyJson,
                    bodySha256,
                    exposureProfile,
                    authorizedAtUtc,
                    // The backend stamps authorized_at when it creates the
                    // response, not when the native request begins. Start the
                    // one-use local dispatch window when that exact HTTPS
                    // response is received. Subtracting the full hosted round
                    // trip made every otherwise valid response taking >= 5s
                    // expire before Revit could consume it.
                    nowUtc.ToUniversalTime().AddMilliseconds(OperatorNativeHttpAuthorizationReceipt.ValidForMilliseconds),
                    authorizationHash);
                return receipt;
            }
        }

        public static OperatorNativeHttpAdmissionException ParseFailure(int statusCode, byte[]? responseBytes)
        {
            try
            {
                var document = ParseResponse(responseBytes, MaximumFailureResponseUtf8Bytes);
                using (document)
                {
                    var root = document.RootElement;
                    RequireExactObjectKeys(root, FailureKeys, "authorization failure");
                    RequireBoolean(root, "ok", false);
                    var code = RequireString(root, "code");
                    var error = RequireString(root, "error");
                    var retryable = RequireBooleanValue(root, "retryable");
                    if (statusCode != 400 && statusCode != 403 && statusCode != 503)
                        throw Protocol("CERTIFICATION_DIRECT_BACKEND_STATUS_INVALID", "Native Revit authorization backend returned an unsupported status.");
                    if (!code.StartsWith("CERTIFICATION_", StringComparison.Ordinal))
                        throw Protocol("CERTIFICATION_DIRECT_BACKEND_FAILURE_INVALID", "Native Revit authorization backend returned an invalid failure code.");
                    return new OperatorNativeHttpAdmissionException(
                        code,
                        error,
                        statusCode,
                        retryable,
                        statusCode == 503 ? "unavailable" : "healthy",
                        statusCode == 503);
                }
            }
            catch (OperatorNativeHttpAdmissionException error)
            {
                return error;
            }
        }

        private static JsonDocument ParseResponse(byte[]? bytes, int maximumUtf8Bytes)
        {
            var value = bytes ?? Array.Empty<byte>();
            if (value.Length == 0 || value.Length > maximumUtf8Bytes)
                throw Protocol("CERTIFICATION_DIRECT_RESPONSE_SIZE_INVALID", "Native Revit authorization response is missing or too large.");
            string json;
            try { json = StrictUtf8.GetString(value); }
            catch (DecoderFallbackException)
            {
                throw Protocol("CERTIFICATION_DIRECT_RESPONSE_UTF8_INVALID", "Native Revit authorization response is not strict UTF-8.");
            }
            try { return JsonDocument.Parse(json, StrictJson); }
            catch (JsonException)
            {
                throw Protocol("CERTIFICATION_DIRECT_RESPONSE_MALFORMED", "Native Revit authorization response is malformed JSON.");
            }
        }

        private static string ComputeAuthorizationHash(JsonElement authorization)
        {
            var values = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var property in authorization.EnumerateObject())
            {
                if (property.Name == "authorization_hash") continue;
                values.Add(property.Name, JsonElementToObject(property.Value));
            }
            var json = JsonSerializer.Serialize(values);
            using (var document = JsonDocument.Parse(json, StrictJson))
            {
                return OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement));
            }
        }

        private static object? JsonElementToObject(JsonElement value)
        {
            switch (value.ValueKind)
            {
                case JsonValueKind.String: return value.GetString();
                case JsonValueKind.Number:
                    if (value.TryGetInt64(out var integer)) return integer;
                    throw Protocol("CERTIFICATION_DIRECT_AUTHORIZATION_NUMBER_INVALID", "Native Revit authorization response contains an unsupported number.");
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Null: return null;
                case JsonValueKind.Object:
                    var objectResult = new Dictionary<string, object?>(StringComparer.Ordinal);
                    foreach (var property in value.EnumerateObject()) objectResult.Add(property.Name, JsonElementToObject(property.Value));
                    return objectResult;
                case JsonValueKind.Array:
                    var arrayResult = new List<object?>();
                    foreach (var item in value.EnumerateArray()) arrayResult.Add(JsonElementToObject(item));
                    return arrayResult;
                default: throw Protocol("CERTIFICATION_DIRECT_AUTHORIZATION_VALUE_INVALID", "Native Revit authorization response contains an unsupported value.");
            }
        }

        private static bool SameAdmission(OperatorCertifiedRequestFamilyAdmission left, OperatorCertifiedRequestFamilyAdmission right)
        {
            return left.FamilyId == right.FamilyId
                && left.FamilyHash == right.FamilyHash
                && left.RequestInstanceHash == right.RequestInstanceHash
                && left.AdmissionSessionId == right.AdmissionSessionId
                && left.Phase == right.Phase
                && left.PreviewInstanceHash == right.PreviewInstanceHash
                && left.PreviewReceipt == right.PreviewReceipt
                && left.PreviewReceiptHash == right.PreviewReceiptHash
                && left.DocumentFingerprint == right.DocumentFingerprint
                && left.DocumentSessionId == right.DocumentSessionId
                && left.SourceScopedId == right.SourceScopedId
                && left.ObservationId == right.ObservationId
                && left.ObservationBindingHash == right.ObservationBindingHash
                && left.ElementId == right.ElementId
                && left.OutboundBodySha256 == right.OutboundBodySha256;
        }

        private static void RequireExactObjectKeys(JsonElement value, HashSet<string> expected, string location)
        {
            if (value.ValueKind != JsonValueKind.Object)
                throw Protocol("CERTIFICATION_DIRECT_RESPONSE_MALFORMED", "Native Revit " + location + " must be an object.");
            var found = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!expected.Contains(property.Name) || !found.Add(property.Name))
                    throw Protocol("CERTIFICATION_DIRECT_RESPONSE_MALFORMED", "Native Revit " + location + " contains unknown or duplicate fields.");
            }
            if (found.Count != expected.Count)
                throw Protocol("CERTIFICATION_DIRECT_RESPONSE_MALFORMED", "Native Revit " + location + " is missing required fields.");
        }

        private static JsonElement RequireUnique(JsonElement value, string name, JsonValueKind kind)
        {
            var count = 0;
            var found = default(JsonElement);
            foreach (var property in value.EnumerateObject())
            {
                if (property.Name != name) continue;
                count++;
                found = property.Value;
            }
            if (count != 1 || found.ValueKind != kind)
                throw Protocol("CERTIFICATION_DIRECT_RESPONSE_MALFORMED", "Native Revit authorization response field " + name + " is invalid.");
            return found;
        }

        private static string RequireString(JsonElement value, string name)
        {
            var element = RequireUnique(value, name, JsonValueKind.String);
            var result = element.GetString() ?? "";
            if (result.Length == 0) throw Protocol("CERTIFICATION_DIRECT_RESPONSE_MALFORMED", "Native Revit authorization response field " + name + " is empty.");
            return result;
        }

        private static string RequirePossiblyEmptyString(JsonElement value, string name)
        {
            return RequireUnique(value, name, JsonValueKind.String).GetString() ?? "";
        }

        private static void ValidateEffectiveBody(string bodyJson, bool bodyPresent)
        {
            if (!bodyPresent) return;
            byte[] bytes;
            try { bytes = StrictUtf8.GetBytes(bodyJson); }
            catch (EncoderFallbackException)
            {
                throw Protocol("CERTIFICATION_DIRECT_CANONICAL_BODY_INVALID", "Native Revit effective body is not strict UTF-8.");
            }
            if (bytes.Length == 0 || bytes.Length > OperatorNativeHttpRequestFence.MaximumBodyUtf8Bytes)
                throw Protocol("CERTIFICATION_DIRECT_CANONICAL_BODY_INVALID", "Native Revit effective body is missing or too large.");
            try
            {
                // Reuse the native source fence for duplicate/NFC/CRLF/depth
                // defenses. Do not independently re-canonicalize numbers here:
                // the backend is the ECMAScript canonicalization authority and
                // the final refresh must return this exact effective body again.
                OperatorNativeHttpRequestFence.Prepare(
                    "POST",
                    "/revit/effective-body-validation",
                    hasQuery: false,
                    hasEntityBody: true,
                    bodyBytes: bytes);
            }
            catch (OperatorNativeHttpAdmissionException)
            {
                throw Protocol("CERTIFICATION_DIRECT_CANONICAL_BODY_INVALID", "Native Revit effective body is not strict bounded JSON.");
            }
        }

        private static int RequireInt32(JsonElement value, string name)
        {
            var element = RequireUnique(value, name, JsonValueKind.Number);
            if (!element.TryGetInt32(out var result))
                throw Protocol("CERTIFICATION_DIRECT_RESPONSE_MALFORMED", "Native Revit authorization response field " + name + " is invalid.");
            return result;
        }

        private static bool RequireBooleanValue(JsonElement value, string name)
        {
            var count = 0;
            var result = false;
            foreach (var property in value.EnumerateObject())
            {
                if (property.Name != name) continue;
                count++;
                if (property.Value.ValueKind == JsonValueKind.True) result = true;
                else if (property.Value.ValueKind == JsonValueKind.False) result = false;
                else throw Protocol("CERTIFICATION_DIRECT_RESPONSE_MALFORMED", "Native Revit authorization response field " + name + " is invalid.");
            }
            if (count != 1) throw Protocol("CERTIFICATION_DIRECT_RESPONSE_MALFORMED", "Native Revit authorization response field " + name + " is missing or duplicated.");
            return result;
        }

        private static void RequireBoolean(JsonElement value, string name, bool expected)
        {
            if (RequireBooleanValue(value, name) != expected)
                throw Protocol("CERTIFICATION_DIRECT_RESPONSE_MALFORMED", "Native Revit authorization response field " + name + " is invalid.");
        }

        private static OperatorNativeHttpAdmissionException Protocol(string code, string message)
            => OperatorNativeHttpAdmissionException.Protocol(code, message);
    }

    public static class OperatorNativeHttpBoundedResponseReader
    {
        public static void EnsureContentLengthWithinLimit(long? contentLength, int maximumBytes)
        {
            if (maximumBytes <= 0)
                throw new ArgumentOutOfRangeException(nameof(maximumBytes));
            if (contentLength.HasValue && (contentLength.Value < 0 || contentLength.Value > maximumBytes))
                throw SizeInvalid();
        }

        public static async Task<byte[]> ReadAsync(
            Stream input,
            int maximumBytes,
            CancellationToken cancellationToken)
        {
            if (input == null) throw new ArgumentNullException(nameof(input));
            if (maximumBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maximumBytes));

            using var output = new MemoryStream(Math.Min(maximumBytes, 64 * 1024));
            var buffer = new byte[Math.Min(4096, maximumBytes)];
            while (true)
            {
                var remaining = maximumBytes - checked((int)output.Length);
                var maximumRead = Math.Min(buffer.Length, remaining + 1);
                var read = await input.ReadAsync(buffer, 0, maximumRead, cancellationToken).ConfigureAwait(false);
                if (read <= 0) break;
                if (read > remaining) throw SizeInvalid();
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }

        private static OperatorNativeHttpAdmissionException SizeInvalid()
            => OperatorNativeHttpAdmissionException.Protocol(
                "CERTIFICATION_DIRECT_RESPONSE_SIZE_INVALID",
                "Native Revit authorization response exceeds the bounded receipt limit.");
    }
}

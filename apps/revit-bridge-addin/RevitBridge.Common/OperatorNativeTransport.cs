using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>
    /// Versioned application-layer protection for direct Sidecar-to-Revit HTTP calls.
    /// The loopback transport is treated as hostile: certified requests use one fixed
    /// outer route and carry no token, correlation id, write grant, target path, or
    /// plaintext action body in HTTP metadata.
    /// </summary>
    public static class OperatorNativeTransportProtocol
    {
        private static readonly HashSet<string> ForbiddenPlaintextHeaders = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "X-Operator-Token",
            "X-Operator-Correlation-Id",
            "X-Operator-Write-Grant"
        };

        public const string Version = "revit-operator.native-transport.v1";
        public const string Algorithm = "A256CBC-HS512";
        public const string TransportMethod = "POST";
        public const string TransportPath = "/revit/operator-transport/v1";
        public const string ContentType = "application/vnd.revit-operator.native-transport+json";
        public const int MaximumRequestEnvelopeUtf8Bytes = 8 * 1024 * 1024;
        public const int MaximumResponseBodyUtf8Bytes = 16 * 1024 * 1024;
        public const int MaximumResponseEnvelopeUtf8Bytes = 48 * 1024 * 1024;
        public const int MaximumWriteGrantUtf8Bytes = 16 * 1024;
        public const int MaximumReplayEntries = 4096;
        public static readonly TimeSpan MaximumMessageAge = TimeSpan.FromSeconds(30);
        public static readonly TimeSpan MaximumFutureSkew = TimeSpan.FromSeconds(10);

        public static bool ContainsForbiddenPlaintextHeader(IEnumerable<string?> headerNames)
        {
            if (headerNames == null) return false;
            foreach (var name in headerNames)
            {
                if (name != null && ForbiddenPlaintextHeaders.Contains(name)) return true;
            }
            return false;
        }
    }

    public sealed class OperatorNativeTransportProtectedRequest
    {
        internal OperatorNativeTransportProtectedRequest(string envelopeJson, string requestId, string requestNonce, string serverEpoch)
        {
            EnvelopeJson = envelopeJson;
            RequestId = requestId;
            RequestNonce = requestNonce;
            ServerEpoch = serverEpoch;
        }

        public string EnvelopeJson { get; }
        public string RequestId { get; }
        public string RequestNonce { get; }
        public string ServerEpoch { get; }
    }

    public sealed class OperatorNativeTransportRequestContext
    {
        internal OperatorNativeTransportRequestContext(
            OperatorNativeHttpRequest request,
            string requestNonce,
            string serverEpoch,
            string writeGrant,
            DateTimeOffset issuedAtUtc,
            OperatorLaboratoryEvidenceDispatch? laboratoryEvidence,
            OperatorLaboratoryMoveEvidenceAdmission? laboratoryMoveEvidenceAdmission)
        {
            Request = request;
            RequestNonce = requestNonce;
            ServerEpoch = serverEpoch;
            WriteGrant = writeGrant;
            IssuedAtUtc = issuedAtUtc;
            LaboratoryEvidence = laboratoryEvidence;
            LaboratoryMoveEvidenceAdmission = laboratoryMoveEvidenceAdmission;
        }

        public OperatorNativeHttpRequest Request { get; }
        public string RequestNonce { get; }
        public string ServerEpoch { get; }
        public string WriteGrant { get; }
        public DateTimeOffset IssuedAtUtc { get; }
        public OperatorLaboratoryEvidenceDispatch? LaboratoryEvidence { get; }
        public OperatorLaboratoryMoveEvidenceAdmission? LaboratoryMoveEvidenceAdmission { get; }
    }

    public sealed class OperatorNativeTransportResponse
    {
        internal OperatorNativeTransportResponse(int statusCode, string bodyJson, DateTimeOffset issuedAtUtc)
        {
            StatusCode = statusCode;
            BodyJson = bodyJson;
            IssuedAtUtc = issuedAtUtc;
        }

        public int StatusCode { get; }
        public string BodyJson { get; }
        public DateTimeOffset IssuedAtUtc { get; }
    }

    /// <summary>
    /// Bounded, in-memory replay fence. A full cache fails closed instead of evicting
    /// a still-live nonce. Revit process restarts create a new receiver lifetime; the
    /// independent timestamp fence limits any cross-restart replay window.
    /// </summary>
    public sealed class OperatorNativeTransportReplayCache
    {
        private readonly object _gate = new object();
        private readonly Dictionary<string, DateTimeOffset> _accepted = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);

        public void Accept(string requestId, string requestNonce, DateTimeOffset nowUtc)
        {
            var key = requestId + ":" + requestNonce;
            lock (_gate)
            {
                var now = nowUtc.ToUniversalTime();
                var expired = new List<string>();
                foreach (var pair in _accepted)
                {
                    if (pair.Value <= now) expired.Add(pair.Key);
                }
                foreach (var item in expired) _accepted.Remove(item);

                if (_accepted.ContainsKey(key))
                    throw OperatorNativeTransportCodec.Failure(
                        "NATIVE_TRANSPORT_REQUEST_REPLAY",
                        "The protected native request was already accepted.",
                        409);
                if (_accepted.Count >= OperatorNativeTransportProtocol.MaximumReplayEntries)
                    throw OperatorNativeTransportCodec.Failure(
                        "NATIVE_TRANSPORT_REPLAY_CACHE_FULL",
                        "The protected native request replay cache is full; retry with a fresh request.",
                        503,
                        retryable: true);

                // Freshness accepts both endpoints of the allowed interval. Keep
                // the replay reservation one tick beyond that inclusive boundary.
                _accepted.Add(
                    key,
                    now + OperatorNativeTransportProtocol.MaximumMessageAge
                        + OperatorNativeTransportProtocol.MaximumFutureSkew
                        + TimeSpan.FromTicks(1));
            }
        }
    }

    public sealed class OperatorNativeTransportHttpResponse
    {
        internal OperatorNativeTransportHttpResponse(int outerStatusCode, string contentType, byte[] bodyUtf8)
        {
            OuterStatusCode = outerStatusCode;
            ContentType = contentType;
            BodyUtf8 = bodyUtf8;
        }

        public int OuterStatusCode { get; }
        public string ContentType { get; }
        public byte[] BodyUtf8 { get; }
    }

    /// <summary>
    /// HTTP-facing certified transport seam. It is independent of HttpListener so
    /// the exact ordering and fail-closed response contract can be behavior-tested
    /// in both supported runtimes.
    /// </summary>
    public static class OperatorNativeTransportHttpAdapter
    {
        public static void ValidateCertifiedOuterRequest(
            string? contentType,
            IEnumerable<string?> headerNames)
        {
            if (OperatorNativeTransportProtocol.ContainsForbiddenPlaintextHeader(headerNames))
                throw OperatorNativeTransportCodec.Failure(
                    "NATIVE_TRANSPORT_PLAINTEXT_CREDENTIAL_REJECTED",
                    "Certified native transport rejects plaintext credential and correlation headers.",
                    400);
            if (!string.Equals(contentType, OperatorNativeTransportProtocol.ContentType, StringComparison.Ordinal))
                throw OperatorNativeTransportCodec.Failure(
                    "NATIVE_TRANSPORT_CONTENT_TYPE_INVALID",
                    "Certified native transport requires its exact protected-envelope content type.",
                    400);
        }

        public static OperatorNativeTransportRequestContext OpenCertifiedRequest(
            string operatorToken,
            string expectedServerEpoch,
            byte[] envelopeUtf8,
            string outerMethod,
            string outerPath,
            bool hasQuery,
            string? contentType,
            IEnumerable<string?> headerNames,
            DateTimeOffset nowUtc,
            OperatorNativeTransportReplayCache replayCache)
        {
            ValidateCertifiedOuterRequest(contentType, headerNames);
            return OperatorNativeTransportCodec.OpenRequest(
                operatorToken,
                expectedServerEpoch,
                envelopeUtf8,
                outerMethod,
                outerPath,
                hasQuery,
                nowUtc,
                replayCache);
        }

        public static OperatorNativeTransportHttpResponse CreateCertifiedResponse(
            string operatorToken,
            OperatorNativeTransportRequestContext request,
            int applicationStatusCode,
            string bodyJson,
            DateTimeOffset nowUtc)
        {
            try
            {
                var envelope = OperatorNativeTransportCodec.ProtectResponse(
                    operatorToken,
                    request,
                    applicationStatusCode,
                    bodyJson,
                    nowUtc);
                return new OperatorNativeTransportHttpResponse(
                    200,
                    OperatorNativeTransportProtocol.ContentType,
                    Encoding.UTF8.GetBytes(envelope));
            }
            catch
            {
                return new OperatorNativeTransportHttpResponse(
                    500,
                    "application/json",
                    Encoding.UTF8.GetBytes("{\"error\":\"Protected native response unavailable.\"}"));
            }
        }
    }

    public static class OperatorNativeTransportCodec
    {
        private const string RequestDirection = "request";
        private const string ResponseDirection = "response";
        private const int IvBytes = 16;
        private const int TagBytes = 32;
        private const int NonceBytes = 32;
        private const int MinimumTokenUtf8Bytes = 32;
        private const int MaximumTokenUtf8Bytes = 4096;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private static readonly JsonDocumentOptions StrictJson = new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 8
        };
        private static readonly JsonWriterOptions CanonicalWriter = new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            Indented = false,
            SkipValidation = false
        };

        public static OperatorNativeTransportProtectedRequest ProtectRequest(
            string operatorToken,
            string serverEpoch,
            string method,
            string path,
            string? bodyJson,
            string? writeGrant,
            DateTimeOffset nowUtc,
            string? requestId = null,
            string? channel = null,
            string? alias = null,
            string? certificationEnvelopeJson = null,
            string? laboratoryEvidenceJson = null,
            string? laboratoryMoveEvidenceAdmissionJson = null)
        {
            return ProtectRequestCore(operatorToken, serverEpoch, method, path, bodyJson, writeGrant, nowUtc, requestId, null, null, channel, alias, certificationEnvelopeJson, laboratoryEvidenceJson, laboratoryMoveEvidenceAdmissionJson);
        }

        internal static OperatorNativeTransportProtectedRequest ProtectRequestCore(
            string operatorToken,
            string serverEpoch,
            string method,
            string path,
            string? bodyJson,
            string? writeGrant,
            DateTimeOffset nowUtc,
            string? requestId,
            byte[]? deterministicNonce,
            byte[]? deterministicIv,
            string? channel = null,
            string? alias = null,
            string? certificationEnvelopeJson = null,
            string? laboratoryEvidenceJson = null,
            string? laboratoryMoveEvidenceAdmissionJson = null)
        {
            var body = bodyJson ?? "";
            var bodyBytes = StrictEncode(body, "Native request body is not strict UTF-8.");
            var bodyPresent = string.Equals(method, "POST", StringComparison.Ordinal);
            var request = OperatorNativeHttpRequestFence.Prepare(
                method,
                path,
                hasQuery: false,
                hasEntityBody: bodyPresent,
                bodyBytes: bodyBytes,
                requestId: requestId,
                channel: channel ?? "generic_call",
                alias: alias ?? "revit_call_tool");
            var nonceBytes = RequireOrGenerateRandom(deterministicNonce, NonceBytes, nameof(deterministicNonce));
            var nonce = Base64UrlEncode(nonceBytes);
            var protectedWriteGrant = writeGrant ?? "";
            if (StrictEncode(protectedWriteGrant, "Native write grant is not strict UTF-8.").Length
                > OperatorNativeTransportProtocol.MaximumWriteGrantUtf8Bytes)
                throw Failure("NATIVE_TRANSPORT_WRITE_GRANT_SIZE_INVALID", "Native write grant exceeds the protected transport limit.", 400);
            OperatorCourierCertificationEnvelope? certificationEnvelope = null;
            JsonElement? certificationEnvelopeElement = null;
            if (certificationEnvelopeJson != null)
            {
                using var certificationDocument = JsonDocument.Parse(certificationEnvelopeJson, StrictJson);
                certificationEnvelopeElement = certificationDocument.RootElement.Clone();
                certificationEnvelope = OperatorCourierCertificationEnvelopeVerifier.VerifyDirectEnvelope(
                    certificationEnvelopeElement.Value,
                    request.Method,
                    request.Path,
                    request.BodyPresent,
                    request.BodyJson,
                    request.Channel,
                    request.Alias);
                request = OperatorNativeHttpRequestFence.Prepare(
                    request.Method, request.Path, false, request.BodyPresent, bodyBytes, request.RequestId,
                    request.Channel, request.Alias, certificationEnvelope, certificationEnvelopeElement.Value.GetRawText());
            }
            JsonElement? laboratoryEvidenceElement = null;
            OperatorLaboratoryEvidenceDispatch? laboratoryEvidence = null;
            if (laboratoryEvidenceJson != null)
            {
                using var laboratoryEvidenceDocument = JsonDocument.Parse(laboratoryEvidenceJson, StrictJson);
                laboratoryEvidence = OperatorLaboratoryEvidenceDispatch.Parse(laboratoryEvidenceDocument.RootElement);
                laboratoryEvidenceElement = laboratoryEvidence.CanonicalObject;
            }
            JsonElement? laboratoryMoveEvidenceAdmissionElement = null;
            if (laboratoryMoveEvidenceAdmissionJson != null)
            {
                if (laboratoryEvidence == null) throw AuthFailure();
                using var moveDocument = JsonDocument.Parse(laboratoryMoveEvidenceAdmissionJson, StrictJson);
                laboratoryMoveEvidenceAdmissionElement = OperatorLaboratoryMoveEvidenceAdmission.Parse(
                    moveDocument.RootElement, laboratoryEvidence).CanonicalObject;
            }
            var inner = SerializeRequestInner(
                request, nonce, protectedWriteGrant, nowUtc.ToUniversalTime(),
                certificationEnvelopeElement, laboratoryEvidenceElement, laboratoryMoveEvidenceAdmissionElement);
            var epoch = RequireServerEpoch(serverEpoch);
            var envelope = Protect(operatorToken, epoch, RequestDirection, inner, deterministicIv);
            if (StrictUtf8.GetByteCount(envelope) > OperatorNativeTransportProtocol.MaximumRequestEnvelopeUtf8Bytes)
                throw Failure("NATIVE_TRANSPORT_ENVELOPE_SIZE_INVALID", "Protected native request envelope exceeds its limit.", 400);
            return new OperatorNativeTransportProtectedRequest(envelope, request.RequestId, nonce, epoch);
        }

        public static OperatorNativeTransportRequestContext OpenRequest(
            string operatorToken,
            string expectedServerEpoch,
            byte[] envelopeUtf8,
            string outerMethod,
            string outerPath,
            bool hasQuery,
            DateTimeOffset nowUtc,
            OperatorNativeTransportReplayCache replayCache)
        {
            if (!string.Equals(outerMethod, OperatorNativeTransportProtocol.TransportMethod, StringComparison.Ordinal)
                || !string.Equals(outerPath, OperatorNativeTransportProtocol.TransportPath, StringComparison.Ordinal)
                || hasQuery)
                throw Failure("NATIVE_TRANSPORT_OUTER_ROUTE_INVALID", "Certified native transport requires its exact fixed outer route.", 400);
            if (replayCache == null) throw new ArgumentNullException(nameof(replayCache));
            if (envelopeUtf8 == null || envelopeUtf8.Length == 0 || envelopeUtf8.Length > OperatorNativeTransportProtocol.MaximumRequestEnvelopeUtf8Bytes)
                throw Failure("NATIVE_TRANSPORT_ENVELOPE_SIZE_INVALID", "Protected native request envelope size is invalid.", 400);

            var epoch = RequireServerEpoch(expectedServerEpoch);
            var plaintext = Open(operatorToken, epoch, RequestDirection, envelopeUtf8, OperatorNativeTransportProtocol.MaximumRequestEnvelopeUtf8Bytes);
            var fields = ParseRequestInner(plaintext);
            var requestId = RequireString(fields, "request_id", 64);
            var nonce = RequireString(fields, "request_nonce", 64);
            var nonceBytes = DecodeBase64Url(nonce, NonceBytes, "request nonce");
            if (!string.Equals(Base64UrlEncode(nonceBytes), nonce, StringComparison.Ordinal))
                throw AuthFailure();
            var issuedAt = FromUnixMilliseconds(RequireInt64(fields, "issued_at_unix_ms"));
            ValidateFreshness(issuedAt, nowUtc, "request");
            var method = RequireString(fields, "method", 8);
            var path = RequireString(fields, "path", 512);
            var bodyPresent = RequireBoolean(fields, "body_present");
            var body = RequireStringAllowEmpty(fields, "body_json", OperatorNativeHttpRequestFence.MaximumBodyUtf8Bytes);
            var channel = RequireString(fields, "channel", 32);
            var alias = RequireString(fields, "alias", 128);
            var writeGrant = RequireStringAllowEmpty(fields, "write_grant", OperatorNativeTransportProtocol.MaximumWriteGrantUtf8Bytes);
            OperatorCourierCertificationEnvelope? certificationEnvelope = null;
            string? certificationEnvelopeJson = null;
            if (fields.TryGetValue("certification_envelope", out var certificationEnvelopeElement))
            {
                if (certificationEnvelopeElement.ValueKind != JsonValueKind.Object) throw AuthFailure();
                certificationEnvelope = OperatorCourierCertificationEnvelopeVerifier.VerifyDirectEnvelope(
                    certificationEnvelopeElement,
                    method,
                    path,
                    bodyPresent,
                    body,
                    channel,
                    alias);
                certificationEnvelopeJson = certificationEnvelopeElement.GetRawText();
            }
            OperatorLaboratoryEvidenceDispatch? laboratoryEvidence = null;
            if (fields.TryGetValue("laboratory_evidence", out var laboratoryEvidenceElement))
                laboratoryEvidence = OperatorLaboratoryEvidenceDispatch.Parse(laboratoryEvidenceElement);
            OperatorLaboratoryMoveEvidenceAdmission? laboratoryMoveEvidenceAdmission = null;
            if (fields.TryGetValue("laboratory_move_evidence_admission", out var moveEvidenceElement))
            {
                if (laboratoryEvidence == null) throw AuthFailure();
                laboratoryMoveEvidenceAdmission = OperatorLaboratoryMoveEvidenceAdmission.Parse(moveEvidenceElement, laboratoryEvidence);
            }
            var bodyBytes = StrictEncode(body, "Protected native request body is not strict UTF-8.");
            var request = OperatorNativeHttpRequestFence.Prepare(
                method,
                path,
                hasQuery: false,
                hasEntityBody: bodyPresent,
                bodyBytes: bodyBytes,
                requestId: requestId,
                channel: channel ?? "generic_call",
                alias: alias ?? "revit_call_tool",
                certificationEnvelope: certificationEnvelope,
                certificationEnvelopeJson: certificationEnvelopeJson);
            if (laboratoryEvidence != null)
                OperatorNativeToolExposureEmbeddedAuthority.Instance.RequireLaboratoryEvidenceAuthorized(
                    laboratoryEvidence, request.Method, request.Path, request.Channel, request.Alias, laboratoryMoveEvidenceAdmission);
            replayCache.Accept(request.RequestId, nonce, nowUtc);
            return new OperatorNativeTransportRequestContext(request, nonce, epoch, writeGrant, issuedAt, laboratoryEvidence, laboratoryMoveEvidenceAdmission);
        }

        public static string ProtectResponse(
            string operatorToken,
            OperatorNativeTransportRequestContext request,
            int statusCode,
            string bodyJson,
            DateTimeOffset nowUtc)
        {
            return ProtectResponseCore(operatorToken, request, statusCode, bodyJson, nowUtc, null);
        }

        internal static string ProtectResponseCore(
            string operatorToken,
            OperatorNativeTransportRequestContext request,
            int statusCode,
            string bodyJson,
            DateTimeOffset nowUtc,
            byte[]? deterministicIv)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            if (statusCode < 100 || statusCode > 599)
                throw Failure("NATIVE_TRANSPORT_RESPONSE_STATUS_INVALID", "Protected native response status is invalid.", 500);
            var bodyBytes = StrictEncode(bodyJson ?? "", "Native response body is not strict UTF-8.");
            if (bodyBytes.Length > OperatorNativeTransportProtocol.MaximumResponseBodyUtf8Bytes)
                throw Failure("NATIVE_TRANSPORT_RESPONSE_SIZE_INVALID", "Native response body exceeds the protected transport limit.", 500);
            var inner = SerializeResponseInner(request, statusCode, bodyJson ?? "", nowUtc.ToUniversalTime());
            var envelope = Protect(operatorToken, request.ServerEpoch, ResponseDirection, inner, deterministicIv);
            if (StrictUtf8.GetByteCount(envelope) > OperatorNativeTransportProtocol.MaximumResponseEnvelopeUtf8Bytes)
                throw Failure("NATIVE_TRANSPORT_RESPONSE_SIZE_INVALID", "Protected native response envelope exceeds its limit.", 500);
            return envelope;
        }

        public static OperatorNativeTransportResponse OpenResponse(
            string operatorToken,
            OperatorNativeTransportProtectedRequest request,
            byte[] envelopeUtf8,
            DateTimeOffset nowUtc)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            if (envelopeUtf8 == null || envelopeUtf8.Length == 0 || envelopeUtf8.Length > OperatorNativeTransportProtocol.MaximumResponseEnvelopeUtf8Bytes)
                throw Failure("NATIVE_TRANSPORT_RESPONSE_SIZE_INVALID", "Protected native response envelope size is invalid.", 502);
            var plaintext = Open(operatorToken, request.ServerEpoch, ResponseDirection, envelopeUtf8, OperatorNativeTransportProtocol.MaximumResponseEnvelopeUtf8Bytes);
            var fields = ParseExactInner(plaintext, ResponseInnerFields, "response");
            var requestId = RequireString(fields, "request_id", 64);
            var requestNonce = RequireString(fields, "request_nonce", 64);
            if (!string.Equals(requestId, request.RequestId, StringComparison.Ordinal)
                || !string.Equals(requestNonce, request.RequestNonce, StringComparison.Ordinal))
                throw Failure("NATIVE_TRANSPORT_RESPONSE_BINDING_INVALID", "Protected native response does not bind the exact request.", 502);
            var issuedAt = FromUnixMilliseconds(RequireInt64(fields, "issued_at_unix_ms"));
            ValidateFreshness(issuedAt, nowUtc, "response");
            var statusCode = RequireInt32(fields, "status_code");
            if (statusCode < 100 || statusCode > 599)
                throw Failure("NATIVE_TRANSPORT_RESPONSE_STATUS_INVALID", "Protected native response status is invalid.", 502);
            var body = RequireStringAllowEmpty(fields, "body_json", OperatorNativeTransportProtocol.MaximumResponseBodyUtf8Bytes);
            return new OperatorNativeTransportResponse(statusCode, body, issuedAt);
        }

        public static string CreateServerEpoch()
        {
            return Base64UrlEncode(RequireOrGenerateRandom(null, 32, "serverEpoch"));
        }

        private static string Protect(string token, string serverEpoch, string direction, byte[] plaintext, byte[]? deterministicIv)
        {
            var epochBytes = DecodeBase64Url(serverEpoch, 32, "server epoch");
            var keys = DeriveKeys(token, direction, epochBytes);
            var iv = RequireOrGenerateRandom(deterministicIv, IvBytes, nameof(deterministicIv));
            byte[] ciphertext;
            using (var aes = Aes.Create())
            {
                aes.KeySize = 256;
                aes.BlockSize = 128;
                aes.Mode = CipherMode.CBC;
                aes.Padding = PaddingMode.PKCS7;
                aes.Key = keys.EncryptionKey;
                aes.IV = iv;
                using var encryptor = aes.CreateEncryptor();
                ciphertext = encryptor.TransformFinalBlock(plaintext, 0, plaintext.Length);
            }
            var tag = ComputeTag(keys.MacKey, serverEpoch, direction, iv, ciphertext);
            return SerializeEnvelope(serverEpoch, direction, iv, ciphertext, tag);
        }

        private static byte[] Open(string token, string expectedServerEpoch, string expectedDirection, byte[] envelopeUtf8, int maximumEnvelopeBytes)
        {
            if (envelopeUtf8.Length > maximumEnvelopeBytes) throw AuthFailure();
            try
            {
                var envelope = ParseEnvelope(envelopeUtf8);
                if (!string.Equals(envelope.ServerEpoch, expectedServerEpoch, StringComparison.Ordinal)
                    || !string.Equals(envelope.Direction, expectedDirection, StringComparison.Ordinal)) throw AuthFailure();
                var epochBytes = DecodeBase64Url(expectedServerEpoch, 32, "server epoch");
                var keys = DeriveKeys(token, expectedDirection, epochBytes);
                var expectedTag = ComputeTag(keys.MacKey, expectedServerEpoch, expectedDirection, envelope.Iv, envelope.Ciphertext);
                if (!FixedTimeEquals(expectedTag, envelope.Tag)) throw AuthFailure();
                using var aes = Aes.Create();
                aes.KeySize = 256;
                aes.BlockSize = 128;
                aes.Mode = CipherMode.CBC;
                aes.Padding = PaddingMode.PKCS7;
                aes.Key = keys.EncryptionKey;
                aes.IV = envelope.Iv;
                using var decryptor = aes.CreateDecryptor();
                return decryptor.TransformFinalBlock(envelope.Ciphertext, 0, envelope.Ciphertext.Length);
            }
            catch (OperatorNativeHttpAdmissionException)
            {
                throw;
            }
            catch (Exception ex) when (ex is JsonException || ex is FormatException || ex is CryptographicException || ex is DecoderFallbackException || ex is ArgumentException || ex is OverflowException)
            {
                throw AuthFailure();
            }
        }

        private static TransportEnvelope ParseEnvelope(byte[] utf8)
        {
            using var document = JsonDocument.Parse(utf8, StrictJson);
            var fields = ExactObject(document.RootElement, EnvelopeFields, "envelope");
            if (!string.Equals(RequireString(fields, "v", 64), OperatorNativeTransportProtocol.Version, StringComparison.Ordinal)
                || !string.Equals(RequireString(fields, "alg", 32), OperatorNativeTransportProtocol.Algorithm, StringComparison.Ordinal))
                throw AuthFailure();
            var direction = RequireString(fields, "dir", 16);
            var epoch = RequireString(fields, "epoch", 64);
            DecodeBase64Url(epoch, 32, "server epoch");
            var iv = DecodeBase64Url(RequireString(fields, "iv", 64), IvBytes, "iv");
            var ciphertext = DecodeBase64Url(RequireString(fields, "ciphertext", OperatorNativeTransportProtocol.MaximumResponseEnvelopeUtf8Bytes), null, "ciphertext");
            var tag = DecodeBase64Url(RequireString(fields, "tag", 64), TagBytes, "tag");
            if (ciphertext.Length == 0 || ciphertext.Length % IvBytes != 0) throw AuthFailure();
            return new TransportEnvelope(epoch, direction, iv, ciphertext, tag);
        }

        private static byte[] SerializeRequestInner(
            OperatorNativeHttpRequest request,
            string nonce,
            string writeGrant,
            DateTimeOffset nowUtc,
            JsonElement? certificationEnvelope,
            JsonElement? laboratoryEvidence,
            JsonElement? laboratoryMoveEvidenceAdmission)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream, CanonicalWriter))
            {
                writer.WriteStartObject();
                writer.WriteString("request_id", request.RequestId);
                writer.WriteString("request_nonce", nonce);
                writer.WriteNumber("issued_at_unix_ms", nowUtc.ToUnixTimeMilliseconds());
                writer.WriteString("method", request.Method);
                writer.WriteString("path", request.Path);
                writer.WriteBoolean("body_present", request.BodyPresent);
                writer.WriteString("body_json", request.BodyJson);
                writer.WriteString("channel", request.Channel);
                writer.WriteString("alias", request.Alias);
                writer.WriteString("write_grant", writeGrant);
                if (certificationEnvelope.HasValue)
                {
                    writer.WritePropertyName("certification_envelope");
                    certificationEnvelope.Value.WriteTo(writer);
                }
                if (laboratoryEvidence.HasValue)
                {
                    writer.WritePropertyName("laboratory_evidence");
                    laboratoryEvidence.Value.WriteTo(writer);
                }
                if (laboratoryMoveEvidenceAdmission.HasValue)
                {
                    writer.WritePropertyName("laboratory_move_evidence_admission");
                    laboratoryMoveEvidenceAdmission.Value.WriteTo(writer);
                }
                writer.WriteEndObject();
            }
            return stream.ToArray();
        }

        private static byte[] SerializeResponseInner(OperatorNativeTransportRequestContext request, int statusCode, string bodyJson, DateTimeOffset nowUtc)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream, CanonicalWriter))
            {
                writer.WriteStartObject();
                writer.WriteString("request_id", request.Request.RequestId);
                writer.WriteString("request_nonce", request.RequestNonce);
                writer.WriteNumber("issued_at_unix_ms", nowUtc.ToUnixTimeMilliseconds());
                writer.WriteNumber("status_code", statusCode);
                writer.WriteString("body_json", bodyJson);
                writer.WriteEndObject();
            }
            return stream.ToArray();
        }

        private static string SerializeEnvelope(string serverEpoch, string direction, byte[] iv, byte[] ciphertext, byte[] tag)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream, CanonicalWriter))
            {
                writer.WriteStartObject();
                writer.WriteString("v", OperatorNativeTransportProtocol.Version);
                writer.WriteString("alg", OperatorNativeTransportProtocol.Algorithm);
                writer.WriteString("epoch", serverEpoch);
                writer.WriteString("dir", direction);
                writer.WriteString("iv", Base64UrlEncode(iv));
                writer.WriteString("ciphertext", Base64UrlEncode(ciphertext));
                writer.WriteString("tag", Base64UrlEncode(tag));
                writer.WriteEndObject();
            }
            return StrictUtf8.GetString(stream.ToArray());
        }

        private static DerivedKeys DeriveKeys(string token, string direction, byte[] serverEpoch)
        {
            var tokenBytes = StrictEncode(token ?? "", "Operator token is not strict UTF-8.");
            if (tokenBytes.Length < MinimumTokenUtf8Bytes || tokenBytes.Length > MaximumTokenUtf8Bytes)
                throw Failure("NATIVE_TRANSPORT_TOKEN_INVALID", "Operator token is unavailable or too short for protected native transport.", 503);
            byte[] prk;
            using (var extract = new HMACSHA512(serverEpoch)) prk = extract.ComputeHash(tokenBytes);
            var info = StrictUtf8.GetBytes(OperatorNativeTransportProtocol.Version + "\0" + direction + "\0A256CBC-HS512");
            var expandInput = new byte[info.Length + 1];
            Buffer.BlockCopy(info, 0, expandInput, 0, info.Length);
            expandInput[expandInput.Length - 1] = 1;
            byte[] okm;
            using (var expand = new HMACSHA512(prk)) okm = expand.ComputeHash(expandInput);
            var mac = new byte[32];
            var enc = new byte[32];
            Buffer.BlockCopy(okm, 0, mac, 0, 32);
            Buffer.BlockCopy(okm, 32, enc, 0, 32);
            return new DerivedKeys(mac, enc);
        }

        private static byte[] ComputeTag(byte[] key, string serverEpoch, string direction, byte[] iv, byte[] ciphertext)
        {
            var aad = StrictUtf8.GetBytes(
                OperatorNativeTransportProtocol.Version + "\n" +
                OperatorNativeTransportProtocol.Algorithm + "\n" +
                serverEpoch + "\n" +
                direction + "\n" +
                OperatorNativeTransportProtocol.TransportMethod + "\n" +
                OperatorNativeTransportProtocol.TransportPath);
            var input = new byte[aad.Length + iv.Length + ciphertext.Length + 8];
            var offset = 0;
            Buffer.BlockCopy(aad, 0, input, offset, aad.Length); offset += aad.Length;
            Buffer.BlockCopy(iv, 0, input, offset, iv.Length); offset += iv.Length;
            Buffer.BlockCopy(ciphertext, 0, input, offset, ciphertext.Length); offset += ciphertext.Length;
            WriteUInt64BigEndian(input, offset, checked((ulong)aad.Length * 8UL));
            byte[] full;
            using (var hmac = new HMACSHA512(key)) full = hmac.ComputeHash(input);
            var tag = new byte[TagBytes];
            Buffer.BlockCopy(full, 0, tag, 0, TagBytes);
            return tag;
        }

        private static void WriteUInt64BigEndian(byte[] target, int offset, ulong value)
        {
            for (var index = 7; index >= 0; index--)
            {
                target[offset + index] = (byte)value;
                value >>= 8;
            }
        }

        private static bool FixedTimeEquals(byte[] left, byte[] right)
        {
            var difference = left.Length ^ right.Length;
            var maximum = Math.Max(left.Length, right.Length);
            for (var index = 0; index < maximum; index++)
            {
                var a = index < left.Length ? left[index] : (byte)0;
                var b = index < right.Length ? right[index] : (byte)0;
                difference |= a ^ b;
            }
            return difference == 0;
        }

        private static byte[] RequireOrGenerateRandom(byte[]? supplied, int length, string name)
        {
            if (supplied != null)
            {
                if (supplied.Length != length) throw new ArgumentException("Deterministic transport input has invalid length.", name);
                return (byte[])supplied.Clone();
            }
            var bytes = new byte[length];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return bytes;
        }

        private static string Base64UrlEncode(byte[] value)
            => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        private static byte[] DecodeBase64Url(string value, int? exactBytes, string location)
        {
            if (string.IsNullOrEmpty(value) || value.IndexOf('=') >= 0)
                throw new FormatException("Invalid base64url " + location + ".");
            foreach (var character in value)
            {
                if (!((character >= 'A' && character <= 'Z')
                    || (character >= 'a' && character <= 'z')
                    || (character >= '0' && character <= '9')
                    || character == '-' || character == '_'))
                    throw new FormatException("Invalid base64url " + location + ".");
            }
            var padded = value.Replace('-', '+').Replace('_', '/');
            switch (padded.Length % 4)
            {
                case 0: break;
                case 2: padded += "=="; break;
                case 3: padded += "="; break;
                default: throw new FormatException("Invalid base64url " + location + ".");
            }
            var decoded = Convert.FromBase64String(padded);
            if (exactBytes.HasValue && decoded.Length != exactBytes.Value)
                throw new FormatException("Invalid base64url " + location + " length.");
            if (!string.Equals(Base64UrlEncode(decoded), value, StringComparison.Ordinal))
                throw new FormatException("Non-canonical base64url " + location + ".");
            return decoded;
        }

        private static byte[] StrictEncode(string value, string error)
        {
            try { return StrictUtf8.GetBytes(value); }
            catch (EncoderFallbackException) { throw Failure("NATIVE_TRANSPORT_UTF8_INVALID", error, 400); }
        }

        private static string RequireServerEpoch(string value)
        {
            var epoch = value ?? "";
            var decoded = DecodeBase64Url(epoch, 32, "server epoch");
            if (!string.Equals(Base64UrlEncode(decoded), epoch, StringComparison.Ordinal)) throw AuthFailure();
            return epoch;
        }

        private static DateTimeOffset FromUnixMilliseconds(long value)
        {
            try { return DateTimeOffset.FromUnixTimeMilliseconds(value).ToUniversalTime(); }
            catch (ArgumentOutOfRangeException) { throw Failure("NATIVE_TRANSPORT_TIMESTAMP_INVALID", "Protected native transport timestamp is invalid.", 400); }
        }

        private static void ValidateFreshness(DateTimeOffset issuedAtUtc, DateTimeOffset nowUtc, string direction)
        {
            var now = nowUtc.ToUniversalTime();
            if (issuedAtUtc > now + OperatorNativeTransportProtocol.MaximumFutureSkew
                || issuedAtUtc < now - OperatorNativeTransportProtocol.MaximumMessageAge)
                throw Failure(
                    "NATIVE_TRANSPORT_" + direction.ToUpperInvariant() + "_EXPIRED",
                    "Protected native " + direction + " timestamp is outside the accepted window.",
                    direction == RequestDirection ? 409 : 502);
        }

        private static Dictionary<string, JsonElement> ParseExactInner(byte[] plaintext, HashSet<string> expected, string location)
        {
            try
            {
                using var document = JsonDocument.Parse(plaintext, StrictJson);
                return ExactObject(document.RootElement, expected, location);
            }
            catch (OperatorNativeHttpAdmissionException) { throw; }
            catch (JsonException) { throw AuthFailure(); }
        }

        private static Dictionary<string, JsonElement> ParseRequestInner(byte[] plaintext)
        {
            try
            {
                using var document = JsonDocument.Parse(plaintext, StrictJson);
                var hasCertificationEnvelope = document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.EnumerateObject().Any(property => property.Name == "certification_envelope");
                var hasLaboratoryEvidence = document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.EnumerateObject().Any(property => property.Name == "laboratory_evidence");
                var hasMoveEvidenceAdmission = document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.EnumerateObject().Any(property => property.Name == "laboratory_move_evidence_admission");
                var expected = new HashSet<string>(RequestInnerFields, StringComparer.Ordinal);
                if (hasCertificationEnvelope) expected.Add("certification_envelope");
                if (hasLaboratoryEvidence) expected.Add("laboratory_evidence");
                if (hasMoveEvidenceAdmission) expected.Add("laboratory_move_evidence_admission");
                return ExactObject(document.RootElement, expected, "request");
            }
            catch (OperatorNativeHttpAdmissionException) { throw; }
            catch (JsonException) { throw AuthFailure(); }
        }

        private static Dictionary<string, JsonElement> ExactObject(JsonElement root, HashSet<string> expected, string location)
        {
            if (root.ValueKind != JsonValueKind.Object) throw AuthFailure();
            var fields = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var property in root.EnumerateObject())
            {
                if (!expected.Contains(property.Name) || fields.ContainsKey(property.Name)) throw AuthFailure();
                fields.Add(property.Name, property.Value.Clone());
            }
            if (fields.Count != expected.Count) throw AuthFailure();
            return fields;
        }

        private static string RequireString(Dictionary<string, JsonElement> fields, string name, int maximumChars)
        {
            var value = RequireStringAllowEmpty(fields, name, maximumChars);
            if (value.Length == 0) throw AuthFailure();
            return value;
        }

        private static string RequireStringAllowEmpty(Dictionary<string, JsonElement> fields, string name, int maximumUtf8Bytes)
        {
            if (!fields.TryGetValue(name, out var element) || element.ValueKind != JsonValueKind.String) throw AuthFailure();
            var value = element.GetString() ?? "";
            if (StrictUtf8.GetByteCount(value) > maximumUtf8Bytes) throw AuthFailure();
            return value;
        }

        private static long RequireInt64(Dictionary<string, JsonElement> fields, string name)
        {
            if (!fields.TryGetValue(name, out var element) || element.ValueKind != JsonValueKind.Number || !element.TryGetInt64(out var value))
                throw AuthFailure();
            return value;
        }

        private static int RequireInt32(Dictionary<string, JsonElement> fields, string name)
        {
            if (!fields.TryGetValue(name, out var element) || element.ValueKind != JsonValueKind.Number || !element.TryGetInt32(out var value))
                throw AuthFailure();
            return value;
        }

        private static bool RequireBoolean(Dictionary<string, JsonElement> fields, string name)
        {
            if (!fields.TryGetValue(name, out var element)) throw AuthFailure();
            if (element.ValueKind == JsonValueKind.True) return true;
            if (element.ValueKind == JsonValueKind.False) return false;
            throw AuthFailure();
        }

        private static OperatorNativeHttpAdmissionException AuthFailure()
            => Failure("NATIVE_TRANSPORT_AUTHENTICATION_FAILED", "Protected native transport authentication failed.", 401);

        internal static OperatorNativeHttpAdmissionException Failure(string code, string message, int status, bool retryable = false)
            => new OperatorNativeHttpAdmissionException(code, message, status, retryable, retryable ? "unavailable" : "healthy", retryable);

        private static readonly HashSet<string> EnvelopeFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "v", "alg", "epoch", "dir", "iv", "ciphertext", "tag"
        };

        private static readonly HashSet<string> RequestInnerFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "request_id", "request_nonce", "issued_at_unix_ms", "method", "path", "body_present", "body_json", "channel", "alias", "write_grant"
        };

        private static readonly HashSet<string> FamilyRequestInnerFields = new HashSet<string>(RequestInnerFields, StringComparer.Ordinal)
        {
            "certification_envelope"
        };

        private static readonly HashSet<string> LaboratoryRequestInnerFields = new HashSet<string>(RequestInnerFields, StringComparer.Ordinal)
        {
            "laboratory_evidence"
        };

        private static readonly HashSet<string> FamilyLaboratoryRequestInnerFields = new HashSet<string>(FamilyRequestInnerFields, StringComparer.Ordinal)
        {
            "laboratory_evidence"
        };

        private static readonly HashSet<string> ResponseInnerFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "request_id", "request_nonce", "issued_at_unix_ms", "status_code", "body_json"
        };

        private sealed class DerivedKeys
        {
            public DerivedKeys(byte[] macKey, byte[] encryptionKey) { MacKey = macKey; EncryptionKey = encryptionKey; }
            public byte[] MacKey { get; }
            public byte[] EncryptionKey { get; }
        }

        private sealed class TransportEnvelope
        {
            public TransportEnvelope(string serverEpoch, string direction, byte[] iv, byte[] ciphertext, byte[] tag)
            {
                ServerEpoch = serverEpoch; Direction = direction; Iv = iv; Ciphertext = ciphertext; Tag = tag;
            }
            public string ServerEpoch { get; }
            public string Direction { get; }
            public byte[] Iv { get; }
            public byte[] Ciphertext { get; }
            public byte[] Tag { get; }
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class OperatorNativeCompletionDocument
    {
        public string Fingerprint { get; }
        public string SessionId { get; }
        public OperatorNativeCompletionDocument(string fingerprint, string sessionId)
        {
            if (fingerprint == null || fingerprint.Length != 64 || fingerprint.Any(c => !"0123456789abcdef".Contains(c))
                || string.IsNullOrWhiteSpace(sessionId) || sessionId.Length > 200 || sessionId.Any(char.IsControl))
                throw new InvalidOperationException("Native completion document identity is unavailable.");
            Fingerprint = fingerprint; SessionId = sessionId;
        }
    }

    /// <summary>The original HTTP payload, serialized once before native queue release.</summary>
    public sealed class OperatorNativeCompletionReply
    {
        public int StatusCode { get; }
        public string BodyJson { get; }
        public OperatorNativeCompletionReply(int statusCode, string bodyJson)
        { StatusCode = statusCode; BodyJson = bodyJson; }
    }

    public sealed class OperatorNativeCompletionReservation
    {
        internal JsonElement Header { get; }
        internal string RequestId { get; }
        internal string? RecordJson;
        internal OperatorNativeCompletionReservation(string requestId, JsonElement header)
        { RequestId = requestId; Header = header; }
    }

    /// <summary>Same-epoch native evidence only. A lookup never authorizes or dispatches Revit work.</summary>
    public sealed class OperatorNativeCompletionStore
    {
        public const string LookupPath = "/revit/operator-completions/v1/read";
        public const string LookupAlias = "operator_recover_native_completion";
        public const string RecordSchema = "revit-operator.native-terminal-completion/v1";
        public const string LookupSchema = "revit-operator.native-completion-lookup/v1";
        public const string ResultSchema = "revit-operator.native-completion-lookup-result/v1";
        public const int MaximumRecords = 4096;
        public const long MaximumStoredBytes = 256L * 1024 * 1024;
        private const int MaximumRecordBytes = 64 * 1024 * 1024;
        private readonly object _gate = new object();
        private readonly Dictionary<string, OperatorNativeCompletionReservation> _pending = new Dictionary<string, OperatorNativeCompletionReservation>(StringComparer.Ordinal);
        private readonly string _root;
        private readonly byte[] _key;
        public string Epoch { get; }
        public string TokenHash { get; }

        // Recovery eligibility only; unsupported handlers still execute normally. These
        // handlers select ActiveUIDocument, except the explicitly excluded note selectors.
        public static bool SupportsRequestedEffect(string requestedEffect) => requestedEffect == "apply" || requestedEffect == "preview";

        public static bool SupportsActiveDocument(string method, string path, string bodyJson)
        {
            if (method != "POST") return false;
            switch (path)
            {
                case "/revit/move-elements": case "/revit/rotate-elements": case "/revit/delete":
                case "/revit/set-parameter": case "/revit/create-text": case "/revit/place-families":
                case "/revit/set-text-note-text": case "/revit/replace-text-note": break;
                default: return false;
            }
            try
            {
                using var body = JsonDocument.Parse(bodyJson);
                if (body.RootElement.ValueKind != JsonValueKind.Object) return false;
                foreach (var property in body.RootElement.EnumerateObject())
                    if (string.Equals(property.Name, "docId", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(property.Name, "familyDocumentId", StringComparison.OrdinalIgnoreCase))
                    {
                        if (property.Value.ValueKind == JsonValueKind.Null) continue;
                        if (property.Value.ValueKind != JsonValueKind.String || !string.IsNullOrWhiteSpace(property.Value.GetString())) return false;
                    }
                return true;
            }
            catch (JsonException) { return false; }
        }

        public OperatorNativeCompletionStore(string token, string epoch, string? root = null)
        {
            if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(epoch)) throw new ArgumentException("Native completion authentication is unavailable.");
            Epoch = epoch; TokenHash = Hash(token);
            using (var derive = new HMACSHA256(Encoding.UTF8.GetBytes(token)))
                _key = derive.ComputeHash(Encoding.UTF8.GetBytes(RecordSchema + "\n" + epoch));
            _root = Path.Combine(root ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RevitOperator", "NativeCompletionOutbox"), Hash(epoch).Substring(7));
        }

        public OperatorNativeCompletionReservation Reserve(OperatorNativeTransportRequestContext transport,
            OperatorNativeHttpAuthorizationReceipt authorization, string dispatchedBody, OperatorNativeCompletionDocument document)
        {
            if (transport.ServerEpoch != Epoch || transport.Request.CertificationEnvelope != null
                || transport.LaboratoryEvidence != null || transport.LaboratoryMoveEvidenceAdmission != null || !authorization.IsDeploymentGeneralAgent
                || !SupportsActiveDocument(transport.Request.Method, transport.Request.Path, dispatchedBody))
                throw new InvalidOperationException("Native completion scope is not supported.");
            var request = transport.Request;
            if (authorization.RequestId != request.RequestId || authorization.Method != request.Method || authorization.Path != request.Path
                || authorization.SourceBodySha256 != request.SourceBodySha256 || dispatchedBody != request.BodyJson
                || authorization.Channel != request.Channel || authorization.Alias != request.Alias || authorization.BodyPresent != request.BodyPresent)
                throw new InvalidOperationException("Native completion authorization identity mismatch.");
            var header = JsonSerializer.SerializeToElement(new
            {
                schema = RecordSchema,
                request = new { server_epoch = Epoch, request_id = request.RequestId, request_nonce_sha256 = Hash(transport.RequestNonce),
                    method = request.Method, path = request.Path, body_present = request.BodyPresent, source_body_sha256 = request.SourceBodySha256,
                    authorized_body_sha256 = authorization.BodySha256, dispatched_body_sha256 = Hash(dispatchedBody), channel = request.Channel, alias = request.Alias },
                authorization = new { authorization_hash = authorization.AuthorizationHash, exposure_profile = authorization.ExposureProfile,
                    authorized_at_utc = authorization.AuthorizedAtUtc.UtcDateTime.ToString("o"), certification_envelope_hash = (string?)null },
                document = new { document_fingerprint = document.Fingerprint, document_session_id = document.SessionId },
                dispatch_started_at_utc = DateTime.UtcNow.ToString("o")
            });
            lock (_gate)
            {
                Directory.CreateDirectory(_root);
                if (_pending.ContainsKey(request.RequestId) || File.Exists(RecordPath(request.RequestId)))
                    throw new InvalidOperationException("Native completion request was already reserved; native replay is forbidden.");
                var files = new DirectoryInfo(_root).GetFiles("*.json");
                var pendingCount = _pending.Values.Count(item => item.RecordJson == null);
                if (files.Length + pendingCount >= MaximumRecords
                    || files.Sum(file => file.Length) + ((long)pendingCount + 1) * MaximumRecordBytes > MaximumStoredBytes)
                    throw new IOException("Native completion storage capacity is unavailable before dispatch.");
                var reservation = new OperatorNativeCompletionReservation(request.RequestId, header);
                _pending.Add(request.RequestId, reservation);
                return reservation;
            }
        }

        public void Complete(OperatorNativeCompletionReservation reservation, OperatorNativeCompletionReply reply,
            OperatorNativeCompletionDocument? after)
        {
            if (reply.StatusCode < 100 || reply.StatusCode > 599
                || Encoding.UTF8.GetByteCount(reply.BodyJson) > OperatorNativeTransportProtocol.MaximumResponseBodyUtf8Bytes)
                throw new IOException("Native completion payload exceeds the transport contract.");
            using var validBody = JsonDocument.Parse(reply.BodyJson);
            lock (_gate)
            {
                if (!_pending.TryGetValue(reservation.RequestId, out var owned) || !ReferenceEquals(owned, reservation))
                    throw new InvalidOperationException("Native completion reservation is not owned by this store.");
                var fields = reservation.Header.EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value.Clone(), StringComparer.Ordinal);
                var before = reservation.Header.GetProperty("document");
                fields["document"] = new { document_fingerprint = before.GetProperty("document_fingerprint").GetString(),
                    document_session_id = before.GetProperty("document_session_id").GetString(),
                    after_document_fingerprint = after?.Fingerprint, after_document_session_id = after?.SessionId };
                fields["completed_at_utc"] = DateTime.UtcNow.ToString("o");
                fields["terminal"] = new { status_code = reply.StatusCode, body_json = reply.BodyJson, body_sha256 = Hash(reply.BodyJson) };
                // One terminal publication. Repeated calls may only repeat the exact original terminal payload/identity.
                if (reservation.RecordJson != null)
                {
                    using var previous = JsonDocument.Parse(reservation.RecordJson);
                    var terminal = previous.RootElement.GetProperty("terminal");
                    var oldDoc = previous.RootElement.GetProperty("document");
                    if (terminal.GetProperty("status_code").GetInt32() != reply.StatusCode || terminal.GetProperty("body_json").GetString() != reply.BodyJson
                        || oldDoc.GetProperty("after_document_fingerprint").GetString() != after?.Fingerprint
                        || oldDoc.GetProperty("after_document_session_id").GetString() != after?.SessionId)
                        throw new InvalidOperationException("Conflicting native completion cannot replace retained evidence.");
                    return;
                }
                var recordJson = JsonSerializer.Serialize(fields);
                var stored = JsonSerializer.Serialize(new { record_json = recordJson, signature = Sign(recordJson) });
                var bytes = Encoding.UTF8.GetBytes(stored);
                if (bytes.Length > MaximumRecordBytes) throw new IOException("Native completion record is too large.");
                var target = RecordPath(reservation.RequestId);
                var temp = target + "." + Guid.NewGuid().ToString("N") + ".pending";
                try
                {
                    using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                    // Move is create-only: never replace an existing terminal record.
                    File.Move(temp, target);
                    reservation.RecordJson = recordJson;
                }
                finally { if (File.Exists(temp)) File.Delete(temp); }
            }
        }

        public OperatorNativeCompletionReply Lookup(OperatorNativeTransportRequestContext lookup)
        {
            if (lookup.ServerEpoch != Epoch || lookup.Request.Method != "POST" || lookup.Request.Path != LookupPath
                || lookup.Request.Channel != "typed_mcp" || lookup.Request.Alias != LookupAlias
                || lookup.Request.CertificationEnvelope != null || lookup.LaboratoryEvidence != null || lookup.LaboratoryMoveEvidenceAdmission != null)
                return Error(409, "native_completion_lookup_identity_invalid");
            try
            {
                using var parsed = JsonDocument.Parse(lookup.Request.BodyJson);
                var query = parsed.RootElement;
                var names = new[] { "schema", "request_id", "request_nonce_sha256", "server_epoch", "method", "path", "body_present", "source_body_sha256", "expected_document_fingerprint" };
                var actual = query.EnumerateObject().Select(p => p.Name).ToArray();
                if (actual.Length != names.Length || actual.Distinct(StringComparer.Ordinal).Count() != names.Length
                    || actual.Any(name => !names.Contains(name)) || query.GetProperty("schema").GetString() != LookupSchema
                    || query.GetProperty("server_epoch").GetString() != Epoch)
                    return Error(409, "native_completion_lookup_identity_invalid");
                var requestId = query.GetProperty("request_id").GetString()!;
                if (!OperatorCorrelationId.IsValid(requestId)) return Error(409, "native_completion_lookup_identity_invalid");
                lock (_gate)
                {
                    var path = RecordPath(requestId);
                    if (File.Exists(path))
                    {
                        var recordJson = ReadVerified(path);
                        using var record = JsonDocument.Parse(recordJson);
                        if (!Matches(query, record.RootElement)) return Error(409, "native_completion_lookup_identity_mismatch");
                        return new OperatorNativeCompletionReply(200, JsonSerializer.Serialize(new { schema = ResultSchema, state = "completed", record_json = recordJson, record_sha256 = Hash(recordJson) }));
                    }
                    if (_pending.TryGetValue(requestId, out var pending))
                    {
                        if (!Matches(query, pending.Header)) return Error(409, "native_completion_lookup_identity_mismatch");
                        return pending.RecordJson == null ? State(202, "pending") : Error(503, "native_completion_storage_unavailable");
                    }
                    return State(404, "not_found");
                }
            }
            catch (Exception error) when (error is JsonException || error is InvalidOperationException || error is KeyNotFoundException || error is FormatException)
            { return Error(409, "native_completion_lookup_invalid"); }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException || error is CryptographicException)
            { return Error(503, "native_completion_storage_unavailable"); }
        }

        private static bool Matches(JsonElement query, JsonElement record)
        {
            var request = record.GetProperty("request");
            foreach (var name in new[] { "request_id", "request_nonce_sha256", "server_epoch", "method", "path", "source_body_sha256" })
                if (query.GetProperty(name).GetString() != request.GetProperty(name).GetString()) return false;
            return query.GetProperty("body_present").GetBoolean() == request.GetProperty("body_present").GetBoolean()
                && query.GetProperty("expected_document_fingerprint").GetString() == record.GetProperty("document").GetProperty("document_fingerprint").GetString();
        }
        private string ReadVerified(string path)
        {
            try
            {
            if (new FileInfo(path).Length > MaximumRecordBytes) throw new IOException("Native completion record is too large.");
            using var stored = JsonDocument.Parse(File.ReadAllText(path, Encoding.UTF8));
            var record = stored.RootElement.GetProperty("record_json").GetString() ?? throw new IOException("Native completion record is missing.");
            var signature = stored.RootElement.GetProperty("signature").GetString() ?? throw new IOException("Native completion signature is missing.");
            var expected = Sign(record);
            var mismatch = signature.Length ^ expected.Length;
            for (var i = 0; i < expected.Length; i++) mismatch |= expected[i] ^ (i < signature.Length ? signature[i] : 0);
            if (mismatch != 0) throw new CryptographicException("Native completion signature invalid.");
            return record;
            }
            catch (Exception error) when (error is JsonException || error is InvalidOperationException || error is KeyNotFoundException || error is ArgumentException)
            { throw new IOException("Native completion stored record is invalid.", error); }
        }
        private string RecordPath(string requestId) => Path.Combine(_root, Hash(requestId).Substring(7) + ".json");
        private string Sign(string value) { using var hmac = new HMACSHA256(_key); return Hex(hmac.ComputeHash(Encoding.UTF8.GetBytes(value))); }
        public static string Hash(string value) { using var hash = SHA256.Create(); return "sha256:" + Hex(hash.ComputeHash(Encoding.UTF8.GetBytes(value))); }
        private static string Hex(byte[] value) => string.Concat(value.Select(b => b.ToString("x2")));
        private static OperatorNativeCompletionReply State(int status, string state) => new OperatorNativeCompletionReply(status, JsonSerializer.Serialize(new { schema = ResultSchema, state }));
        private static OperatorNativeCompletionReply Error(int status, string code) => new OperatorNativeCompletionReply(status, JsonSerializer.Serialize(new { schema = ResultSchema, state = "unavailable", code }));
    }

    public static class OperatorNativeCompletionCapture
    {
        // Called inside the Revit callback. No canceled waiter can cancel this terminal owner.
        public static OperatorNativeCompletionReply Execute(OperatorNativeCompletionStore store, OperatorNativeCompletionReservation reservation,
            Func<OperatorNativeCompletionReply> action, Func<OperatorNativeCompletionDocument?> readAfter, string method, string path, string correlationId,
            string requestedEffect = "apply")
        {
            if (!OperatorNativeCompletionStore.SupportsRequestedEffect(requestedEffect)) throw new ArgumentException("Unsupported completion effect.", nameof(requestedEffect));
            OperatorNativeCompletionDocument? After() { try { return readAfter(); } catch { return null; } }
            OperatorNativeCompletionReply reply;
            try { reply = action(); }
            catch (Exception error)
            {
                // No exception class by itself proves rollback after dispatch.
                var failed = new OperatorNativeCompletionReply(500, JsonSerializer.Serialize(new { ok = false, code = "native_completion_handler_exception",
                    request_dispatched = true, outcome_unknown = true, correlation_id = correlationId,
                    canonical_attempt_settlement = OperatorAttemptSettlement.Unknown(requestedEffect, method, path, "native_completion_handler_exception") }));
                try { store.Complete(reservation, failed, After()); }
                catch (Exception retentionError) { throw new OperatorNativeCompletionUncertainException(retentionError); }
                throw new OperatorNativeCompletionUncertainException(error);
            }
            try { store.Complete(reservation, reply, After()); }
            catch (Exception error) { throw new OperatorNativeCompletionUncertainException(error); }
            return reply;
        }
    }

    public sealed class OperatorNativeCompletionUncertainException : Exception, IOperatorRevitFailureMetadata
    {
        public OperatorNativeCompletionUncertainException(Exception inner)
            : base("Native execution or terminal retention did not establish a recoverable completion; the effect remains unknown.", inner) { }
        public string Code => "native_completion_outcome_unknown";
        public bool Retryable => false;
        public string Phase => "native_completion";
        public string HostHealth => "degraded";
        public bool OpensCircuit => false;
        public bool OutcomeUnknown => true;
    }
}

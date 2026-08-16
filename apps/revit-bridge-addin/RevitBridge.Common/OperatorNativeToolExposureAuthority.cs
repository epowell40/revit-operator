using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    /// <summary>
    /// The independently recomputed bindings presented by a native direct
    /// authorization receipt. Implementations decide whether those bindings
    /// are authorized by an authority outside the receipt itself.
    /// </summary>
    public sealed class OperatorNativeToolExposureBinding
    {
        public OperatorNativeToolExposureBinding(
            string method,
            string path,
            string canonicalBodyJson,
            string policyHash,
            string policyRecordHash,
            string evidenceRecordHash,
            string requestHash,
            string effectHash,
            string channel,
            string alias,
            OperatorCertifiedRequestFamilyAdmission? requestFamilyAdmission = null)
        {
            Method = method;
            Path = path;
            CanonicalBodyJson = canonicalBodyJson;
            PolicyHash = policyHash;
            PolicyRecordHash = policyRecordHash;
            EvidenceRecordHash = evidenceRecordHash;
            RequestHash = requestHash;
            EffectHash = effectHash;
            Channel = channel;
            Alias = alias;
            RequestFamilyAdmission = requestFamilyAdmission;
        }

        public string Method { get; }
        public string Path { get; }
        public string CanonicalBodyJson { get; }
        public string PolicyHash { get; }
        public string PolicyRecordHash { get; }
        public string EvidenceRecordHash { get; }
        public string RequestHash { get; }
        public string EffectHash { get; }
        public string Channel { get; }
        public string Alias { get; }
        public OperatorCertifiedRequestFamilyAdmission? RequestFamilyAdmission { get; }
    }

    /// <summary>
    /// Explicit authority seam. Production verification always uses
    /// <see cref="OperatorNativeToolExposureEmbeddedAuthority.Instance"/>;
    /// the overload accepting this interface exists for structural unit tests.
    /// </summary>
    public interface IOperatorNativeToolExposureAuthority
    {
        void RequireAuthorized(OperatorNativeToolExposureBinding binding);
    }

    public static class OperatorNativeToolExposureRequestHash
    {
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        /// <summary>
        /// Reproduces the backend certification request hash without parsing or
        /// reserializing the effective body. This preserves ECMAScript numeric
        /// spellings such as fractions and exponents byte-for-byte.
        /// </summary>
        public static string Compute(string method, string path, string canonicalBodyJson)
        {
            if (method != "GET" && method != "POST")
                throw OperatorNativeHttpAdmissionException.Protocol(
                    "CERTIFICATION_DIRECT_REQUEST_HASH_INVALID",
                    "Native Revit authorization method cannot be hashed.");
            var requestJson = method == "GET" ? "{}" : canonicalBodyJson;
            if (method == "POST" && string.IsNullOrEmpty(requestJson))
                throw OperatorNativeHttpAdmissionException.Protocol(
                    "CERTIFICATION_DIRECT_REQUEST_HASH_INVALID",
                    "Native Revit authorization body cannot be hashed.");

            // Canonical key order is method, path, request. Method and path are
            // already fenced to ASCII, so their JSON strings have one spelling.
            var payload = "{\"method\":" + JsonSerializer.Serialize(method)
                + ",\"path\":" + JsonSerializer.Serialize(path)
                + ",\"request\":" + requestJson + "}";
            try
            {
                StrictUtf8.GetByteCount(payload);
            }
            catch (EncoderFallbackException)
            {
                throw OperatorNativeHttpAdmissionException.Protocol(
                    "CERTIFICATION_DIRECT_REQUEST_HASH_INVALID",
                    "Native Revit authorization request hash input is not strict UTF-8.");
            }
            return OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(payload);
        }
    }

    /// <summary>
    /// Transport policy shared by OperatorBackendConfig and unit tests.
    /// Loopback origins may use HTTP; every non-loopback origin must use HTTPS.
    /// </summary>
    public static class OperatorNativeToolExposureBackendUriPolicy
    {
        public static Uri RequireValidOrigin(string value)
        {
            var raw = (value ?? "").Trim();
            if (raw.Length == 0 || !Uri.TryCreate(raw.TrimEnd('/') + "/", UriKind.Absolute, out var uri))
                throw new InvalidOperationException("Operator backend URL must be an absolute HTTP(S) origin.");
            if (!string.IsNullOrEmpty(uri.UserInfo)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                || uri.Port <= 0
                || uri.Port > 65535
                || uri.AbsolutePath != "/"
                || !string.IsNullOrEmpty(uri.Query)
                || !string.IsNullOrEmpty(uri.Fragment))
                throw new InvalidOperationException("Operator backend URL must be an HTTP(S) origin without credentials, path, query, or fragment.");

            var loopback = string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase);
            if (!loopback && IPAddress.TryParse(uri.Host, out var address))
            {
                if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
                loopback = IPAddress.IsLoopback(address);
            }
            if (!loopback && uri.Scheme != Uri.UriSchemeHttps)
                throw new InvalidOperationException("Non-loopback Operator backend URLs must use HTTPS.");
            return uri;
        }
    }

    public sealed class OperatorNativeToolExposureEmbeddedAuthority : IOperatorNativeToolExposureAuthority
    {
        public const string CompiledPolicyHash = "sha256:496ffb9803fe06a4a277bf195fb08042065adbac4e13345f9747f59e16734a45";
        public const string ResourceName = "RevitBridge.Common.tool_exposure_policy.v1.json";

        private static readonly Regex Sha256 = new Regex("^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex Alias = new Regex("^[a-z][a-z0-9_]*$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex Path = new Regex("^/revit/[a-z0-9][a-z0-9._~/-]*$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex ExecutorIdentifier = new Regex("^[a-z0-9][a-z0-9._-]*$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly string[] Levels = { "L0", "L1", "L2", "L3", "L4", "L5" };
        private static readonly string[] ChannelNames = { "search", "generic_call", "typed_mcp", "deterministic_workflow" };
        private static readonly HashSet<string> RootKeys = Set("schema", "hash_algorithm", "evidence_schema", "evidence_source_hash", "records", "policy_hash");
        private static readonly HashSet<string> RecordKeys = Set("method", "path", "typed_mcp_aliases", "request_hash", "effect_hash", "evidence_record_hash", "highest_cumulative_level", "observed_levels", "visibility", "channels", "policy_record_hash");
        private static readonly HashSet<string> StandaloneRecordKeys = Set("method", "path", "typed_mcp_aliases", "request_hash", "effect_hash", "evidence_record_hash", "execution_surface", "highest_cumulative_level", "observed_levels", "visibility", "channels", "policy_record_hash");
        private static readonly HashSet<string> FamilyRecordKeys = Set("method", "path", "typed_mcp_aliases", "request_hash", "effect_hash", "evidence_record_hash", "request_family", "highest_cumulative_level", "observed_levels", "visibility", "channels", "policy_record_hash");
        private static readonly HashSet<string> StandaloneFamilyRecordKeys = Set("method", "path", "typed_mcp_aliases", "request_hash", "effect_hash", "evidence_record_hash", "execution_surface", "request_family", "highest_cumulative_level", "observed_levels", "visibility", "channels", "policy_record_hash");
        private static readonly HashSet<string> ExecutionSurfaceKeys = Set("kind", "executor_id", "route_id", "transport");
        private static readonly HashSet<string> RequestFamilyKeys = Set("schema", "id", "validator_hash");
        private static readonly HashSet<string> DecisionKeys = Set("exposed", "required_level", "reason_codes");
        public static readonly OperatorNativeToolExposureEmbeddedAuthority Instance = Load();
        private readonly IReadOnlyList<Record> _records;

        private OperatorNativeToolExposureEmbeddedAuthority(string policyHash, string evidenceSourceHash, IReadOnlyList<Record> records)
        {
            PolicyHash = policyHash;
            EvidenceSourceHash = evidenceSourceHash;
            _records = records;
        }

        public string PolicyHash { get; }
        public string EvidenceSourceHash { get; }
        public int RecordCount => _records.Count;
        public int GenericCallExposedCount => _records.Count(record => record.GenericCallExposed && record.Visibility != "workflow_only");
        public int SearchExposedCount => _records.Count(record => record.SearchExposed && record.Visibility != "workflow_only");
        public int TypedMcpExposedCount => _records.Count(record => record.TypedMcpExposed && record.Visibility != "workflow_only");

        public void RequireAuthorized(OperatorNativeToolExposureBinding binding)
        {
            if (binding == null) throw new ArgumentNullException(nameof(binding));
            if (!string.Equals(binding.PolicyHash, PolicyHash, StringComparison.Ordinal)) Deny();
            var matches = _records.Where(record =>
                record.Method == binding.Method
                && record.Path == binding.Path
                && record.PolicyRecordHash == binding.PolicyRecordHash
                && record.EvidenceRecordHash == binding.EvidenceRecordHash
                && record.EffectHash == binding.EffectHash
                && (record.RequestFamily == null
                    ? binding.RequestFamilyAdmission == null && record.RequestHash == binding.RequestHash
                    : binding.RequestFamilyAdmission != null
                        && binding.RequestHash == binding.RequestFamilyAdmission.RequestInstanceHash
                        && record.RequestFamily.Id == binding.RequestFamilyAdmission.FamilyId
                        && record.RequestFamily.ValidatorHash == binding.RequestFamilyAdmission.FamilyHash)).ToList();
            if (matches.Count != 1 || matches[0].Visibility == "workflow_only") Deny();
            var record = matches[0];
            if (binding.RequestFamilyAdmission != null)
            {
                try
                {
                    OperatorCertifiedRequestFamilyAdmissionVerifier.RequireValidEffectiveBody(
                        binding.RequestFamilyAdmission,
                        binding.CanonicalBodyJson);
                }
                catch (InvalidDataException)
                {
                    Deny();
                }
                var expectedEffectHash = OperatorCertifiedRequestFamilyAdmissionVerifier.ExpectedEffectHash(
                    binding.RequestFamilyAdmission);
                if (!string.Equals(binding.EffectHash, expectedEffectHash, StringComparison.Ordinal)) Deny();
            }
            var authorized = binding.Channel == "generic_call"
                ? record.GenericCallExposed && binding.Alias == "revit_call_tool"
                : (binding.Channel == "typed_mcp" && record.TypedMcpExposed
                    || binding.Channel == "search" && record.SearchExposed)
                    && binding.Alias != "revit_call_tool"
                    && record.TypedMcpAliases.Contains(binding.Alias);
            if (!authorized) Deny();
        }

        private static void Deny()
        {
            throw new OperatorNativeHttpAdmissionException(
                "CERTIFICATION_DIRECT_POLICY_ATTESTATION_DENIED",
                "Native Revit authorization is not independently allowed by the embedded certification policy.",
                403,
                false,
                "healthy");
        }

        private static OperatorNativeToolExposureEmbeddedAuthority Load()
        {
            try
            {
                using var stream = typeof(OperatorNativeToolExposureEmbeddedAuthority).Assembly.GetManifestResourceStream(ResourceName)
                    ?? throw new InvalidDataException("Embedded certification policy resource is missing.");
                using var reader = new StreamReader(stream, new UTF8Encoding(false, true), false);
                var raw = reader.ReadToEnd();
                using var document = JsonDocument.Parse(raw, new JsonDocumentOptions
                {
                    AllowTrailingCommas = false,
                    CommentHandling = JsonCommentHandling.Disallow,
                    MaxDepth = 64
                });
                var root = document.RootElement;
                RequireExactKeys(root, RootKeys, "policy");
                RequireString(root, "schema", "revit-operator.tool-exposure-policy.v1");
                RequireString(root, "hash_algorithm", "sha256");
                RequireString(root, "evidence_schema", "revit-operator.tool-certification-evidence.v1");
                var evidenceSourceHash = RequireHash(root, "evidence_source_hash");
                var policyHash = RequireHash(root, "policy_hash");
                if (policyHash != CompiledPolicyHash)
                    throw new InvalidDataException("Embedded certification policy does not match the compiled trust anchor.");
                if (HashCanonicalObjectWithout(root, "policy_hash") != policyHash)
                    throw new InvalidDataException("Embedded certification policy hash is invalid.");

                var recordsElement = Unique(root, "records", JsonValueKind.Array);
                var records = new List<Record>();
                var identities = new HashSet<string>(StringComparer.Ordinal);
                foreach (var element in recordsElement.EnumerateArray())
                {
                    var hasExecutionSurface = element.EnumerateObject().Any(property => property.Name == "execution_surface");
                    var hasRequestFamily = element.EnumerateObject().Any(property => property.Name == "request_family");
                    RequireExactKeys(element,
                        hasExecutionSurface
                            ? (hasRequestFamily ? StandaloneFamilyRecordKeys : StandaloneRecordKeys)
                            : (hasRequestFamily ? FamilyRecordKeys : RecordKeys),
                        "policy record");
                    var method = RequireOneOf(element, "method", "GET", "POST");
                    var path = RequireString(element, "path");
                    if (!Path.IsMatch(path) || path.EndsWith("/", StringComparison.Ordinal) || path.Contains("//") || HasDotSegment(path))
                        throw new InvalidDataException("Embedded certification policy path is noncanonical.");
                    var typedMcpAliases = RequireAliases(element);
                    if (hasExecutionSurface) RequireExecutionSurface(element);
                    var requestFamily = hasRequestFamily ? RequireRequestFamily(element) : null;
                    var requestHash = RequireHash(element, "request_hash");
                    var effectHash = RequireHash(element, "effect_hash");
                    var evidenceRecordHash = RequireHash(element, "evidence_record_hash");
                    RequireLevels(element);
                    var visibility = RequireOneOf(element, "visibility", "candidate", "workflow_only");
                    var channels = Unique(element, "channels", JsonValueKind.Object);
                    RequireExactKeys(channels, Set(ChannelNames), "policy channels");
                    var genericCallExposed = false;
                    var searchExposed = false;
                    var typedMcpExposed = false;
                    foreach (var channel in ChannelNames)
                    {
                        var decision = Unique(channels, channel, JsonValueKind.Object);
                        RequireExactKeys(decision, DecisionKeys, "policy channel decision");
                        var exposed = RequireBoolean(decision, "exposed");
                        RequireOneOf(decision, "required_level", Levels);
                        RequireStringArray(decision, "reason_codes");
                        if (channel == "generic_call") genericCallExposed = exposed;
                        if (channel == "search") searchExposed = exposed;
                        if (channel == "typed_mcp") typedMcpExposed = exposed;
                    }
                    var recordHash = RequireHash(element, "policy_record_hash");
                    if (HashCanonicalObjectWithout(element, "policy_record_hash") != recordHash)
                        throw new InvalidDataException("Embedded certification policy record hash is invalid.");
                    var identity = method + "\n" + path + "\n" + requestHash + "\n" + effectHash
                        + "\n" + (requestFamily?.Id ?? "") + "\n" + (requestFamily?.ValidatorHash ?? "");
                    if (!identities.Add(identity)) throw new InvalidDataException("Embedded certification policy has duplicate exact records.");
                    records.Add(new Record(method, path, requestHash, effectHash, evidenceRecordHash, recordHash, visibility, genericCallExposed, searchExposed, typedMcpExposed, typedMcpAliases, requestFamily));
                }
                if (records.Count == 0) throw new InvalidDataException("Embedded certification policy has no records.");
                return new OperatorNativeToolExposureEmbeddedAuthority(policyHash, evidenceSourceHash, records);
            }
            catch (OperatorNativeHttpAdmissionException)
            {
                throw;
            }
            catch (Exception error)
            {
                throw OperatorNativeHttpAdmissionException.Protocol(
                    "CERTIFICATION_DIRECT_EMBEDDED_POLICY_INVALID",
                    "Embedded native Revit certification policy is unavailable or invalid: " + error.Message);
            }
        }

        private static string HashCanonicalObjectWithout(JsonElement value, string excludedKey)
        {
            var builder = new StringBuilder();
            WriteCanonical(value, builder, excludedKey);
            return OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(builder.ToString());
        }

        private static void WriteCanonical(JsonElement value, StringBuilder builder, string? excludedKey = null)
        {
            switch (value.ValueKind)
            {
                case JsonValueKind.Object:
                    builder.Append('{');
                    var first = true;
                    foreach (var property in value.EnumerateObject().Where(item => item.Name != excludedKey).OrderBy(item => item.Name, StringComparer.Ordinal))
                    {
                        if (!first) builder.Append(',');
                        first = false;
                        builder.Append(JsonSerializer.Serialize(Normalize(property.Name)));
                        builder.Append(':');
                        WriteCanonical(property.Value, builder);
                    }
                    builder.Append('}');
                    return;
                case JsonValueKind.Array:
                    builder.Append('[');
                    var index = 0;
                    foreach (var item in value.EnumerateArray())
                    {
                        if (index++ > 0) builder.Append(',');
                        WriteCanonical(item, builder);
                    }
                    builder.Append(']');
                    return;
                case JsonValueKind.String:
                    builder.Append(JsonSerializer.Serialize(Normalize(value.GetString() ?? "")));
                    return;
                case JsonValueKind.True: builder.Append("true"); return;
                case JsonValueKind.False: builder.Append("false"); return;
                case JsonValueKind.Null: builder.Append("null"); return;
                default: throw new InvalidDataException("Embedded certification policy contains an unsupported JSON value.");
            }
        }

        private static string Normalize(string value)
            => value.Replace("\r\n", "\n").Replace("\r", "\n").Normalize(NormalizationForm.FormC);

        private static void RequireExactKeys(JsonElement value, HashSet<string> expected, string location)
        {
            if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException(location + " must be an object.");
            var found = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!expected.Contains(property.Name) || !found.Add(property.Name))
                    throw new InvalidDataException(location + " contains an unknown or duplicate field.");
            }
            if (found.Count != expected.Count) throw new InvalidDataException(location + " is missing a field.");
        }

        private static JsonElement Unique(JsonElement value, string name, JsonValueKind kind)
        {
            var count = 0;
            var result = default(JsonElement);
            foreach (var property in value.EnumerateObject())
            {
                if (property.Name != name) continue;
                count++;
                result = property.Value;
            }
            if (count != 1 || result.ValueKind != kind) throw new InvalidDataException("Embedded certification policy field " + name + " is invalid.");
            return result;
        }

        private static string RequireString(JsonElement value, string name)
        {
            var result = Unique(value, name, JsonValueKind.String).GetString() ?? "";
            if (result.Length == 0 || result != Normalize(result)) throw new InvalidDataException("Embedded certification policy string " + name + " is invalid.");
            return result;
        }

        private static void RequireString(JsonElement value, string name, string expected)
        {
            if (RequireString(value, name) != expected) throw new InvalidDataException("Embedded certification policy field " + name + " is unsupported.");
        }

        private static string RequireOneOf(JsonElement value, string name, params string[] expected)
        {
            var result = RequireString(value, name);
            if (!expected.Contains(result, StringComparer.Ordinal)) throw new InvalidDataException("Embedded certification policy field " + name + " is unsupported.");
            return result;
        }

        private static string RequireHash(JsonElement value, string name)
        {
            var result = RequireString(value, name);
            if (!Sha256.IsMatch(result)) throw new InvalidDataException("Embedded certification policy hash " + name + " is invalid.");
            return result;
        }

        private static bool RequireBoolean(JsonElement value, string name)
        {
            var element = Unique(value, name, JsonValueKind.True, JsonValueKind.False);
            return element.GetBoolean();
        }

        private static JsonElement Unique(JsonElement value, string name, params JsonValueKind[] kinds)
        {
            var count = 0;
            var result = default(JsonElement);
            foreach (var property in value.EnumerateObject())
            {
                if (property.Name != name) continue;
                count++;
                result = property.Value;
            }
            if (count != 1 || !kinds.Contains(result.ValueKind)) throw new InvalidDataException("Embedded certification policy field " + name + " is invalid.");
            return result;
        }

        private static HashSet<string> RequireAliases(JsonElement record)
        {
            var aliases = StringArray(record, "typed_mcp_aliases");
            for (var index = 0; index < aliases.Count; index++)
            {
                if (!Alias.IsMatch(aliases[index]) || aliases[index] == "revit_call_tool"
                    || (index > 0 && string.CompareOrdinal(aliases[index - 1], aliases[index]) >= 0))
                    throw new InvalidDataException("Embedded certification policy aliases are invalid.");
            }
            return new HashSet<string>(aliases, StringComparer.Ordinal);
        }

        private static void RequireExecutionSurface(JsonElement record)
        {
            var surface = Unique(record, "execution_surface", JsonValueKind.Object);
            RequireExactKeys(surface, ExecutionSurfaceKeys, "policy execution surface");
            RequireString(surface, "kind", "standalone_executor");
            RequireString(surface, "transport", "direct_loopback");
            RequireExecutorIdentifier(surface, "executor_id");
            RequireExecutorIdentifier(surface, "route_id");
        }

        public void RequireLaboratoryEvidenceAuthorized(
            OperatorLaboratoryEvidenceDispatch evidence,
            string method,
            string path,
            string channel,
            string alias,
            OperatorLaboratoryMoveEvidenceAdmission? moveAdmission)
        {
            if (evidence == null || evidence.PolicyHash != PolicyHash || evidence.Channel != channel || evidence.Alias != alias) Deny();
            var matches = _records.Where(record => record.Method == method && record.Path == path
                && record.PolicyRecordHash == evidence.PolicyRecordHash
                && record.EvidenceRecordHash == evidence.EvidenceRecordHash
                && record.EffectHash == evidence.EffectHash
                && record.Visibility != "workflow_only"
                && record.TypedMcpAliases.Contains(alias)).ToList();
            if (matches.Count != 1) Deny();
            var record = matches[0];
            if (moveAdmission == null)
            {
                if (record.RequestFamily != null) Deny();
                return;
            }
            if (moveAdmission.PolicyHash != evidence.PolicyHash
                || moveAdmission.PolicyRecordHash != evidence.PolicyRecordHash
                || moveAdmission.EvidenceRecordHash != evidence.EvidenceRecordHash
                || moveAdmission.EffectHash != evidence.EffectHash
                || record.RequestFamily == null
                || record.RequestFamily.Id != moveAdmission.RequestFamilyId
                || record.RequestFamily.ValidatorHash != moveAdmission.RequestFamilyHash) Deny();
        }

        private static RequestFamily RequireRequestFamily(JsonElement record)
        {
            var family = Unique(record, "request_family", JsonValueKind.Object);
            RequireExactKeys(family, RequestFamilyKeys, "policy request family");
            RequireString(family, "schema", "revit-operator.certified-request-family.v1");
            var id = RequireString(family, "id");
            if (!ExecutorIdentifier.IsMatch(id)) throw new InvalidDataException("Embedded certification policy request family identifier is invalid.");
            return new RequestFamily(id, RequireHash(family, "validator_hash"));
        }

        private static void RequireExecutorIdentifier(JsonElement surface, string name)
        {
            var value = RequireString(surface, name);
            if (!ExecutorIdentifier.IsMatch(value))
                throw new InvalidDataException("Embedded certification policy execution surface identifier " + name + " is invalid.");
        }

        private static void RequireLevels(JsonElement record)
        {
            var highest = Unique(record, "highest_cumulative_level", JsonValueKind.String, JsonValueKind.Null);
            if (highest.ValueKind == JsonValueKind.String && !Levels.Contains(highest.GetString(), StringComparer.Ordinal))
                throw new InvalidDataException("Embedded certification policy highest level is invalid.");
            var observed = StringArray(record, "observed_levels");
            var previous = -1;
            foreach (var level in observed)
            {
                var current = Array.IndexOf(Levels, level);
                if (current < 0 || current <= previous) throw new InvalidDataException("Embedded certification policy observed levels are invalid.");
                previous = current;
            }
        }

        private static void RequireStringArray(JsonElement value, string name)
        {
            foreach (var item in StringArray(value, name))
            {
                if (item.Length == 0) throw new InvalidDataException("Embedded certification policy string array is invalid.");
            }
        }

        private static List<string> StringArray(JsonElement value, string name)
        {
            var array = Unique(value, name, JsonValueKind.Array);
            var result = new List<string>();
            foreach (var item in array.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String) throw new InvalidDataException("Embedded certification policy array " + name + " is invalid.");
                var text = item.GetString() ?? "";
                if (text != Normalize(text)) throw new InvalidDataException("Embedded certification policy array string is noncanonical.");
                result.Add(text);
            }
            return result;
        }

        private static bool HasDotSegment(string path)
            => path.Split('/').Any(segment => segment == "." || segment == "..");

        private static HashSet<string> Set(params string[] values)
            => new HashSet<string>(values, StringComparer.Ordinal);

        private sealed class Record
        {
            public Record(string method, string path, string requestHash, string effectHash, string evidenceRecordHash, string policyRecordHash, string visibility, bool genericCallExposed, bool searchExposed, bool typedMcpExposed, HashSet<string> typedMcpAliases, RequestFamily? requestFamily)
            {
                Method = method;
                Path = path;
                RequestHash = requestHash;
                EffectHash = effectHash;
                EvidenceRecordHash = evidenceRecordHash;
                PolicyRecordHash = policyRecordHash;
                Visibility = visibility;
                GenericCallExposed = genericCallExposed;
                SearchExposed = searchExposed;
                TypedMcpExposed = typedMcpExposed;
                TypedMcpAliases = typedMcpAliases;
                RequestFamily = requestFamily;
            }

            public string Method { get; }
            public string Path { get; }
            public string RequestHash { get; }
            public string EffectHash { get; }
            public string EvidenceRecordHash { get; }
            public string PolicyRecordHash { get; }
            public string Visibility { get; }
            public bool GenericCallExposed { get; }
            public bool SearchExposed { get; }
            public bool TypedMcpExposed { get; }
            public HashSet<string> TypedMcpAliases { get; }
            public RequestFamily? RequestFamily { get; }
        }

        private sealed class RequestFamily
        {
            public RequestFamily(string id, string validatorHash) { Id = id; ValidatorHash = validatorHash; }
            public string Id { get; }
            public string ValidatorHash { get; }
        }
    }
}

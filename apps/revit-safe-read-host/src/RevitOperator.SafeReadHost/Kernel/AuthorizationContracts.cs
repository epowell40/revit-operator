using System;
using System.Threading;
using System.Threading.Tasks;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal sealed class FixedBackendOrigin
    {
        private FixedBackendOrigin(string value)
        {
            Value = value;
        }

        public string Value { get; private set; }

        public static bool TryCreate(string? configured, out FixedBackendOrigin? origin)
        {
            origin = null;
            if (configured == null || configured.Length == 0 ||
                !string.Equals(configured, configured.Trim(), StringComparison.Ordinal))
                return false;
            Uri? uri;
            if (!Uri.TryCreate(configured, UriKind.Absolute, out uri) || uri == null)
                return false;
            if (uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0)
                return false;
            if (uri.AbsolutePath.Length != 0 && !string.Equals(uri.AbsolutePath, "/", StringComparison.Ordinal))
                return false;
            bool secure = string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.Ordinal);
            bool localHttp = string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.Ordinal) &&
                             string.Equals(uri.Host, "127.0.0.1", StringComparison.Ordinal);
            if (!secure && !localHttp)
                return false;
            origin = new FixedBackendOrigin(uri.GetLeftPart(UriPartial.Authority));
            return true;
        }

        public bool EqualsExact(FixedBackendOrigin? other)
        {
            return other != null && string.Equals(Value, other.Value, StringComparison.Ordinal);
        }
    }

    internal sealed class RuntimeAttestationTuple
    {
        public RuntimeAttestationTuple(
            string hostContentSha256,
            string hostMvid,
            string revitApiContentSha256,
            string revitApiMvid,
            string revitVersion)
        {
            HostContentSha256 = hostContentSha256 ?? string.Empty;
            HostMvid = hostMvid ?? string.Empty;
            RevitApiContentSha256 = revitApiContentSha256 ?? string.Empty;
            RevitApiMvid = revitApiMvid ?? string.Empty;
            RevitVersion = revitVersion ?? string.Empty;
        }

        public string HostContentSha256 { get; private set; }
        public string HostMvid { get; private set; }
        public string RevitApiContentSha256 { get; private set; }
        public string RevitApiMvid { get; private set; }
        public string RevitVersion { get; private set; }

        public bool IsValid()
        {
            return ProtocolValidation.IsSha256(HostContentSha256) &&
                   ProtocolValidation.IsCanonicalGuid(HostMvid) &&
                   ProtocolValidation.IsSha256(RevitApiContentSha256) &&
                   ProtocolValidation.IsCanonicalGuid(RevitApiMvid) &&
                   ProtocolValidation.IsBoundedProtocolToken(RevitVersion, 32);
        }
    }

    internal sealed class AuthorizationDocument
    {
        public AuthorizationDocument(string projectFingerprint, string documentSessionId)
        {
            ProjectFingerprint = projectFingerprint ?? string.Empty;
            DocumentSessionId = documentSessionId ?? string.Empty;
        }

        public string ProjectFingerprint { get; private set; }
        public string DocumentSessionId { get; private set; }

        public bool IsValid()
        {
            return ProtocolValidation.IsSha256(ProjectFingerprint) &&
                   ProtocolValidation.IsCanonicalGuid(DocumentSessionId);
        }
    }

    internal sealed class AuthorizationImmutableFields
    {
        public AuthorizationImmutableFields(
            string routeId,
            string hostInstanceId,
            string executorId,
            string runtimeAttestationSha256,
            RuntimeAttestationTuple runtimeTuple,
            AuthorizationDocument document,
            string clientSessionId,
            string requestId,
            string attemptId,
            string capabilityNonceSha256)
        {
            RouteId = routeId ?? string.Empty;
            HostInstanceId = hostInstanceId ?? string.Empty;
            ExecutorId = executorId ?? string.Empty;
            RuntimeAttestationSha256 = runtimeAttestationSha256 ?? string.Empty;
            RuntimeTuple = runtimeTuple;
            Document = document;
            ClientSessionId = clientSessionId ?? string.Empty;
            RequestId = requestId ?? string.Empty;
            AttemptId = attemptId ?? string.Empty;
            CapabilityNonceSha256 = capabilityNonceSha256 ?? string.Empty;
        }

        public string RouteId { get; private set; }
        public string HostInstanceId { get; private set; }
        public string ExecutorId { get; private set; }
        public string RuntimeAttestationSha256 { get; private set; }
        public RuntimeAttestationTuple RuntimeTuple { get; private set; }
        public AuthorizationDocument Document { get; private set; }
        public string ClientSessionId { get; private set; }
        public string RequestId { get; private set; }
        public string AttemptId { get; private set; }
        public string CapabilityNonceSha256 { get; private set; }

        public bool IsValid()
        {
            return string.Equals(RouteId, SafeReadContract.RouteId, StringComparison.Ordinal) &&
                   ProtocolValidation.IsCanonicalGuid(HostInstanceId) &&
                   string.Equals(ExecutorId, SafeReadContract.ExecutorId, StringComparison.Ordinal) &&
                   ProtocolValidation.IsSha256(RuntimeAttestationSha256) &&
                   RuntimeTuple != null && RuntimeTuple.IsValid() &&
                   Document != null && Document.IsValid() &&
                   ProtocolValidation.IsCanonicalGuid(ClientSessionId) &&
                   ProtocolValidation.IsCanonicalGuid(RequestId) &&
                   ProtocolValidation.IsCanonicalGuid(AttemptId) &&
                   ProtocolValidation.IsSha256(CapabilityNonceSha256);
        }

        public AuthorizationPublicBindings ToPublicBindings()
        {
            return new AuthorizationPublicBindings(
                RouteId,
                HostInstanceId,
                ExecutorId,
                RuntimeAttestationSha256,
                RuntimeTuple,
                Document,
                ClientSessionId,
                RequestId,
                AttemptId);
        }
    }

    internal sealed class AuthorizationPublicBindings
    {
        public AuthorizationPublicBindings(
            string routeId,
            string hostInstanceId,
            string executorId,
            string runtimeAttestationSha256,
            RuntimeAttestationTuple runtimeTuple,
            AuthorizationDocument document,
            string clientSessionId,
            string requestId,
            string attemptId)
        {
            RouteId = routeId ?? string.Empty;
            HostInstanceId = hostInstanceId ?? string.Empty;
            ExecutorId = executorId ?? string.Empty;
            RuntimeAttestationSha256 = runtimeAttestationSha256 ?? string.Empty;
            RuntimeTuple = runtimeTuple;
            Document = document;
            ClientSessionId = clientSessionId ?? string.Empty;
            RequestId = requestId ?? string.Empty;
            AttemptId = attemptId ?? string.Empty;
        }

        public string RouteId { get; private set; }
        public string HostInstanceId { get; private set; }
        public string ExecutorId { get; private set; }
        public string RuntimeAttestationSha256 { get; private set; }
        public RuntimeAttestationTuple RuntimeTuple { get; private set; }
        public AuthorizationDocument Document { get; private set; }
        public string ClientSessionId { get; private set; }
        public string RequestId { get; private set; }
        public string AttemptId { get; private set; }

        public bool IsValid()
        {
            return string.Equals(RouteId, SafeReadContract.RouteId, StringComparison.Ordinal) &&
                   ProtocolValidation.IsCanonicalGuid(HostInstanceId) &&
                   string.Equals(ExecutorId, SafeReadContract.ExecutorId, StringComparison.Ordinal) &&
                   ProtocolValidation.IsSha256(RuntimeAttestationSha256) &&
                   RuntimeTuple != null && RuntimeTuple.IsValid() &&
                   Document != null && Document.IsValid() &&
                   ProtocolValidation.IsCanonicalGuid(ClientSessionId) &&
                   ProtocolValidation.IsCanonicalGuid(RequestId) &&
                   ProtocolValidation.IsCanonicalGuid(AttemptId);
        }
    }

    internal sealed class PreauthorizationRequest
    {
        public PreauthorizationRequest(AuthorizationImmutableFields fields)
        {
            Schema = SafeReadContract.PreauthorizationRequestSchema;
            Fields = fields;
        }

        public string Schema { get; private set; }
        public AuthorizationImmutableFields Fields { get; private set; }
    }

    internal sealed class PreauthorizationResponse
    {
        public PreauthorizationResponse(
            string schema,
            string capabilityId,
            string bindingsHash,
            string issuedAtUtc,
            string expiresAtUtc)
        {
            Schema = schema ?? string.Empty;
            CapabilityId = capabilityId ?? string.Empty;
            BindingsHash = bindingsHash ?? string.Empty;
            IssuedAtUtc = issuedAtUtc ?? string.Empty;
            ExpiresAtUtc = expiresAtUtc ?? string.Empty;
        }

        public string Schema { get; private set; }
        public string CapabilityId { get; private set; }
        public string BindingsHash { get; private set; }
        public string IssuedAtUtc { get; private set; }
        public string ExpiresAtUtc { get; private set; }
    }

    internal sealed class FinalAuthorizationRequest
    {
        public FinalAuthorizationRequest(
            AuthorizationPublicBindings fields,
            string capabilityId,
            string capabilityNonce)
        {
            Schema = SafeReadContract.FinalAuthorizationRequestSchema;
            Fields = fields;
            CapabilityId = capabilityId ?? string.Empty;
            CapabilityNonce = capabilityNonce ?? string.Empty;
        }

        public string Schema { get; private set; }
        public AuthorizationPublicBindings Fields { get; private set; }
        public string CapabilityId { get; private set; }
        public string CapabilityNonce { get; private set; }
    }

    internal sealed class FinalAuthorizationReceipt
    {
        public FinalAuthorizationReceipt(
            string schema,
            AuthorizationPublicBindings fields,
            string capabilityId,
            string bindingsHash,
            string receiptId,
            string issuedAtUtc,
            string expiresAtUtc,
            string hmacSha256)
        {
            Schema = schema ?? string.Empty;
            Fields = fields;
            CapabilityId = capabilityId ?? string.Empty;
            BindingsHash = bindingsHash ?? string.Empty;
            ReceiptId = receiptId ?? string.Empty;
            IssuedAtUtc = issuedAtUtc ?? string.Empty;
            ExpiresAtUtc = expiresAtUtc ?? string.Empty;
            HmacSha256 = hmacSha256 ?? string.Empty;
        }

        public string Schema { get; private set; }
        public AuthorizationPublicBindings Fields { get; private set; }
        public string CapabilityId { get; private set; }
        public string BindingsHash { get; private set; }
        public string ReceiptId { get; private set; }
        public string IssuedAtUtc { get; private set; }
        public string ExpiresAtUtc { get; private set; }
        public string HmacSha256 { get; private set; }
    }

    internal interface ISafeReadAuthorizationClient
    {
        FixedBackendOrigin? Origin { get; }
        Task<PreauthorizationResponse?> PreauthorizeAsync(PreauthorizationRequest request, CancellationToken cancellationToken);
        Task<FinalAuthorizationReceipt?> FinalAuthorizeAsync(FinalAuthorizationRequest request, CancellationToken cancellationToken);
        bool VerifyReceiptHmac(FinalAuthorizationReceipt receipt, string capabilityNonce);
    }

    internal sealed class DenyAllSafeReadAuthorizationClient : ISafeReadAuthorizationClient
    {
        public DenyAllSafeReadAuthorizationClient(FixedBackendOrigin? origin)
        {
            Origin = origin;
        }

        public FixedBackendOrigin? Origin { get; private set; }

        public Task<PreauthorizationResponse?> PreauthorizeAsync(
            PreauthorizationRequest request,
            CancellationToken cancellationToken)
        {
            return Task.FromResult<PreauthorizationResponse?>(null);
        }

        public Task<FinalAuthorizationReceipt?> FinalAuthorizeAsync(
            FinalAuthorizationRequest request,
            CancellationToken cancellationToken)
        {
            return Task.FromResult<FinalAuthorizationReceipt?>(null);
        }

        public bool VerifyReceiptHmac(FinalAuthorizationReceipt receipt, string capabilityNonce)
        {
            return false;
        }
    }
}

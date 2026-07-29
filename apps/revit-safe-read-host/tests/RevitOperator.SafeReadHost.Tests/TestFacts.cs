using System;
using RevitOperator.SafeReadHost.Kernel;

namespace RevitOperator.SafeReadHost.Tests
{
    internal static class TestFacts
    {
        public const string HostInstanceId = "11111111-1111-1111-1111-111111111111";
        public const string DocumentSessionId = "22222222-2222-2222-2222-222222222222";
        public const string ClientSessionId = "33333333-3333-3333-3333-333333333333";
        public const string RequestId = "44444444-4444-4444-4444-444444444444";
        public const string AttemptId = "55555555-5555-5555-5555-555555555555";
        public const string HostMvid = "66666666-6666-6666-6666-666666666666";
        public const string RevitApiMvid = "77777777-7777-7777-7777-777777777777";
        public static readonly string CapabilityId = "src1_" + new string('G', 43);
        public static readonly string ReceiptId = "srr1_" + new string('H', 43);
        public static readonly string StartupToken = new string('A', SafeReadContract.Base64UrlSecretLength);
        public static readonly string CapabilityNonce = new string('B', SafeReadContract.Base64UrlSecretLength);
        public static readonly string ProjectFingerprint = "sha256:" + new string('c', 64);
        public static readonly string ContentSha = "sha256:" + new string('d', 64);
        public static readonly string RevitApiSha = "sha256:" + new string('e', 64);
        public static readonly string AttestationSha = "sha256:" + new string('2', 64);
        public static readonly string BindingsHash = "sha256:" + new string('f', 64);
        public static readonly string Hmac = "sha256:" + new string('1', 64);

        public static InstanceIdentity Identity()
        {
            return new InstanceIdentity(HostInstanceId, StartupToken);
        }

        public static DocumentBinding Binding(object? runtimeIdentity = null, bool isModified = false)
        {
            return new DocumentBinding(
                runtimeIdentity ?? new object(),
                ProjectFingerprint,
                DocumentSessionId,
                isModified);
        }

        public static CertifiedRequestFacts ValidRequest()
        {
            return new CertifiedRequestFacts
            {
                Method = SafeReadContract.Method,
                RawTarget = SafeReadContract.Path,
                RemoteEndpointIsIpv4Loopback = true,
                IsChunked = false,
                HasTransferEncoding = false,
                HasContentEncoding = false,
                ContentLength = SafeReadContract.RequestByteCount,
                ContentType = SafeReadContract.ContentType,
                Body = SafeReadContract.CopyRequestBytes(),
                StartupToken = StartupToken,
                HostInstanceId = HostInstanceId,
                DocumentSessionId = DocumentSessionId,
                ClientSessionId = ClientSessionId,
                RequestId = RequestId,
                AttemptId = AttemptId,
                CapabilityNonce = CapabilityNonce
            };
        }

        public static AuthorizationImmutableFields AuthorizationFields()
        {
            return new AuthorizationImmutableFields(
                SafeReadContract.RouteId,
                HostInstanceId,
                SafeReadContract.ExecutorId,
                AttestationSha,
                new RuntimeAttestationTuple(
                    ContentSha,
                    HostMvid,
                    RevitApiSha,
                    RevitApiMvid,
                    "2025"),
                new AuthorizationDocument(ProjectFingerprint, DocumentSessionId),
                ClientSessionId,
                RequestId,
                AttemptId,
                ProtocolValidation.Sha256Digest(CapabilityNonce));
        }
    }
}

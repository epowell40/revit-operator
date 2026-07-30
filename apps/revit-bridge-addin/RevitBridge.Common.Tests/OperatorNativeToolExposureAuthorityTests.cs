using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeToolExposureAuthorityTests
    {
        private const string EarlyRequestId = "0123456789abcdef0123456789abcdef";
        private const string FinalRequestId = "fedcba9876543210fedcba9876543210";
        private const string PingPolicyRecordHash = "sha256:562c15fa462ecb29483575d4f5f5e50b4758d01ad7120164bcd9b912bac76764";
        private const string PingEvidenceRecordHash = "sha256:2ca9b4f041441c78f12a4f538c68bdb0762cad5af1e410f73ae344ef412e8744";
        private const string PingRequestHash = "sha256:0b796e96f4f2c01cc134330c807ec1f27ae71aa8474245c3d5bba51d0fe2ca43";
        private const string ReadEffectHash = "sha256:0f19ae675c51b10854e3977070ad34e4898a004c4a724058f933c17233f37bf8";

        [Fact]
        public void EmbeddedPolicyIsPinnedStrictAndCurrentlyAllDeny()
        {
            var authority = OperatorNativeToolExposureEmbeddedAuthority.Instance;

            Assert.Equal(OperatorNativeToolExposureEmbeddedAuthority.CompiledPolicyHash, authority.PolicyHash);
            Assert.Equal("sha256:e46f5e2b4409bc1ab5d74886930d3ef711bb3d3d14136350b38ed4f36a6b58b8", authority.EvidenceSourceHash);
            Assert.Equal(25, authority.RecordCount);
            Assert.Equal(0, authority.GenericCallExposedCount);
            Assert.Contains(
                OperatorNativeToolExposureEmbeddedAuthority.ResourceName,
                typeof(OperatorNativeToolExposureEmbeddedAuthority).Assembly.GetManifestResourceNames());
        }

        [Fact]
        public void RequestHashWrapsFractionalCanonicalBodyWithoutNumericReserialization()
        {
            const string canonicalBody = "{\"fraction\":1.5,\"small\":0.000001}";
            Assert.Equal(
                "sha256:3a24c8c31995d0da7aa241bda357a96e8c5c6d5176215222116c1a03daff4212",
                OperatorNativeToolExposureRequestHash.Compute("POST", "/revit/ping", canonicalBody));
            Assert.Equal(PingRequestHash, OperatorNativeToolExposureRequestHash.Compute("GET", "/revit/ping", ""));
        }

        [Fact]
        public void SelfHashedBackendReceiptCannotAuthorizeEarlyOrFinalDispatch()
        {
            var dispatches = 0;
            foreach (var requestId in new[] { EarlyRequestId, FinalRequestId })
            {
                var request = PreparePing(requestId);
                var receiptBytes = ReceiptBytes(request, ExactPingBindings());
                var error = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                {
                    var receipt = OperatorNativeHttpAuthorizationVerifier.VerifySuccess(
                        receiptBytes,
                        request,
                        "local",
                        DateTimeOffset.UtcNow,
                        TimeSpan.FromMilliseconds(5));
                    OperatorNativeHttpDispatchFence.RequireFreshOneUse(receipt, request, DateTimeOffset.UtcNow);
                    dispatches++;
                });
                Assert.Equal("CERTIFICATION_DIRECT_POLICY_ATTESTATION_DENIED", error.Code);
                Assert.Equal(0, dispatches);
            }
        }

        [Theory]
        [InlineData("policy_hash")]
        [InlineData("policy_record_hash")]
        [InlineData("evidence_record_hash")]
        [InlineData("request_hash")]
        [InlineData("effect_hash")]
        public void EveryPolicyBindingMismatchFailsClosed(string field)
        {
            var request = PreparePing(EarlyRequestId);
            var bindings = ExactPingBindings();
            bindings[field] = "sha256:" + new string('f', 64);

            var error = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeHttpAuthorizationVerifier.VerifySuccess(
                    ReceiptBytes(request, bindings),
                    request,
                    "local",
                    DateTimeOffset.UtcNow,
                    TimeSpan.FromMilliseconds(5)));

            Assert.Contains(error.Code, new[]
            {
                "CERTIFICATION_DIRECT_POLICY_ATTESTATION_DENIED",
                "CERTIFICATION_DIRECT_REQUEST_HASH_MISMATCH"
            });
        }

        [Theory]
        [InlineData("http://127.0.0.1:7007/", "http://127.0.0.1:7007/")]
        [InlineData("http://localhost:7007", "http://localhost:7007/")]
        [InlineData("http://[::1]:7007/", "http://[::1]:7007/")]
        [InlineData("https://operator.example.com", "https://operator.example.com/")]
        public void BackendUriPolicyAcceptsLoopbackHttpAndAnyHttpsOrigin(string input, string expected)
        {
            Assert.Equal(expected, OperatorNativeToolExposureBackendUriPolicy.RequireValidOrigin(input).AbsoluteUri);
        }

        [Theory]
        [InlineData("http://operator.example.com")]
        [InlineData("http://10.0.0.1:7007")]
        [InlineData("https://user:password@operator.example.com")]
        [InlineData("https://operator.example.com/path")]
        [InlineData("https://operator.example.com/?query=1")]
        [InlineData("ftp://operator.example.com")]
        [InlineData("not a uri")]
        public void BackendUriPolicyRejectsCleartextRemoteCredentialsAndNonOrigins(string input)
        {
            Assert.Throws<InvalidOperationException>(() =>
                OperatorNativeToolExposureBackendUriPolicy.RequireValidOrigin(input));
        }

        private static OperatorNativeHttpRequest PreparePing(string requestId)
            => OperatorNativeHttpRequestFence.Prepare(
                "GET",
                "/revit/ping",
                hasQuery: false,
                hasEntityBody: false,
                bodyBytes: Array.Empty<byte>(),
                requestId: requestId);

        private static Dictionary<string, object?> ExactPingBindings()
            => new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["policy_hash"] = OperatorNativeToolExposureEmbeddedAuthority.CompiledPolicyHash,
                ["policy_record_hash"] = PingPolicyRecordHash,
                ["evidence_record_hash"] = PingEvidenceRecordHash,
                ["request_hash"] = PingRequestHash,
                ["effect_hash"] = ReadEffectHash
            };

        private static byte[] ReceiptBytes(
            OperatorNativeHttpRequest request,
            Dictionary<string, object?> bindings)
        {
            var authorization = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["version"] = OperatorNativeHttpAuthorizationReceipt.Version,
                ["phase"] = OperatorNativeHttpAuthorizationReceipt.Phase,
                ["authorized_at"] = "2026-07-29T12:00:00.000Z",
                ["valid_for_ms"] = 5000,
                ["request_id"] = request.RequestId,
                ["method"] = request.Method,
                ["path"] = request.Path,
                ["body_present"] = false,
                ["source_body_sha256"] = request.SourceBodySha256,
                ["canonical_body_json"] = "",
                ["body_sha256"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(""),
                ["policy_hash"] = bindings["policy_hash"],
                ["policy_record_hash"] = bindings["policy_record_hash"],
                ["evidence_record_hash"] = bindings["evidence_record_hash"],
                ["request_hash"] = bindings["request_hash"],
                ["effect_hash"] = bindings["effect_hash"],
                ["channel"] = "generic_call",
                ["runtime_mode"] = "local",
                ["exposure_profile"] = "certified",
                ["policy_trust_source"] = "bundled"
            };
            authorization["authorization_hash"] = AuthorizationHash(authorization);
            var response = JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["authorization"] = authorization
            });
            return new UTF8Encoding(false, true).GetBytes(response);
        }

        private static string AuthorizationHash(Dictionary<string, object?> authorization)
        {
            var payload = authorization
                .Where(pair => pair.Key != "authorization_hash")
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            return OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement));
        }
    }
}

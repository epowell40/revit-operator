using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeHttpAdmissionTests
    {
        private const string RequestId = "0123456789abcdef0123456789abcdef";
        private static readonly IOperatorNativeToolExposureAuthority StructuralTestAuthority = new StructuralAllowAuthority();

        [Theory]
        [InlineData("development", "laboratory", true)]
        [InlineData("Development", "laboratory", false)]
        [InlineData("development", " laboratory ", false)]
        [InlineData("development", "certified", false)]
        [InlineData("local", "laboratory", false)]
        [InlineData(null, null, false)]
        public void LaboratoryBypassRequiresTheExactRuntimePair(string? runtimeMode, string? profile, bool expected)
        {
            Assert.Equal(expected, OperatorNativeHttpRuntimeProfile.IsExactDevelopmentLaboratory(runtimeMode, profile));
        }

        [Fact]
        public void RequestFenceAcceptsOnlyCanonicalBoundedRevitRequests()
        {
            var post = Prepare("POST", "/revit/ping", "{\"a\":1,\"label\":\"é\"}");
            Assert.Equal(RequestId, post.RequestId);
            Assert.True(post.BodyPresent);
            Assert.Matches("^sha256:[0-9a-f]{64}$", post.SourceBodySha256);

            var get = OperatorNativeHttpRequestFence.Prepare("GET", "/revit/context", false, false, Array.Empty<byte>(), RequestId);
            Assert.False(get.BodyPresent);
            Assert.Equal("", get.BodyJson);
            var typed = OperatorNativeHttpRequestFence.Prepare(
                "GET", "/revit/context", false, false, Array.Empty<byte>(), RequestId, "typed_mcp", "revit_get_context");
            Assert.Equal("typed_mcp", typed.Channel);
            Assert.Equal("revit_get_context", typed.Alias);

            Reject(() => OperatorNativeHttpRequestFence.Prepare("GET", "/revit/context", false, false, Array.Empty<byte>(), RequestId, "typed_mcp", "revit_call_tool"));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("GET", "/revit/context", false, false, Array.Empty<byte>(), RequestId, "generic_call", "revit_get_context"));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("GET", "/revit/context", false, false, Array.Empty<byte>(), RequestId, "deterministic_workflow", "revit_get_context"));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("post", "/revit/ping", false, true, Utf8("{}"), RequestId));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("PUT", "/revit/ping", false, true, Utf8("{}"), RequestId));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("POST", "/Revit/ping", false, true, Utf8("{}"), RequestId));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("POST", "/revit/ping/", false, true, Utf8("{}"), RequestId));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("POST", "/revit/a/../ping", false, true, Utf8("{}"), RequestId));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("POST", "/revit/ping", true, true, Utf8("{}"), RequestId));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("GET", "/revit/ping", false, true, Utf8("{}"), RequestId));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("POST", "/revit/ping", false, false, Array.Empty<byte>(), RequestId));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("POST", "/revit/ping", false, true, new byte[] { 0xff }, RequestId));
            Reject(() => Prepare("POST", "/revit/ping", "{\"a\":1,}"));
            Reject(() => Prepare("POST", "/revit/ping", "{/*x*/\"a\":1}"));
            Reject(() => Prepare("POST", "/revit/ping", "{\"a\":1,\"a\":2}"));
            Reject(() => Prepare("POST", "/revit/ping", "{\"é\":1,\"é\":2}"));
            Reject(() => Prepare("POST", "/revit/ping", "{\"value\":\"é\"}"));
            Reject(() => Prepare("POST", "/revit/ping", "{\"value\":\"line\\r\\nnext\"}"));
            Reject(() => OperatorNativeHttpRequestFence.Prepare("POST", "/revit/ping", false, true,
                Enumerable.Repeat((byte)' ', OperatorNativeHttpRequestFence.MaximumBodyUtf8Bytes + 1).ToArray(), RequestId));
        }

        [Fact]
        public void ListenerPolicyAcceptsOnlyLoopbackHttpRootsAndLoopbackPeers()
        {
            Assert.True(OperatorNativeHttpRequestFence.TryNormalizeLoopbackPrefix("http://127.0.0.1:5000", out var ipv4));
            Assert.Equal("http://127.0.0.1:5000/", ipv4);
            Assert.True(OperatorNativeHttpRequestFence.TryNormalizeLoopbackPrefix("http://localhost:5010/", out _));
            Assert.True(OperatorNativeHttpRequestFence.TryNormalizeLoopbackPrefix("http://[::1]:5011/", out _));
            Assert.False(OperatorNativeHttpRequestFence.TryNormalizeLoopbackPrefix("http://0.0.0.0:5000/", out _));
            Assert.False(OperatorNativeHttpRequestFence.TryNormalizeLoopbackPrefix("http://192.168.1.20:5000/", out _));
            Assert.False(OperatorNativeHttpRequestFence.TryNormalizeLoopbackPrefix("https://127.0.0.1:5000/", out _));
            Assert.False(OperatorNativeHttpRequestFence.TryNormalizeLoopbackPrefix("http://127.0.0.1:5000/revit/", out _));
            Assert.True(OperatorNativeHttpRequestFence.IsLoopbackEndpoint(new IPEndPoint(IPAddress.Loopback, 1)));
            Assert.True(OperatorNativeHttpRequestFence.IsLoopbackEndpoint(new IPEndPoint(IPAddress.IPv6Loopback, 1)));
            Assert.False(OperatorNativeHttpRequestFence.IsLoopbackEndpoint(new IPEndPoint(IPAddress.Parse("192.168.1.20"), 1)));
            Assert.False(OperatorNativeHttpRequestFence.IsLoopbackEndpoint(null));
        }

        [Fact]
        public void ReceiptBindsSourceAndCanonicalBodyAndIsSingleUse()
        {
            var source = Prepare("POST", "/revit/ping", "{\"z\":1,\"a\":\"é\"}");
            const string canonical = "{\"a\":\"é\",\"z\":1}";
            var receipt = Verify(source, canonical);

            Assert.Equal(source.SourceBodySha256, receipt.SourceBodySha256);
            Assert.Equal(canonical, receipt.CanonicalBodyJson);
            Assert.Equal(OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(canonical), receipt.BodySha256);
            Assert.Equal(canonical, OperatorNativeHttpDispatchFence.RequireFreshOneUse(receipt, source, DateTimeOffset.UtcNow));

            var replay = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeHttpDispatchFence.RequireFreshOneUse(receipt, source, DateTimeOffset.UtcNow));
            Assert.Equal("CERTIFICATION_DIRECT_AUTHORIZATION_REPLAY", replay.Code);
            Assert.False(replay.OutcomeUnknown);
            Assert.False(replay.Retryable);
        }

        [Fact]
        public void ReceiptAcceptsNearTwoMiBCanonicalBodyWithExactHashes()
        {
            var source = Prepare("POST", "/revit/ping", "{}");
            const string prefix = "{\"payload\":\"";
            const string suffix = "\"}";
            var canonical = prefix
                + new string('a', OperatorNativeHttpRequestFence.MaximumBodyUtf8Bytes - prefix.Length - suffix.Length)
                + suffix;
            Assert.Equal(OperatorNativeHttpRequestFence.MaximumBodyUtf8Bytes, Utf8(canonical).Length);

            var values = AuthorizationValues(source, canonical);
            var expectedAuthorizationHash = HashAuthorization(values);
            var authorization = new Dictionary<string, object?>(values, StringComparer.Ordinal)
            {
                ["authorization_hash"] = expectedAuthorizationHash
            };
            var responseBytes = Utf8(JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["authorization"] = authorization
            }));

            Assert.True(responseBytes.Length > OperatorNativeHttpAuthorizationVerifier.MaximumFailureResponseUtf8Bytes);
            Assert.True(responseBytes.Length <= OperatorNativeHttpAuthorizationVerifier.MaximumSuccessResponseUtf8Bytes);
            var receipt = OperatorNativeHttpAuthorizationVerifier.VerifySuccess(
                responseBytes, source, "local", DateTimeOffset.UtcNow, TimeSpan.FromMilliseconds(5), StructuralTestAuthority);

            Assert.Equal(canonical, receipt.CanonicalBodyJson);
            Assert.Equal(source.SourceBodySha256, receipt.SourceBodySha256);
            Assert.Equal(OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(canonical), receipt.BodySha256);
            Assert.Equal(expectedAuthorizationHash, receipt.AuthorizationHash);
        }

        [Fact]
        public void OversizedSuccessResponseFailsClosedBeforeDispatch()
        {
            var request = Prepare("POST", "/revit/ping", "{}");
            var response = Enumerable.Repeat(
                (byte)' ',
                OperatorNativeHttpAuthorizationVerifier.MaximumSuccessResponseUtf8Bytes + 1).ToArray();
            var dispatches = 0;

            var error = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
            {
                var receipt = OperatorNativeHttpAuthorizationVerifier.VerifySuccess(
                    response, request, "local", DateTimeOffset.UtcNow, TimeSpan.Zero);
                OperatorNativeHttpDispatchFence.RequireFreshOneUse(receipt, request, DateTimeOffset.UtcNow);
                dispatches++;
            });

            Assert.Equal("CERTIFICATION_DIRECT_RESPONSE_SIZE_INVALID", error.Code);
            Assert.False(error.Retryable);
            Assert.False(error.OutcomeUnknown);
            Assert.Equal(0, dispatches);
        }

        [Fact]
        public async Task TransportReaderStopsOversizedFailureAt64KiBAndAllowsFullSuccessBoundary()
        {
            var failureLimit = OperatorNativeHttpAuthorizationVerifier.MaximumFailureResponseUtf8Bytes;
            using var oversizedFailure = new CountingStream(
                OperatorNativeHttpAuthorizationVerifier.MaximumSuccessResponseUtf8Bytes);

            var failure = await Assert.ThrowsAsync<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeHttpBoundedResponseReader.ReadAsync(
                    oversizedFailure,
                    failureLimit,
                    CancellationToken.None));

            Assert.Equal("CERTIFICATION_DIRECT_RESPONSE_SIZE_INVALID", failure.Code);
            Assert.Equal(failureLimit + 1L, oversizedFailure.BytesRead);
            Assert.True(oversizedFailure.BytesRead < OperatorNativeHttpAuthorizationVerifier.MaximumSuccessResponseUtf8Bytes);

            var successLimit = OperatorNativeHttpAuthorizationVerifier.MaximumSuccessResponseUtf8Bytes;
            using var exactSuccess = new CountingStream(successLimit);
            var success = await OperatorNativeHttpBoundedResponseReader.ReadAsync(
                exactSuccess,
                successLimit,
                CancellationToken.None);

            Assert.Equal(successLimit, success.Length);
            Assert.Equal(successLimit, exactSuccess.BytesRead);
        }

        [Fact]
        public void TransportReaderRejectsOversizedContentLengthBeforeReading()
        {
            var error = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeHttpBoundedResponseReader.EnsureContentLengthWithinLimit(
                    OperatorNativeHttpAuthorizationVerifier.MaximumFailureResponseUtf8Bytes + 1L,
                    OperatorNativeHttpAuthorizationVerifier.MaximumFailureResponseUtf8Bytes));

            Assert.Equal("CERTIFICATION_DIRECT_RESPONSE_SIZE_INVALID", error.Code);
        }

        [Fact]
        public void FinalRefreshUsesFreshRequestIdAndCannotChangeEffectiveBody()
        {
            var source = OperatorNativeHttpRequestFence.Prepare(
                "POST",
                "/revit/ping",
                false,
                true,
                Utf8("{\"z\":1,\"a\":2}"),
                RequestId,
                "typed_mcp",
                "revit_ping");
            const string canonical = "{\"a\":2,\"z\":1}";
            var early = Verify(source, canonical);
            var effective = OperatorNativeHttpDispatchFence.CreateFreshEffectiveRequest(
                source,
                OperatorNativeHttpDispatchFence.RequireFreshOneUse(early, source, DateTimeOffset.UtcNow));
            Assert.NotEqual(source.RequestId, effective.RequestId);
            Assert.Equal(canonical, effective.BodyJson);
            Assert.Equal(source.Channel, effective.Channel);
            Assert.Equal(source.Alias, effective.Alias);

            var final = Verify(effective, canonical);
            Assert.Equal(canonical, OperatorNativeHttpDispatchFence.RequireFreshOneUse(
                final, effective, DateTimeOffset.UtcNow, canonical));

            var changedRequest = OperatorNativeHttpDispatchFence.CreateFreshEffectiveRequest(source, canonical);
            var changed = Verify(changedRequest, "{\"a\":2,\"z\":2}");
            var mismatch = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeHttpDispatchFence.RequireFreshOneUse(
                    changed,
                    changedRequest,
                    DateTimeOffset.UtcNow,
                    canonical));
            Assert.Equal("CERTIFICATION_DIRECT_EFFECTIVE_BODY_MISMATCH", mismatch.Code);
        }

        [Fact]
        public void VerifierFailsClosedForEveryReceiptBindingAndFreshnessChange()
        {
            var request = Prepare("POST", "/revit/ping", "{}");
            const string canonical = "{}";
            var baseline = AuthorizationValues(request, canonical);

            RejectProtocol(() => VerifyResponse(request, With(baseline, "request_id", "a" + RequestId.Substring(1))));
            RejectProtocol(() => VerifyResponse(request, With(baseline, "method", "GET")));
            RejectProtocol(() => VerifyResponse(request, With(baseline, "path", "/revit/context")));
            RejectProtocol(() => VerifyResponse(request, With(baseline, "source_body_sha256", "sha256:" + new string('f', 64))));
            RejectProtocol(() => VerifyResponse(request, With(baseline, "canonical_body_json", "{\"changed\":true}")));
            RejectProtocol(() => VerifyResponse(request, With(baseline, "channel", "typed_mcp")));
            RejectProtocol(() => VerifyResponse(request, With(baseline, "exposure_profile", "laboratory")));
            RejectProtocol(() => VerifyResponse(request, With(baseline, "valid_for_ms", 6000)));
            RejectProtocol(() => VerifyResponse(request, With(baseline, "authorization_hash", "sha256:" + new string('0', 64)), rehash: false));
            RejectProtocol(() => VerifyResponse(request, AuthorizationValues(request, "{\"a\":1,\"a\":2}")));
            RejectProtocol(() => VerifyResponse(request, AuthorizationValues(request, "{\"value\":\"é\"}")));
            RejectProtocol(() => VerifyResponse(request, AuthorizationValues(request, "{\"value\":\"line\\r\\nnext\"}")));

            // Native does not guess at ECMAScript number canonicalization. A
            // hash-bound backend canonical fraction is valid and is dispatched
            // byte-for-byte after the final backend refresh repeats it.
            var fractionalRequest = Prepare("POST", "/revit/ping", "{\"value\":1.5}");
            Assert.Equal("{\"value\":1.5}", Verify(fractionalRequest, "{\"value\":1.5}").CanonicalBodyJson);

            var expired = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                VerifyResponse(request, baseline, roundTrip: TimeSpan.FromMilliseconds(5000)));
            Assert.Equal("CERTIFICATION_DIRECT_AUTHORIZATION_EXPIRED", expired.Code);
            Assert.True(expired.Retryable);
            Assert.False(expired.OutcomeUnknown);
        }

        [Fact]
        public void DenialsAndProtocolFailuresAreStructuredPreDispatchFailures()
        {
            var denied = Utf8("{\"ok\":false,\"code\":\"CERTIFICATION_POLICY_DENIED\",\"error\":\"denied\",\"retryable\":false}");
            var failure = OperatorNativeHttpAuthorizationVerifier.ParseFailure(403, denied);
            Assert.Equal(403, failure.HttpStatusCode);
            Assert.Equal("CERTIFICATION_POLICY_DENIED", failure.Code);
            Assert.False(failure.Retryable);
            Assert.False(failure.OutcomeUnknown);

            var malformed = OperatorNativeHttpAuthorizationVerifier.ParseFailure(503, Utf8("{}"));
            Assert.Equal(503, malformed.HttpStatusCode);
            Assert.False(malformed.OutcomeUnknown);

            var oversizedFailure = OperatorNativeHttpAuthorizationVerifier.ParseFailure(
                503,
                Enumerable.Repeat(
                    (byte)' ',
                    OperatorNativeHttpAuthorizationVerifier.MaximumFailureResponseUtf8Bytes + 1).ToArray());
            Assert.Equal("CERTIFICATION_DIRECT_RESPONSE_SIZE_INVALID", oversizedFailure.Code);
        }

        [Fact]
        public void AdmissionFailureMatrixProducesZeroHandlerDispatches()
        {
            var request = Prepare("POST", "/revit/ping", "{}");
            var dispatches = 0;
            Action<OperatorNativeHttpAuthorizationReceipt?, OperatorNativeHttpRequest, string?> dispatch = (receipt, bound, expected) =>
            {
                OperatorNativeHttpDispatchFence.RequireFreshOneUse(receipt, bound, DateTimeOffset.UtcNow, expected);
                dispatches++;
            };

            Assert.Throws<OperatorNativeHttpAdmissionException>(() => dispatch(null, request, "{}"));
            Assert.Equal(0, dispatches);

            var mismatchedRequest = Prepare("POST", "/revit/context", "{}");
            var mismatchReceipt = Verify(request, "{}");
            Assert.Throws<OperatorNativeHttpAdmissionException>(() => dispatch(mismatchReceipt, mismatchedRequest, "{}"));
            Assert.Equal(0, dispatches);

            var changedBodyReceipt = Verify(request, "{\"changed\":true}");
            Assert.Throws<OperatorNativeHttpAdmissionException>(() => dispatch(changedBodyReceipt, request, "{}"));
            Assert.Equal(0, dispatches);

            var oneUseReceipt = Verify(request, "{}");
            dispatch(oneUseReceipt, request, "{}");
            Assert.Equal(1, dispatches);
            Assert.Throws<OperatorNativeHttpAdmissionException>(() => dispatch(oneUseReceipt, request, "{}"));
            Assert.Equal(1, dispatches);
        }

        [Fact]
        public void SourceInventoryProvesMandatoryAdmissionBeforeGrantAndEveryDispatchBoundary()
        {
            var root = FindRepositoryRoot();
            var server = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge", "Server", "RevitHttpServer.cs"));
            var app = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge", "App.cs"));
            var client = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorBackendClient.cs"));
            var backendConfig = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorBackendConfig.cs"));

            Assert.Contains("RevitHttpServer(RevitEventService eventService, IOperatorNativeHttpAuthorizer nativeHttpAuthorizer)", server);
            Assert.DoesNotMatch(new Regex(@"RevitHttpServer\(RevitEventService eventService\)"), server);
            Assert.Contains("TryNormalizeLoopbackPrefix", server);
            Assert.Contains("IsLoopbackEndpoint(req.RemoteEndPoint)", server);
            Assert.Contains("http://127.0.0.1:5000/", server);

            var early = server.IndexOf("var earlyReceipt = await _nativeHttpAuthorizer.AuthorizeAsync", StringComparison.Ordinal);
            var grant = server.IndexOf("OperatorWriteGrant.ValidateAndConsumeIfNeeded", StringComparison.Ordinal);
            Assert.True(early >= 0 && grant > early, "Certification admission must precede write-grant consumption.");
            Assert.Contains("RequireFinalNativeAuthorizationAsync(effectiveRequest", server);
            Assert.Contains("RequireFinalNativeAuthorizationAsync(\n                                            capturedEffectiveRequest", server.Replace("\r\n", "\n"));
            Assert.Contains("handler.Handle(app, dispatchBody)", server);
            Assert.DoesNotContain("handler.Handle(app, body).GetAwaiter().GetResult()", server);
            Assert.Contains("handler.Handle(null!, body)", server);

            var backend = app.IndexOf("var backend = new OperatorBackendClient", StringComparison.Ordinal);
            var serverConstruction = app.IndexOf("new RevitHttpServer(_eventService, backend)", StringComparison.Ordinal);
            Assert.True(backend >= 0 && serverConstruction > backend);
            Assert.DoesNotContain("new RevitHttpServer(_eventService)", app);

            Assert.Contains("api/revit-direct/authorize-execution", client);
            Assert.Contains("deadline.CancelAfter(TimeSpan.FromSeconds(10));", client);
            Assert.Contains("body_json = request.BodyJson", client);
            Assert.Contains("var responseByteLimit = resp.IsSuccessStatusCode", client);
            Assert.Contains("? OperatorNativeHttpAuthorizationVerifier.MaximumSuccessResponseUtf8Bytes", client);
            Assert.Contains(": OperatorNativeHttpAuthorizationVerifier.MaximumFailureResponseUtf8Bytes", client);
            Assert.DoesNotContain("OperatorNativeHttpAuthorizationVerifier.MaximumResponseUtf8Bytes,", client);
            Assert.DoesNotContain("effect_hash =", client);
            Assert.DoesNotContain("policy_hash =", client);
            Assert.Contains("OperatorNativeToolExposureBackendUriPolicy.RequireValidOrigin(url)", backendConfig);
            Assert.Contains("OperatorNativeToolExposureBackendUriPolicy.RequireValidOrigin(cfg.backend_url!)", backendConfig);
            Assert.DoesNotContain("Uri.TryCreate", backendConfig);

            var registeredRoutes = Regex.Matches(server, "\\{ \\\"(/revit/[^\\\"]+)\\\", new ").Count;
            Assert.True(registeredRoutes > 150, "Route inventory unexpectedly shrank; the global fence must cover the full native catalog.");
        }

        private static OperatorNativeHttpRequest Prepare(string method, string path, string body)
            => OperatorNativeHttpRequestFence.Prepare(method, path, false, true, Utf8(body), RequestId);

        private static byte[] Utf8(string value) => new UTF8Encoding(false, true).GetBytes(value);

        private static void Reject(Action action)
        {
            var error = Assert.Throws<OperatorNativeHttpAdmissionException>(action);
            Assert.Equal("CERTIFICATION_DIRECT_REQUEST_MALFORMED", error.Code);
            Assert.False(error.Retryable);
            Assert.False(error.OutcomeUnknown);
        }

        private static void RejectProtocol(Action action)
        {
            var error = Assert.Throws<OperatorNativeHttpAdmissionException>(action);
            Assert.False(error.OutcomeUnknown);
        }

        private static OperatorNativeHttpAuthorizationReceipt Verify(OperatorNativeHttpRequest request, string canonicalBody)
            => VerifyResponse(request, AuthorizationValues(request, canonicalBody));

        private static OperatorNativeHttpAuthorizationReceipt VerifyResponse(
            OperatorNativeHttpRequest request,
            Dictionary<string, object?> values,
            bool rehash = true,
            TimeSpan? roundTrip = null)
        {
            var authorization = new Dictionary<string, object?>(values, StringComparer.Ordinal);
            if (rehash || !authorization.ContainsKey("authorization_hash"))
                authorization["authorization_hash"] = HashAuthorization(authorization);
            var response = JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["authorization"] = authorization
            });
            return OperatorNativeHttpAuthorizationVerifier.VerifySuccess(
                Utf8(response), request, "local", DateTimeOffset.UtcNow, roundTrip ?? TimeSpan.FromMilliseconds(5), StructuralTestAuthority);
        }

        private static Dictionary<string, object?> AuthorizationValues(OperatorNativeHttpRequest request, string canonicalBody)
        {
            return new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["version"] = OperatorNativeHttpAuthorizationReceipt.Version,
                ["phase"] = OperatorNativeHttpAuthorizationReceipt.Phase,
                ["authorized_at"] = "2026-07-29T12:00:00.000Z",
                ["valid_for_ms"] = 5000,
                ["request_id"] = request.RequestId,
                ["method"] = request.Method,
                ["path"] = request.Path,
                ["body_present"] = request.BodyPresent,
                ["source_body_sha256"] = request.SourceBodySha256,
                ["canonical_body_json"] = canonicalBody,
                ["body_sha256"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(canonicalBody),
                ["policy_hash"] = "sha256:" + new string('1', 64),
                ["policy_record_hash"] = "sha256:" + new string('2', 64),
                ["evidence_record_hash"] = "sha256:" + new string('3', 64),
                ["request_hash"] = OperatorNativeToolExposureRequestHash.Compute(
                    request.Method,
                    request.Path,
                    canonicalBody),
                ["effect_hash"] = "sha256:" + new string('5', 64),
                ["channel"] = request.Channel,
                ["alias"] = request.Alias,
                ["runtime_mode"] = "local",
                ["exposure_profile"] = "certified",
                ["policy_trust_source"] = "deployment"
            };
        }

        private static Dictionary<string, object?> With(Dictionary<string, object?> source, string key, object? value)
        {
            var copy = new Dictionary<string, object?>(source, StringComparer.Ordinal) { [key] = value };
            return copy;
        }

        private static string HashAuthorization(Dictionary<string, object?> authorization)
        {
            var payload = authorization
                .Where(pair => pair.Key != "authorization_hash")
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            return OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement));
        }

        private static string FindRepositoryRoot()
        {
            var current = new DirectoryInfo(AppContext.BaseDirectory);
            while (current != null)
            {
                if (Directory.Exists(Path.Combine(current.FullName, "apps", "revit-bridge-addin"))) return current.FullName;
                current = current.Parent;
            }
            throw new DirectoryNotFoundException("Could not locate repository root.");
        }

        private sealed class CountingStream : Stream
        {
            private readonly long _length;

            public CountingStream(long length)
            {
                _length = length;
            }

            public long BytesRead { get; private set; }
            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => _length;
            public override long Position { get => BytesRead; set => throw new NotSupportedException(); }
            public override void Flush() { }
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            public override int Read(byte[] buffer, int offset, int count)
            {
                if (BytesRead >= _length) return 0;
                var read = (int)Math.Min(count, _length - BytesRead);
                BytesRead += read;
                return read;
            }

            public override Task<int> ReadAsync(
                byte[] buffer,
                int offset,
                int count,
                CancellationToken cancellationToken)
            {
                cancellationToken.ThrowIfCancellationRequested();
                return Task.FromResult(Read(buffer, offset, count));
            }
        }

        private sealed class StructuralAllowAuthority : IOperatorNativeToolExposureAuthority
        {
            public void RequireAuthorized(OperatorNativeToolExposureBinding binding)
            {
                Assert.NotNull(binding);
            }
        }
    }
}

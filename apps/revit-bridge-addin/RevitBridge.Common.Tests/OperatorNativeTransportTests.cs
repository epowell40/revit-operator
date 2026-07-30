using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeTransportTests
    {
        private const string Token = "0123456789abcdef0123456789abcdef";
        private const string RequestId = "fedcba9876543210fedcba9876543210";
        private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeMilliseconds(1785345600123);
        private static readonly string Epoch = Base64Url(Sequence(0x00, 32));

        [Fact]
        public void CrossRuntimeCanonicalVectorRoundTripsWithoutPlaintext()
        {
            var request = OperatorNativeTransportCodec.ProtectRequestCore(
                Token,
                Epoch,
                "POST",
                "/revit/set-parameter",
                "{\"elementId\":42,\"value\":\"AHU-1\"}",
                "grant-v1-test",
                Now,
                RequestId,
                Sequence(0x20, 32),
                Sequence(0x40, 16));

            Assert.Equal("{\"v\":\"revit-operator.native-transport.v1\",\"alg\":\"A256CBC-HS512\",\"epoch\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\",\"dir\":\"request\",\"iv\":\"QEFCQ0RFRkdISUpLTE1OTw\",\"ciphertext\":\"-W4DbKOCrKPoTdu_C_RlTcOB46_wzvZLmTwyt-G9MtdwXRHa_K5YmNUYaSyQE40-TbRQhBilL1OWTfaT9Bnoei9oYhkPOUH4WHVBnDK8gw-MJq0Ugb-XlzUOvoBXTVnplMUawAdKNb39SPpOr1TTBi4SuzUoryj4OQKiK-LywJDwlBRYe5zyLRA02sXXPJixzdoqsm91yK19boib1EHXePWdCcYmRKbTbDNAg5E0NlqsGiHdWTMgg9ZkSKHBxkTNfitSDttCWQyzM4xqWCv6ryxU51iIJ65_31zhMEeuZtXHJ5c3WsqkEN7jSAw4MM8N_4xfPcStHgMSaiBtDWFQixwP6KFcB_CAjxZaHfy-8Ufr0fQ4IiPVXsZwDt4fDOTV4ZIdwj35Rtxcpq-a-dzx6Q\",\"tag\":\"OpENiO5foy5aliWUb8ONQCAlCbd1Mgt0XVt1blb2e6U\"}", request.EnvelopeJson);
            Assert.DoesNotContain(Token, request.EnvelopeJson);
            Assert.DoesNotContain("set-parameter", request.EnvelopeJson);
            Assert.DoesNotContain("AHU-1", request.EnvelopeJson);
            Assert.DoesNotContain("grant-v1-test", request.EnvelopeJson);
            Assert.DoesNotContain(RequestId, request.EnvelopeJson);

            var opened = OperatorNativeTransportCodec.OpenRequest(
                Token,
                Epoch,
                Utf8(request.EnvelopeJson),
                OperatorNativeTransportProtocol.TransportMethod,
                OperatorNativeTransportProtocol.TransportPath,
                false,
                Now,
                new OperatorNativeTransportReplayCache());

            Assert.Equal(RequestId, opened.Request.RequestId);
            Assert.Equal("POST", opened.Request.Method);
            Assert.Equal("/revit/set-parameter", opened.Request.Path);
            Assert.Equal("{\"elementId\":42,\"value\":\"AHU-1\"}", opened.Request.BodyJson);
            Assert.Equal("grant-v1-test", opened.WriteGrant);

            var responseEnvelope = OperatorNativeTransportCodec.ProtectResponseCore(
                Token,
                opened,
                403,
                "{\"ok\":false,\"error\":\"approval required\"}",
                Now.AddMilliseconds(333),
                Sequence(0x60, 16));
            Assert.Equal("{\"v\":\"revit-operator.native-transport.v1\",\"alg\":\"A256CBC-HS512\",\"epoch\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\",\"dir\":\"response\",\"iv\":\"YGFiY2RlZmdoaWprbG1ubw\",\"ciphertext\":\"pEM9pnNnjmvYWJnT02ktf4OIzoNFGl_uT1bILY8oUY6eqnDGE4zu78JxJ3-jJIJdTKiP-azhpHsvVhIOFMBOLh9Qsr-cBK6dXMFQBYWXYTH62yp_oGZnq4O9Ec8m-2o2mP0z--f5YkB3xpHLtmp77La0DJn9PgizHml0jYZ1m9yBpbSZjSUCdvxMfcg6zIYZI0KCXAsmZ69jbh3S1N1zKdqscXy0WG3rTHWB3pUoyZWgkDeKF34DyBMaeoB76zG2hVA68O9tLXt4y2OkchJfwn3aiZ1FbsMhalbdG8XY9TUw_807F-xLxhOjL8cKG2SG\",\"tag\":\"drUlfD17QYEhMihSyLNVUvhUuBZEbcKIIMIehfYM5zg\"}", responseEnvelope);
            Assert.DoesNotContain("approval required", responseEnvelope);

            var response = OperatorNativeTransportCodec.OpenResponse(
                Token,
                request,
                Utf8(responseEnvelope),
                Now.AddMilliseconds(333));
            Assert.Equal(403, response.StatusCode);
            Assert.Equal("{\"ok\":false,\"error\":\"approval required\"}", response.BodyJson);
        }

        [Fact]
        public void TamperWrongKeyEpochRouteAndDirectionAllFailClosed()
        {
            Assert.True(OperatorNativeTransportProtocol.ContainsForbiddenPlaintextHeader(new[] { "X-Operator-Token" }));
            Assert.True(OperatorNativeTransportProtocol.ContainsForbiddenPlaintextHeader(new[] { "x-operator-write-grant" }));
            Assert.True(OperatorNativeTransportProtocol.ContainsForbiddenPlaintextHeader(new[] { "X-Operator-Correlation-Id" }));
            Assert.False(OperatorNativeTransportProtocol.ContainsForbiddenPlaintextHeader(new[] { "Content-Type" }));

            var request = Protect("POST", "/revit/ping", "{}", Now);
            var cache = new OperatorNativeTransportReplayCache();

            RejectAuth(() => Open(MutateField(request.EnvelopeJson, "tag"), Now, cache));
            RejectAuth(() => Open(MutateField(request.EnvelopeJson, "ciphertext"), Now, cache));
            RejectAuth(() => OperatorNativeTransportCodec.OpenRequest(
                new string('x', 32), Epoch, Utf8(request.EnvelopeJson), "POST",
                OperatorNativeTransportProtocol.TransportPath, false, Now, cache));
            RejectAuth(() => OperatorNativeTransportCodec.OpenRequest(
                Token, Base64Url(Sequence(0x80, 32)), Utf8(request.EnvelopeJson), "POST",
                OperatorNativeTransportProtocol.TransportPath, false, Now, cache));

            var badMethod = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeTransportCodec.OpenRequest(
                    Token, Epoch, Utf8(request.EnvelopeJson), "GET",
                    OperatorNativeTransportProtocol.TransportPath, false, Now, cache));
            Assert.Equal("NATIVE_TRANSPORT_OUTER_ROUTE_INVALID", badMethod.Code);
            var badPath = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeTransportCodec.OpenRequest(
                    Token, Epoch, Utf8(request.EnvelopeJson), "POST", "/revit/ping", false, Now, cache));
            Assert.Equal("NATIVE_TRANSPORT_OUTER_ROUTE_INVALID", badPath.Code);

            RejectAuth(() => OperatorNativeTransportCodec.OpenResponse(Token, request, Utf8(request.EnvelopeJson), Now));
        }

        [Fact]
        public void ReplayTimestampAndResponseBindingAreEnforced()
        {
            var cache = new OperatorNativeTransportReplayCache();
            var request = Protect("POST", "/revit/ping", "{}", Now);
            var opened = Open(request.EnvelopeJson, Now, cache);
            var replay = Assert.Throws<OperatorNativeHttpAdmissionException>(() => Open(request.EnvelopeJson, Now, cache));
            Assert.Equal("NATIVE_TRANSPORT_REQUEST_REPLAY", replay.Code);

            var inclusiveBoundaryCache = new OperatorNativeTransportReplayCache();
            var futureBoundary = Protect(
                "POST",
                "/revit/ping",
                "{}",
                Now + OperatorNativeTransportProtocol.MaximumFutureSkew);
            Open(futureBoundary.EnvelopeJson, Now, inclusiveBoundaryCache);
            var boundaryReplay = Assert.Throws<OperatorNativeHttpAdmissionException>(() => Open(
                futureBoundary.EnvelopeJson,
                Now + OperatorNativeTransportProtocol.MaximumFutureSkew + OperatorNativeTransportProtocol.MaximumMessageAge,
                inclusiveBoundaryCache));
            Assert.Equal("NATIVE_TRANSPORT_REQUEST_REPLAY", boundaryReplay.Code);

            var stale = Protect("POST", "/revit/ping", "{}", Now - OperatorNativeTransportProtocol.MaximumMessageAge - TimeSpan.FromMilliseconds(1));
            Assert.Equal("NATIVE_TRANSPORT_REQUEST_EXPIRED", Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                Open(stale.EnvelopeJson, Now, new OperatorNativeTransportReplayCache())).Code);
            var future = Protect("POST", "/revit/ping", "{}", Now + OperatorNativeTransportProtocol.MaximumFutureSkew + TimeSpan.FromMilliseconds(1));
            Assert.Equal("NATIVE_TRANSPORT_REQUEST_EXPIRED", Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                Open(future.EnvelopeJson, Now, new OperatorNativeTransportReplayCache())).Code);

            var response = OperatorNativeTransportCodec.ProtectResponse(Token, opened, 200, "{\"ok\":true}", Now);
            var other = Protect("POST", "/revit/ping", "{}", Now);
            var binding = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeTransportCodec.OpenResponse(Token, other, Utf8(response), Now));
            Assert.Equal("NATIVE_TRANSPORT_RESPONSE_BINDING_INVALID", binding.Code);

            var reflected = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeTransportCodec.OpenRequest(
                    Token, Epoch, Utf8(response), "POST", OperatorNativeTransportProtocol.TransportPath,
                    false, Now, new OperatorNativeTransportReplayCache()));
            Assert.Equal("NATIVE_TRANSPORT_AUTHENTICATION_FAILED", reflected.Code);
        }

        [Fact]
        public void BodyEnvelopeAndTokenLimitsFailClosed()
        {
            var tooLargeBody = new string('x', OperatorNativeHttpRequestFence.MaximumBodyUtf8Bytes + 1);
            Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeTransportCodec.ProtectRequest(Token, Epoch, "POST", "/revit/ping", tooLargeBody, "", Now));

            var maximumGrant = new string('g', OperatorNativeTransportProtocol.MaximumWriteGrantUtf8Bytes);
            var maximumGrantRequest = OperatorNativeTransportCodec.ProtectRequest(
                Token, Epoch, "POST", "/revit/ping", "{}", maximumGrant, Now);
            Assert.True(Utf8(maximumGrantRequest.EnvelopeJson).Length <= OperatorNativeTransportProtocol.MaximumRequestEnvelopeUtf8Bytes);
            var tooLargeGrant = maximumGrant + "g";
            Assert.Equal("NATIVE_TRANSPORT_WRITE_GRANT_SIZE_INVALID", Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeTransportCodec.ProtectRequest(Token, Epoch, "POST", "/revit/ping", "{}", tooLargeGrant, Now)).Code);

            var valid = Protect("POST", "/revit/ping", "{}", Now);
            var oversizedEnvelope = new byte[OperatorNativeTransportProtocol.MaximumRequestEnvelopeUtf8Bytes + 1];
            Assert.Equal("NATIVE_TRANSPORT_ENVELOPE_SIZE_INVALID", Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeTransportCodec.OpenRequest(
                    Token, Epoch, oversizedEnvelope, "POST", OperatorNativeTransportProtocol.TransportPath,
                    false, Now, new OperatorNativeTransportReplayCache())).Code);

            Assert.Equal("NATIVE_TRANSPORT_TOKEN_INVALID", Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeTransportCodec.OpenRequest(
                    "short", Epoch, Utf8(valid.EnvelopeJson), "POST", OperatorNativeTransportProtocol.TransportPath,
                    false, Now, new OperatorNativeTransportReplayCache())).Code);

            var opened = Open(valid.EnvelopeJson, Now, new OperatorNativeTransportReplayCache());
            var tooLargeResponse = new string('x', OperatorNativeTransportProtocol.MaximumResponseBodyUtf8Bytes + 1);
            Assert.Equal("NATIVE_TRANSPORT_RESPONSE_SIZE_INVALID", Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeTransportCodec.ProtectResponse(Token, opened, 200, tooLargeResponse, Now)).Code);
        }

        [Fact]
        public void NativeServerSourceUsesSecureEnvelopeBeforeAdmissionAndEncryptedResponse()
        {
            var root = FindRepositoryRoot();
            var server = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge", "Server", "RevitHttpServer.cs"));
            var secureOpen = server.IndexOf("OperatorNativeTransportHttpAdapter.OpenCertifiedRequest", StringComparison.Ordinal);
            var outerValidation = server.IndexOf("OperatorNativeTransportHttpAdapter.ValidateCertifiedOuterRequest", StringComparison.Ordinal);
            var envelopeRead = server.IndexOf("var envelopeBytes = await ReadRequestBodyBytesAsync", StringComparison.Ordinal);
            var admission = server.IndexOf("var earlyReceipt = await _nativeHttpAuthorizer.AuthorizeAsync", StringComparison.Ordinal);
            var grant = server.IndexOf("OperatorWriteGrant.ValidateAndConsumeIfNeeded", StringComparison.Ordinal);
            var secureResponse = server.IndexOf("OperatorNativeTransportHttpAdapter.CreateCertifiedResponse", StringComparison.Ordinal);

            Assert.True(outerValidation >= 0 && envelopeRead > outerValidation && secureOpen > envelopeRead
                && admission > secureOpen && grant > admission && secureResponse > grant);
            Assert.Contains("bridge_transport.v1.json", server);
            Assert.Contains("req.Headers.AllKeys", server);
            Assert.Contains("protectedTransportRequest?.WriteGrant", server);
            Assert.Contains("resp.StatusCode = protectedResponse.OuterStatusCode", server);
            Assert.Contains("IsExactDevelopmentLaboratory", server);
        }

        [Fact]
        public void HttpAdapterRejectsRawHeadersAndProtectsApplicationStatusAndFailures()
        {
            Assert.True(OperatorNativeHttpRuntimeProfile.IsExactDevelopmentLaboratory("development", "laboratory"));
            Assert.False(OperatorNativeHttpRuntimeProfile.IsExactDevelopmentLaboratory("Development", "laboratory"));
            Assert.False(OperatorNativeHttpRuntimeProfile.IsExactDevelopmentLaboratory("development", "Laboratory"));
            Assert.False(OperatorNativeHttpRuntimeProfile.IsExactDevelopmentLaboratory("local", "laboratory"));

            var protectedRequest = Protect("POST", "/revit/ping", "{}", Now);
            var rawHeader = Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                OperatorNativeTransportHttpAdapter.OpenCertifiedRequest(
                    Token, Epoch, Array.Empty<byte>(), "POST", OperatorNativeTransportProtocol.TransportPath,
                    false, OperatorNativeTransportProtocol.ContentType, new[] { "X-Operator-Token" },
                    Now, new OperatorNativeTransportReplayCache()));
            Assert.Equal("NATIVE_TRANSPORT_PLAINTEXT_CREDENTIAL_REJECTED", rawHeader.Code);

            var opened = OperatorNativeTransportHttpAdapter.OpenCertifiedRequest(
                Token, Epoch, Utf8(protectedRequest.EnvelopeJson), "POST", OperatorNativeTransportProtocol.TransportPath,
                false, OperatorNativeTransportProtocol.ContentType, new[] { "Content-Type" },
                Now, new OperatorNativeTransportReplayCache());
            var protectedFailure = OperatorNativeTransportHttpAdapter.CreateCertifiedResponse(
                Token, opened, 403, "{\"ok\":false,\"code\":\"authorization_failed\"}", Now);
            Assert.Equal(200, protectedFailure.OuterStatusCode);
            Assert.Equal(OperatorNativeTransportProtocol.ContentType, protectedFailure.ContentType);
            var openedFailure = OperatorNativeTransportCodec.OpenResponse(Token, protectedRequest, protectedFailure.BodyUtf8, Now);
            Assert.Equal(403, openedFailure.StatusCode);
            Assert.Contains("authorization_failed", openedFailure.BodyJson);

            var responseProtectionFailure = OperatorNativeTransportHttpAdapter.CreateCertifiedResponse(
                "short", opened, 200, "{\"ok\":true}", Now);
            Assert.Equal(500, responseProtectionFailure.OuterStatusCode);
            Assert.Equal("application/json", responseProtectionFailure.ContentType);
            RejectAuth(() => OperatorNativeTransportCodec.OpenResponse(Token, protectedRequest, responseProtectionFailure.BodyUtf8, Now));
        }

        private static OperatorNativeTransportProtectedRequest Protect(string method, string path, string body, DateTimeOffset at)
            => OperatorNativeTransportCodec.ProtectRequest(Token, Epoch, method, path, body, "grant", at);

        private static OperatorNativeTransportRequestContext Open(string envelope, DateTimeOffset at, OperatorNativeTransportReplayCache cache)
            => OperatorNativeTransportCodec.OpenRequest(
                Token, Epoch, Utf8(envelope), "POST", OperatorNativeTransportProtocol.TransportPath, false, at, cache);

        private static void RejectAuth(Action action)
        {
            var error = Assert.Throws<OperatorNativeHttpAdmissionException>(action);
            Assert.Equal("NATIVE_TRANSPORT_AUTHENTICATION_FAILED", error.Code);
        }

        private static string MutateField(string json, string field)
        {
            using var document = JsonDocument.Parse(json);
            var values = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.Name == field)
                {
                    var value = property.Value.GetString() ?? "";
                    values.Add(property.Name, (value[0] == 'A' ? "B" : "A") + value.Substring(1));
                }
                else
                {
                    values.Add(property.Name, property.Value.Clone());
                }
            }
            return JsonSerializer.Serialize(values);
        }

        private static byte[] Sequence(int start, int length)
            => Enumerable.Range(start, length).Select(value => checked((byte)value)).ToArray();

        private static string Base64Url(byte[] value)
            => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        private static byte[] Utf8(string value) => Encoding.UTF8.GetBytes(value);

        private static string FindRepositoryRoot()
        {
            var current = new DirectoryInfo(AppContext.BaseDirectory);
            while (current != null)
            {
                if (File.Exists(Path.Combine(current.FullName, "AGENTS.md"))) return current.FullName;
                current = current.Parent;
            }
            throw new DirectoryNotFoundException("Repository root not found.");
        }
    }
}

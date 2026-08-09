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

            Assert.Equal("{\"v\":\"revit-operator.native-transport.v1\",\"alg\":\"A256CBC-HS512\",\"epoch\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\",\"dir\":\"request\",\"iv\":\"QEFCQ0RFRkdISUpLTE1OTw\",\"ciphertext\":\"-W4DbKOCrKPoTdu_C_RlTcOB46_wzvZLmTwyt-G9MtdwXRHa_K5YmNUYaSyQE40-TbRQhBilL1OWTfaT9Bnoei9oYhkPOUH4WHVBnDK8gw-MJq0Ugb-XlzUOvoBXTVnplMUawAdKNb39SPpOr1TTBi4SuzUoryj4OQKiK-LywJDwlBRYe5zyLRA02sXXPJixzdoqsm91yK19boib1EHXePWdCcYmRKbTbDNAg5E0NlqsGiHdWTMgg9ZkSKHBxkTNfitSDttCWQyzM4xqWCv6ryxU51iIJ65_31zhMEeuZtXHJ5c3WsqkEN7jSAw4MM8N_4xfPcStHgMSaiBtDWFQi_2uHVgUhsv2zc6Efsou06GPkeMOAnillQUMJ9xLqXCgaAt3HROqMFOF1X1_Owy49PhS1hGWmElOqcYo_wUTXpyh3t-mmOaVghkw6GZ7vZD-bAk1OggasGYWyq3I4rFtSg\",\"tag\":\"8RGpK29AhveBYF5zxYcHWQqVRo2TsAqdvaICDxtS-sM\"}", request.EnvelopeJson);
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
            Assert.Equal("generic_call", opened.Request.Channel);
            Assert.Equal("revit_call_tool", opened.Request.Alias);
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
        public void DynamicRuntimeConsumesOneUseWriteGrantOnlyAtCommittedApplyBoundary()
        {
            var root = FindRepositoryRoot();
            var policy = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorApprovalPolicy.cs"));
            Assert.Contains("\"/revit/dynamic-runtime/bootstrap\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/register\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/snapshot\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/preview\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/authorize-apply\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/apply\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High", policy);
            Assert.Contains("\"/revit/dynamic-runtime/observe-v1\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/observe-building-systems-v1\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/result-reference-facts-v1\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/mep-result-preview-v1\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/mep-result-authorize-v1\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/mep-result-apply-v1\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High", policy);
            Assert.Contains("\"/revit/dynamic-runtime/core-preview-v1\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/core-authorize-v1\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.Low", policy);
            Assert.Contains("\"/revit/dynamic-runtime/core-apply-v1\", StringComparison.OrdinalIgnoreCase)) return OperatorActionRisk.High", policy);

            var activation = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge.Logic", "Handlers", "DynamicRuntime", "DynamicRuntimeV1ActivationHandlers.cs"));
            Assert.Contains("REVIT_OPERATOR_MODE\"), \"development\", StringComparison.Ordinal", activation);
            Assert.Contains("OPERATOR_TOOL_EXPOSURE_PROFILE\"), \"laboratory\", StringComparison.Ordinal", activation);
            Assert.Contains("DurableCoreOperationApplyAuthorizationLedgerV1", activation);
            Assert.Contains("DynamicBuildingSystemsSnapshotAuthorityV1", activation);
            Assert.Contains("DynamicBuildingSystemsObservationContractV1.MaximumRequestBytes", activation);
            Assert.Contains("authorization_granted = false", activation);
        }

        [Fact]
        public void DynamicRollbackBaselinesApplyExplicitRevitCollectorFilters()
        {
            var root = FindRepositoryRoot();
            foreach (var file in new[] { "DynamicCoreOperationHost.cs", "DynamicMepResultReferenceMutationHost.cs" })
            {
                var source = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge.Logic", "Handlers", "DynamicRuntime", file));
                Assert.Contains("foreach (var element in AllElements(document))", source);
                Assert.Contains("new FilteredElementCollector(document).WhereElementIsNotElementType()", source);
                Assert.Contains("new FilteredElementCollector(document).WhereElementIsElementType()", source);
                Assert.DoesNotContain("foreach (var element in new FilteredElementCollector(document))", source);
            }
        }

        [Fact]
        public void DynamicMepOutputsRemainProvenWhileRevitCollateralIsFullyAccounted()
        {
            var root = FindRepositoryRoot();
            var source = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge.Logic", "Handlers", "DynamicRuntime", "DynamicMepResultReferenceMutationHost.cs"));
            Assert.Contains("outputIds.IsSubsetOf(current.Added)", source);
            Assert.Contains("!baseline.ContainsKey(id) && !createdDuringGraph.Contains(id)", source);
            Assert.Contains("scannedElementCount > BaselineLimit + 256", source);
            Assert.Contains("foreach (var element in AllElements(document))", source);
            Assert.Contains("createdDuringGraph.UnionWith(current.Added)", source);
            Assert.Contains("changes.Added.Select(id => document.GetElement", source);
            Assert.Contains("AddedCount = changes.Added.Count", source);
            Assert.Contains("addedCategoriesDuringGraph[addedCategory]", source);
            Assert.Contains("addedCategories.Any(pair => !allowedCategories.Contains(pair.Key))", source);
            Assert.Contains("addedIds.Length > budget.MaximumCreates", source);
            Assert.DoesNotContain("outputIds.SetEquals(current.Added)", source);
        }

        [Fact]
        public void NativeServerDiscoveryReceiptsAreOwnedAndFailClosedAcrossRevitProcesses()
        {
            var root = FindRepositoryRoot();
            var server = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge", "Server", "RevitHttpServer.cs"));
            var listenerStarted = server.IndexOf("listener.Start();", StringComparison.Ordinal);
            var discoveryClaim = server.IndexOf("TryPublishActiveDiscoveryReceipts(candidateUrl, _nativeTransportEpoch)", StringComparison.Ordinal);

            Assert.True(listenerStarted >= 0 && discoveryClaim > listenerStarted);
            Assert.Contains("HasLiveForeignDiscoveryOwner(listenerPath)", server);
            Assert.Contains("IsExactDiscoveryOwner(listenerPath, url, serverEpoch)", server);
            Assert.Contains("A live Revit bridge already owns the global discovery receipts", server);
            Assert.Contains("preserved any discovery receipts owned by another Revit process", server);
            Assert.DoesNotContain("WriteActiveTransportReceipt(\"\", \"\")", server);
        }

        [Fact]
        public void LaboratoryCertificationEvidenceRetainsProtectedTransportWithoutManufacturingPolicyAdmission()
        {
            var root = FindRepositoryRoot();
            var server = File.ReadAllText(Path.Combine(root, "apps", "revit-bridge-addin", "RevitBridge", "Server", "RevitHttpServer.cs"));

            Assert.Contains("protectedLaboratoryEvidence = laboratoryBypass", server);
            Assert.Contains("OPERATOR_CERTIFICATION_PROTECTED_LABORATORY", server);
            Assert.Contains("CERTIFICATION_LABORATORY_FAMILY_ADMISSION_FORBIDDEN", server);
            Assert.Contains("OperatorNativeTransportProtocol.TransportPath", server);
            Assert.Contains("OperatorNativeTransportHttpAdapter.OpenCertifiedRequest", server);
            Assert.Contains("if (laboratoryBypass && !protectedLaboratoryEvidence)", server);
            Assert.Contains("if (effectiveRequest != null && !protectedLaboratoryEvidence)", server);
            Assert.Contains("does not manufacture an L4 policy decision", server);
            var eventDispatch = server.IndexOf("result = await _eventService.Run", StringComparison.Ordinal);
            var signedReceipt = server.IndexOf("AttachAfterRevitThreadCompletion", StringComparison.Ordinal);
            Assert.True(eventDispatch >= 0 && signedReceipt > eventDispatch);
        }

        [Fact]
        public void Laboratory_evidence_dispatch_round_trips_only_as_authenticated_strict_metadata()
        {
            var dispatch = JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["schema"] = OperatorLaboratoryEvidenceDispatch.SchemaName,
                ["candidate_source_hash"] = OperatorLaboratoryEvidenceDispatch.Epic0437CandidateSourceHash,
                ["policy_hash"] = OperatorNativeToolExposureEmbeddedAuthority.CompiledPolicyHash,
                ["policy_record_hash"] = "sha256:e795c609f293ae9c478de71dd6a61e806ba50bc135f69b2b3093425d2c4a082f",
                ["evidence_record_hash"] = "sha256:b2ee2e72154548e3130f43c0b47dc5746819e81c3fba058fabeac991b40e2915",
                ["effect_hash"] = "sha256:0f19ae675c51b10854e3977070ad34e4898a004c4a724058f933c17233f37bf8",
                ["evidence_run_id"] = new string('b', 32),
                ["evidence_step"] = "context-before",
                ["transport_kind"] = "direct",
                ["job_id"] = null,
                ["correlation_id"] = null,
                ["workflow"] = "epic-0437-l3-context-before",
                ["channel"] = "typed_mcp",
                ["alias"] = "revit_get_context",
                ["production_certified"] = false
            });
            var protectedRequest = OperatorNativeTransportCodec.ProtectRequest(
                Token, Epoch, "GET", "/revit/context", "", "", Now,
                RequestId, "typed_mcp", "revit_get_context", laboratoryEvidenceJson: dispatch);
            var opened = Open(protectedRequest.EnvelopeJson, Now, new OperatorNativeTransportReplayCache());
            Assert.NotNull(opened.LaboratoryEvidence);
            Assert.Equal("context-before", opened.LaboratoryEvidence!.EvidenceStep);
            Assert.Equal("direct", opened.LaboratoryEvidence.TransportKind);

            using var invalid = JsonDocument.Parse(dispatch);
            var invalidValues = invalid.RootElement.EnumerateObject().ToDictionary(
                property => property.Name,
                property => (object?)property.Value.Clone(),
                StringComparer.Ordinal);
            invalidValues["production_certified"] = true;
            Assert.Equal("CERTIFICATION_LABORATORY_EVIDENCE_DISPATCH_INVALID",
                Assert.Throws<OperatorNativeHttpAdmissionException>(() =>
                    OperatorNativeTransportCodec.ProtectRequest(
                        Token, Epoch, "POST", "/revit/context", "{}", "", Now,
                        laboratoryEvidenceJson: JsonSerializer.Serialize(invalidValues))).Code);
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

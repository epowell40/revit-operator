using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorCourierFinalExecutionAuthorizationTests
    {
        private const string Hash1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
        private const string Hash2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
        private const string Hash3 = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
        private const string Hash4 = "sha256:4444444444444444444444444444444444444444444444444444444444444444";
        private const string Hash5 = "sha256:5555555555555555555555555555555555555555555555555555555555555555";
        private const string Hash6 = "sha256:6666666666666666666666666666666666666666666666666666666666666666";

        [Fact]
        public void Fresh_exact_authorization_binds_one_executable_body_and_expiry()
        {
            var job = CreateValidJob("{\"viewId\":42}");
            var claimed = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(job);
            Assert.True(claimed.IsValid, claimed.Code + ": " + claimed.Error);

            var result = OperatorCourierFinalExecutionAuthorizationBinder.Bind(
                CreateAuthorizationResponse(job),
                claimed,
                "executor-a",
                DateTimeOffset.UtcNow);

            Assert.True(result.IsValid, result.Code + ": " + result.Error);
            var authorization = Assert.IsType<OperatorCourierFinalExecutionAuthorization>(result.Authorization);
            Assert.Equal("GET", authorization.Method);
            Assert.Equal("/revit/ping", authorization.Path);
            Assert.Equal("{\"viewId\":42}", authorization.BodyJson);
            Assert.True(authorization.ParsedBody.HasValue);
            Assert.Equal(42, authorization.ParsedBody!.Value.GetProperty("viewId").GetInt32());
            Assert.Equal(claimed.Job!.ExpiresAtUtc, authorization.ExpiresAtUtc);
            Assert.True(OperatorCourierFinalExecutionAuthorizationBinder.IsCurrent(authorization, DateTimeOffset.UtcNow));
            Assert.True(OperatorCourierFinalExecutionAuthorizationBinder.IsBoundToAction(
                authorization,
                claimed.Job.ExpiresAtUtc,
                claimed.Job.Id,
                claimed.Job.CorrelationId,
                "GET",
                "/revit/ping",
                "model-a",
                "C:\\models\\model-a.rvt",
                true,
                "{\"viewId\":42}",
                DateTimeOffset.UtcNow));
            Assert.False(OperatorCourierFinalExecutionAuthorizationBinder.IsBoundToAction(
                authorization,
                claimed.Job.ExpiresAtUtc,
                claimed.Job.Id,
                claimed.Job.CorrelationId,
                "GET",
                "/revit/ping",
                "model-a",
                "C:\\models\\model-a.rvt",
                true,
                "{\"viewId\":99}",
                DateTimeOffset.UtcNow));
            Assert.False(OperatorCourierFinalExecutionAuthorizationBinder.IsBoundToAction(
                authorization,
                claimed.Job.ExpiresAtUtc,
                claimed.Job.Id,
                claimed.Job.CorrelationId,
                "GET",
                "/revit/ping",
                "model-a",
                "C:\\models\\model-a.rvt",
                true,
                "{\"viewId\":42}",
                claimed.Job.ExpiresAtUtc));
        }

        [Theory]
        [InlineData("job_id", "other-job")]
        [InlineData("correlation_id", "other-job")]
        [InlineData("executor_id", "other-executor")]
        [InlineData("method", "POST")]
        [InlineData("path", "/revit/context")]
        [InlineData("body_json", "{\"other\":true}")]
        [InlineData("policy_hash", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
        [InlineData("policy_record_hash", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
        [InlineData("evidence_record_hash", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
        [InlineData("request_hash", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
        [InlineData("effect_hash", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
        [InlineData("channel", "generic_call")]
        [InlineData("alias", "revit_call_tool")]
        [InlineData("runtime_mode", "production")]
        [InlineData("exposure_profile", "laboratory")]
        [InlineData("policy_trust_source", "bundled")]
        [InlineData("certification_envelope_hash", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
        public void Any_final_authorization_mutation_is_terminal_no_execute(string field, string value)
        {
            var job = CreateValidJob("{\"viewId\":42}");
            var claimed = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(job);
            var response = CreateAuthorizationResponse(job, authorization => authorization[field] = value);

            var result = OperatorCourierFinalExecutionAuthorizationBinder.Bind(response, claimed, "executor-a", DateTimeOffset.UtcNow);

            Assert.False(result.IsValid);
            Assert.Null(result.Authorization);
            Assert.StartsWith("CERTIFICATION_FINAL_", result.Code);
        }

        [Fact]
        public void Returned_job_tampering_unknown_fields_and_expiry_are_terminal_no_execute()
        {
            var job = CreateValidJob("{\"viewId\":42}");
            var claimed = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(job);

            var tamperedJob = job.Replace("model-a", "model-b");
            var returnedJobMismatch = OperatorCourierFinalExecutionAuthorizationBinder.Bind(
                CreateAuthorizationResponse(job, returnedJobJson: tamperedJob),
                claimed,
                "executor-a",
                DateTimeOffset.UtcNow);
            Assert.False(returnedJobMismatch.IsValid);

            var extraField = CreateAuthorizationResponse(job).Replace("\"authorization\":{", "\"authorization\":{\"unexpected\":true,");
            var malformed = OperatorCourierFinalExecutionAuthorizationBinder.Bind(extraField, claimed, "executor-a", DateTimeOffset.UtcNow);
            Assert.False(malformed.IsValid);

            var expired = OperatorCourierFinalExecutionAuthorizationBinder.Bind(
                CreateAuthorizationResponse(job),
                claimed,
                "executor-a",
                claimed.Job!.ExpiresAtUtc.AddMilliseconds(1));
            Assert.False(expired.IsValid);
            Assert.Equal("CERTIFICATION_FINAL_JOB_EXPIRED", expired.Code);
        }

        [Fact]
        public void V2_job_top_level_unknown_and_duplicate_keys_are_terminal_before_binding()
        {
            var job = CreateValidJob("{\"viewId\":42}");

            var unknown = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(
                job.Insert(1, "\"unexpected_execution_hint\":true,"));
            Assert.False(unknown.IsValid);
            Assert.Equal("CERT_COURIER_JOB_UNKNOWN_FIELD", unknown.Code);

            var duplicate = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(
                job.Insert(1, "\"version\":\"revit-operator.revit-tool-job.v2\","));
            Assert.False(duplicate.IsValid);
            Assert.Equal("CERT_COURIER_JOB_DUPLICATE_KEY", duplicate.Code);
        }

        [Fact]
        public async System.Threading.Tasks.Task Target_executor_mismatch_or_missing_blocks_refresh_before_any_dispatch()
        {
            var mismatchedClaim = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(CreateValidJob("{\"viewId\":42}"));
            var unaddressedClaim = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(CreateValidJob("{\"viewId\":42}", null));
            Assert.True(mismatchedClaim.IsValid, mismatchedClaim.Code + ": " + mismatchedClaim.Error);
            Assert.True(unaddressedClaim.IsValid, unaddressedClaim.Code + ": " + unaddressedClaim.Error);
            var mismatchedPrequeue = OperatorCourierFinalExecutionAuthorizationBinder.Bind(
                CreateAuthorizationResponse(CreateValidJob("{\"viewId\":42}")),
                mismatchedClaim,
                "executor-b",
                DateTimeOffset.UtcNow);
            Assert.Equal("CERTIFICATION_FINAL_TARGET_EXECUTOR_MISMATCH", mismatchedPrequeue.Code);
            var unaddressedPrequeue = OperatorCourierFinalExecutionAuthorizationBinder.Bind(
                CreateAuthorizationResponse(CreateValidJob("{\"viewId\":42}", null)),
                unaddressedClaim,
                "executor-a",
                DateTimeOffset.UtcNow);
            Assert.Equal("CERTIFICATION_FINAL_TARGET_EXECUTOR_MISMATCH", unaddressedPrequeue.Code);

            var refreshCalls = 0;
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                OperatorCourierFinalExecutionAuthorizationBinder.RequireFreshBoundAuthorizationAsync(
                    _ =>
                    {
                        refreshCalls++;
                        return System.Threading.Tasks.Task.FromException<OperatorCourierFinalExecutionAuthorization>(
                            new InvalidOperationException("must not contact authorization endpoint"));
                    },
                    mismatchedClaim,
                    "executor-b",
                    System.Threading.CancellationToken.None));
            Assert.Equal(0, refreshCalls);

            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                OperatorCourierFinalExecutionAuthorizationBinder.RequireFreshBoundAuthorizationAsync(
                    _ =>
                    {
                        refreshCalls++;
                        return System.Threading.Tasks.Task.FromException<OperatorCourierFinalExecutionAuthorization>(
                            new InvalidOperationException("must not contact authorization endpoint"));
                    },
                    unaddressedClaim,
                    "executor-a",
                    System.Threading.CancellationToken.None));
            Assert.Equal(0, refreshCalls);
        }

        [Fact]
        public async System.Threading.Tasks.Task Prequeue_success_then_inline_refresh_denial_invokes_zero_dispatches()
        {
            var job = CreateValidJob("{\"viewId\":42}");
            var claimed = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(job);
            var prequeue = OperatorCourierFinalExecutionAuthorizationBinder.Bind(
                CreateAuthorizationResponse(job), claimed, "executor-a", DateTimeOffset.UtcNow);
            Assert.True(prequeue.IsValid, prequeue.Code + ": " + prequeue.Error);

            var finalRefreshes = 0;
            var dispatches = 0;
            await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            {
                var refreshed = await OperatorCourierFinalExecutionAuthorizationBinder.RequireFreshBoundAuthorizationAsync(
                    _ =>
                    {
                        finalRefreshes++;
                        return System.Threading.Tasks.Task.FromException<OperatorCourierFinalExecutionAuthorization>(
                            new InvalidOperationException("authorization revoked after prequeue"));
                    },
                    claimed,
                    "executor-a",
                    System.Threading.CancellationToken.None);
                _ = refreshed;
                dispatches++;
            });

            Assert.Equal(1, finalRefreshes);
            Assert.Equal(0, dispatches);
        }

        [Fact]
        public async System.Threading.Tasks.Task Final_refresh_runs_for_each_busy_attempt_and_revocation_blocks_the_next_dispatch()
        {
            var job = CreateValidJob("{\"viewId\":42}");
            var claimed = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(job);
            var prequeue = OperatorCourierFinalExecutionAuthorizationBinder.Bind(
                CreateAuthorizationResponse(job), claimed, "executor-a", DateTimeOffset.UtcNow);
            var prequeueAuthorization = Assert.IsType<OperatorCourierFinalExecutionAuthorization>(prequeue.Authorization);
            var finalRefreshes = 0;
            var dispatches = 0;

            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                OperatorCourierBusyRetryExecutor.ExecuteAsync<object>(
                    async token =>
                    {
                        var refreshed = await OperatorCourierFinalExecutionAuthorizationBinder.RequireFreshBoundAuthorizationAsync(
                            _ =>
                            {
                                finalRefreshes++;
                                return finalRefreshes == 2
                                    ? System.Threading.Tasks.Task.FromException<OperatorCourierFinalExecutionAuthorization>(
                                        new InvalidOperationException("authorization revoked while queued"))
                                    : System.Threading.Tasks.Task.FromResult(prequeueAuthorization);
                            },
                            claimed,
                            "executor-a",
                            token);
                        _ = refreshed;
                        dispatches++;
                        throw new BusyExternalEventException();
                    },
                    System.Threading.CancellationToken.None,
                    "job-correlation",
                    new[] { 0 },
                    delayAsync: (_, __) => System.Threading.Tasks.Task.CompletedTask));

            Assert.Equal(2, finalRefreshes);
            Assert.Equal(1, dispatches);
        }

        [Fact]
        public void Courier_refresh_claim_and_executor_runtime_fields_never_serialize()
        {
            var claimed = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(CreateValidJob("{\"viewId\":42}"));
            var action = new OperatorActionCall
            {
                ActionId = "job-a",
                CorrelationId = "job-a",
                Method = "GET",
                Path = "/revit/ping",
                CourierFinalExecutionAuthorization = new OperatorCourierFinalExecutionAuthorization(),
                CourierVerifiedClaim = claimed,
                CourierLocalExecutorId = "executor-a",
                CourierFinalExecutionRefreshAsync = _ => System.Threading.Tasks.Task.FromResult(new OperatorCourierFinalExecutionAuthorization())
            };

            var json = JsonSerializer.Serialize(action);

            Assert.DoesNotContain("CourierFinalExecutionAuthorization", json, StringComparison.Ordinal);
            Assert.DoesNotContain("CourierVerifiedClaim", json, StringComparison.Ordinal);
            Assert.DoesNotContain("CourierLocalExecutorId", json, StringComparison.Ordinal);
            Assert.DoesNotContain("CourierFinalExecutionRefreshAsync", json, StringComparison.Ordinal);
        }

        [Fact]
        public void Every_direct_action_runner_boundary_refreshes_and_revalidates_immediately_before_dispatch()
        {
            var source = ReadRepoFile(
                "apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorActionRunner.cs")
                .Replace("\r\n", "\n");
            const string finalGate = "RefreshAndValidateCourierFinalExecutionAuthorization(action, method, path, correlationId, cancellationToken);";

            Assert.Contains(
                "if (string.Equals(path, \"/revit/ping\", StringComparison.OrdinalIgnoreCase))\n" +
                "            {\n" +
                "                " + finalGate + "\n" +
                "                return AttachSettlement(action, new { status = \"ok\", timestamp = DateTime.Now }, requestedEffect, method, path);",
                source);
            Assert.Contains(
                "if (string.Equals(path, \"/revit/capabilities\", StringComparison.OrdinalIgnoreCase))\n" +
                "            {\n" +
                "                " + finalGate + "\n" +
                "                return AttachSettlement(action, OperatorCapabilities.Get(), requestedEffect, method, path);",
                source);
            Assert.Contains(
                "if (string.Equals(path, \"/revit/write-grant-status\", StringComparison.OrdinalIgnoreCase))\n" +
                "            {\n" +
                "                " + finalGate + "\n" +
                "                var status = OperatorWriteGrant.ReadStatus();",
                source);
            Assert.Contains(
                "if (IsDirectDialogComputerUsePath(path))\n" +
                "            {\n" +
                "                " + finalGate + "\n" +
                "                return AttachSettlement(action, await handler.Handle(null!, jsonBody)",
                source);
            Assert.Contains(
                "if (IsDirectControlPlanePath(path))\n" +
                "            {\n" +
                "                " + finalGate + "\n" +
                "                var directResult = handler is NativeApiPolicyHandler",
                source);
            Assert.Contains("return AttachSettlement(action, directResult, requestedEffect, method, path);", source);
            Assert.Contains("\"/revit/computer-use-act\"", source);
            Assert.Contains("\"/revit/computer-use-guard\"", source);
            Assert.Contains("\"/revit/tool-registry\"", source);
            Assert.Contains("\"/revit/native-api-policy\"", source);
            Assert.Contains("refreshTimeout.CancelAfter(CourierFinalExecutionRefreshTimeout);", source);
            Assert.Contains("TimeSpan.FromSeconds(5)", source);
            Assert.Contains("RefreshCourierFinalExecutionAuthorization(action, cancellationToken);\n" +
                "            ValidateCourierFinalExecutionAuthorization(action, method, path, correlationId, requireFinalFamilyStage: true);", source);
            Assert.Contains("authorization.RequestFamilyAdmission != null\n" +
                "                    && !string.Equals(authorization.AuthorizationStage, \"final\", StringComparison.Ordinal)", source);
            Assert.Contains("OperatorCertifiedMovePreviewAuthority.IsIndependentlyVerifiedCertifiedFamilyResult(result)", source);
            Assert.Contains(
                "return AttachSettlement(action, result, requestedEffect, method, path);\n" +
                "                throw new OperatorRecoveredDialogException",
                source);
        }

        [Theory]
        [InlineData("/revit/ping", "revoked")]
        [InlineData("/revit/ping", "timeout")]
        [InlineData("/revit/computer-use-act", "revoked")]
        [InlineData("/revit/computer-use-guard", "timeout")]
        [InlineData("/revit/tool-registry", "revoked")]
        [InlineData("/revit/native-api-policy", "timeout")]
        public async System.Threading.Tasks.Task Direct_final_revocation_or_timeout_produces_zero_return_or_handler_dispatch(
            string path,
            string failure)
        {
            var job = CreateValidJob("{\"viewId\":42}");
            var claimed = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(job);
            var prequeue = OperatorCourierFinalExecutionAuthorizationBinder.Bind(
                CreateAuthorizationResponse(job), claimed, "executor-a", DateTimeOffset.UtcNow);
            Assert.True(prequeue.IsValid, prequeue.Code + ": " + prequeue.Error);

            var finalRefreshes = 0;
            var dispatches = 0;
            using var timeout = new System.Threading.CancellationTokenSource();
            if (string.Equals(failure, "timeout", StringComparison.Ordinal)) timeout.Cancel();

            await Assert.ThrowsAnyAsync<Exception>(() => ExecuteDirectBoundaryForTestAsync(
                claimed,
                async token =>
                {
                    finalRefreshes++;
                    if (string.Equals(failure, "timeout", StringComparison.Ordinal))
                    {
                        await System.Threading.Tasks.Task.Delay(System.Threading.Timeout.Infinite, token);
                    }
                    throw new InvalidOperationException("Final direct authorization was revoked for " + path + ".");
                },
                () => dispatches++,
                timeout.Token));

            Assert.Equal(1, finalRefreshes);
            Assert.Equal(0, dispatches);
        }

        [Theory]
        [InlineData("/revit/ping")]
        [InlineData("/revit/computer-use-act")]
        [InlineData("/revit/computer-use-guard")]
        [InlineData("/revit/tool-registry")]
        [InlineData("/revit/native-api-policy")]
        public async System.Threading.Tasks.Task Valid_direct_path_refreshes_exactly_once_at_its_final_boundary(string path)
        {
            var job = CreateValidJob("{\"viewId\":42}");
            var claimed = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(job);
            var prequeue = OperatorCourierFinalExecutionAuthorizationBinder.Bind(
                CreateAuthorizationResponse(job), claimed, "executor-a", DateTimeOffset.UtcNow);
            var authorization = Assert.IsType<OperatorCourierFinalExecutionAuthorization>(prequeue.Authorization);
            var finalRefreshes = 0;
            var dispatches = 0;

            await ExecuteDirectBoundaryForTestAsync(
                claimed,
                _ =>
                {
                    finalRefreshes++;
                    return System.Threading.Tasks.Task.FromResult(authorization);
                },
                () => dispatches++,
                System.Threading.CancellationToken.None);

            Assert.False(string.IsNullOrWhiteSpace(path));
            Assert.Equal(1, finalRefreshes);
            Assert.Equal(1, dispatches);
        }

        [Fact]
        public async System.Threading.Tasks.Task Busy_retry_reauthorizes_and_revocation_prevents_the_next_dispatch()
        {
            var authorizationAttempts = 0;
            var dispatches = 0;

            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                OperatorCourierBusyRetryExecutor.ExecuteAsync<object>(
                    _ =>
                    {
                        authorizationAttempts++;
                        if (authorizationAttempts == 2)
                            return System.Threading.Tasks.Task.FromException<object>(new InvalidOperationException("final execution authorization was revoked"));
                        dispatches++;
                        return System.Threading.Tasks.Task.FromException<object>(new BusyExternalEventException());
                    },
                    System.Threading.CancellationToken.None,
                    "job-correlation",
                    new[] { 0 },
                    delayAsync: (_, __) => System.Threading.Tasks.Task.CompletedTask));

            Assert.Equal(2, authorizationAttempts);
            Assert.Equal(1, dispatches);
        }

        [Theory]
        [InlineData("development", "laboratory", true)]
        [InlineData("Development", "laboratory", false)]
        [InlineData("development", "Laboratory", false)]
        [InlineData("development ", "laboratory", false)]
        [InlineData("local", "laboratory", false)]
        [InlineData("development", "certified", false)]
        [InlineData("", "", false)]
        public void Legacy_v1_compatibility_requires_the_exact_development_laboratory_profile(
            string runtimeMode,
            string exposureProfile,
            bool expected)
        {
            Assert.Equal(expected, OperatorCourierRuntimeProfile.IsExactDevelopmentLaboratory(runtimeMode, exposureProfile));
        }

        [Fact]
        public void Family_completion_challenge_is_null_at_preflight_and_exact_at_final()
        {
            const string challenge = "cmcc1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
            var challengeHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(challenge);

            Assert.True(OperatorCourierFinalExecutionAuthorizationBinder.ValidateCompletionChallenge(
                "preflight", null, null));
            Assert.False(OperatorCourierFinalExecutionAuthorizationBinder.ValidateCompletionChallenge(
                "preflight", challenge, challengeHash));
            Assert.True(OperatorCourierFinalExecutionAuthorizationBinder.ValidateCompletionChallenge(
                "final", challenge, challengeHash));
            Assert.False(OperatorCourierFinalExecutionAuthorizationBinder.ValidateCompletionChallenge(
                "final", challenge, Hash1));
            Assert.False(OperatorCourierFinalExecutionAuthorizationBinder.ValidateCompletionChallenge(
                "final", "cmcc1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB", challengeHash));
            Assert.False(OperatorCourierFinalExecutionAuthorizationBinder.ValidateCompletionChallenge(
                "final", "cmcc1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", challengeHash));
        }

        private static string CreateValidJob(string bodyJson, string? targetExecutorId = "executor-a")
        {
            var bodyHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(bodyJson);
            var envelope = new Dictionary<string, object?>
            {
                ["schema"] = OperatorCourierCertificationEnvelope.Schema,
                ["version"] = 1,
                ["canonicalization"] = OperatorCourierCertificationEnvelope.Canonicalization,
                ["policy_hash"] = Hash1,
                ["policy_record_hash"] = Hash2,
                ["evidence_record_hash"] = Hash3,
                ["request_hash"] = Hash4,
                ["effect_hash"] = Hash5,
                ["method"] = "GET",
                ["path"] = "/revit/ping",
                ["body_present"] = true,
                ["body_sha256"] = bodyHash,
                ["channel"] = "typed_mcp",
                ["alias"] = "revit_ping",
                ["runtime_mode"] = "hosted",
                ["exposure_profile"] = "certified",
                ["policy_trust_source"] = "deployment"
            };
            using (var envelopeDocument = JsonDocument.Parse(JsonSerializer.Serialize(envelope)))
            {
                envelope["envelope_hash"] = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(
                    OperatorCourierCertificationEnvelopeVerifier.Canonicalize(envelopeDocument.RootElement));
            }

            var createdAtValue = DateTimeOffset.UtcNow;
            var createdAt = createdAtValue.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            var expiresAt = createdAtValue.AddMinutes(10).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            var id = OperatorCourierCertificationEnvelopeVerifier.ComputeV2IdempotencyKey(
                (string)envelope["envelope_hash"]!,
                "GET",
                "/revit/ping",
                "session-a",
                "message-a",
                expiresAt,
                Hash6,
                targetExecutorId,
                "model-a",
                "C:\\models\\model-a.rvt",
                true,
                bodyHash);
            return JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["version"] = OperatorCourierCertificationEnvelope.JobVersion,
                ["id"] = id,
                ["correlation_id"] = id,
                ["idempotency_key"] = id,
                ["session_id"] = "session-a",
                ["message_id"] = "message-a",
                ["turn_token_sha256"] = Hash6,
                ["method"] = "GET",
                ["path"] = "/revit/ping",
                ["target_executor_id"] = targetExecutorId,
                ["target_document_title"] = "model-a",
                ["target_document_path"] = "C:\\models\\model-a.rvt",
                ["body_present"] = true,
                ["body_json"] = bodyJson,
                ["certification_envelope"] = envelope,
                ["created_at"] = createdAt,
                ["expires_at"] = expiresAt,
                ["status"] = "running"
            });
        }

        private static async System.Threading.Tasks.Task ExecuteDirectBoundaryForTestAsync(
            OperatorCourierCertificationEnvelopeValidationResult claimed,
            Func<System.Threading.CancellationToken, System.Threading.Tasks.Task<OperatorCourierFinalExecutionAuthorization>> refreshAsync,
            Action dispatch,
            System.Threading.CancellationToken cancellationToken)
        {
            await OperatorCourierFinalExecutionAuthorizationBinder.RequireFreshBoundAuthorizationAsync(
                refreshAsync,
                claimed,
                "executor-a",
                cancellationToken);
            dispatch();
        }

        private static string ReadRepoFile(params string[] relativeSegments)
        {
            var cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null)
            {
                var candidate = Path.Combine(new[] { cursor.FullName }.Concat(relativeSegments).ToArray());
                if (File.Exists(candidate)) return File.ReadAllText(candidate);
                cursor = cursor.Parent;
            }
            throw new FileNotFoundException("Could not locate repository source file.", Path.Combine(relativeSegments));
        }

        private static string CreateAuthorizationResponse(
            string jobJson,
            Action<Dictionary<string, object?>>? mutateAuthorization = null,
            string? returnedJobJson = null)
        {
            using (var jobDocument = JsonDocument.Parse(jobJson))
            using (var returnedJobDocument = JsonDocument.Parse(returnedJobJson ?? jobJson))
            {
                var job = jobDocument.RootElement;
                var envelope = job.GetProperty("certification_envelope");
                var authorization = new Dictionary<string, object?>
                {
                    ["version"] = OperatorCourierFinalExecutionAuthorization.Schema,
                    ["phase"] = OperatorCourierFinalExecutionAuthorization.Phase,
                    ["authorized_at"] = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                    ["job_id"] = job.GetProperty("id").GetString(),
                    ["correlation_id"] = job.GetProperty("correlation_id").GetString(),
                    ["session_id"] = job.GetProperty("session_id").GetString(),
                    ["executor_id"] = "executor-a",
                    ["target_executor_id"] = job.GetProperty("target_executor_id").GetString(),
                    ["target_document_title"] = job.GetProperty("target_document_title").GetString(),
                    ["target_document_path"] = job.GetProperty("target_document_path").GetString(),
                    ["method"] = job.GetProperty("method").GetString(),
                    ["path"] = job.GetProperty("path").GetString(),
                    ["body_present"] = job.GetProperty("body_present").GetBoolean(),
                    ["body_json"] = job.GetProperty("body_json").GetString(),
                    ["policy_hash"] = envelope.GetProperty("policy_hash").GetString(),
                    ["policy_record_hash"] = envelope.GetProperty("policy_record_hash").GetString(),
                    ["evidence_record_hash"] = envelope.GetProperty("evidence_record_hash").GetString(),
                    ["request_hash"] = envelope.GetProperty("request_hash").GetString(),
                    ["effect_hash"] = envelope.GetProperty("effect_hash").GetString(),
                    ["channel"] = envelope.GetProperty("channel").GetString(),
                    ["alias"] = envelope.GetProperty("alias").GetString(),
                    ["runtime_mode"] = envelope.GetProperty("runtime_mode").GetString(),
                    ["exposure_profile"] = envelope.GetProperty("exposure_profile").GetString(),
                    ["policy_trust_source"] = envelope.GetProperty("policy_trust_source").GetString(),
                    ["certification_envelope_hash"] = envelope.GetProperty("envelope_hash").GetString()
                };
                mutateAuthorization?.Invoke(authorization);
                return JsonSerializer.Serialize(new Dictionary<string, object?>
                {
                    ["ok"] = true,
                    ["job"] = returnedJobDocument.RootElement,
                    ["authorization"] = authorization
                });
            }
        }

        private sealed class BusyExternalEventException : InvalidOperationException, IOperatorRevitFailureMetadata
        {
            public BusyExternalEventException() : base("The Revit ExternalEvent queue is busy.") { }
            public string Code => "revit_external_event_busy";
            public bool Retryable => true;
            public string Phase => "revit_external_event";
            public string HostHealth => "healthy";
            public bool OpensCircuit => false;
            public bool OutcomeUnknown => false;
        }
    }
}

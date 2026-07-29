using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using RevitBridge.Common;
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

        private static string CreateValidJob(string bodyJson)
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
                "executor-a",
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
                ["target_executor_id"] = "executor-a",
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

using System;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal sealed class OperatorRevitCourierWorker : IDisposable
    {
        private readonly OperatorBackendClient _backendClient;
        private readonly OperatorActionRunner _actionRunner;
        private readonly Func<OperatorApprovalMode> _getApprovalMode;
        private readonly Func<OperatorWriteGrantStatus> _ensureWriteGrant;
        private readonly Func<OperatorJsonlLogger?> _getLogger;
        private readonly OperatorCourierCompletionOutbox _completionOutbox = new OperatorCourierCompletionOutbox();
        private readonly OperatorRevitHostCircuit _hostCircuit = new OperatorRevitHostCircuit();
        private readonly string _executorId = ExecutorIdForCurrentProcess();
        private readonly SemaphoreSlim _runGate = new SemaphoreSlim(1, 1);
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private static readonly int[] ExternalEventBusyRetryDelaysMs = { 100, 200, 400, 800, 1600, 2000, 2000, 2000 };
        private Timer? _timer;

        public OperatorRevitCourierWorker(
            OperatorBackendClient backendClient,
            OperatorActionRunner actionRunner,
            Func<OperatorApprovalMode> getApprovalMode,
            Func<OperatorWriteGrantStatus> ensureWriteGrant,
            Func<OperatorJsonlLogger?> getLogger)
        {
            _backendClient = backendClient;
            _actionRunner = actionRunner;
            _getApprovalMode = getApprovalMode;
            _ensureWriteGrant = ensureWriteGrant;
            _getLogger = getLogger;
        }

        public void Start()
        {
            if (_timer != null) return;
            _timer = new Timer(_ => _ = RunOnceAsync(), null, TimeSpan.FromMilliseconds(250), TimeSpan.FromSeconds(2));
        }

        internal static string ExecutorIdForCurrentProcess()
        {
            return Environment.MachineName + "-revit-courier-" + Process.GetCurrentProcess().Id;
        }

        public void Dispose()
        {
            try { _cts.Cancel(); } catch { }
            try { _timer?.Dispose(); } catch { }
            _timer = null;
            try { _runGate.Dispose(); } catch { }
            try { _cts.Dispose(); } catch { }
        }

        private async Task RunOnceAsync()
        {
            if (!_runGate.Wait(0)) return;
            string? sessionId = null;
            string? jobId = null;
            string? correlationId = null;
            var executionCompleted = false;
            try
            {
                // A completed Revit action must be acknowledged before this worker accepts more work.
                // This replays durable completion evidence after a transient backend outage or pane/Revit restart.
                if (await FlushOnePendingCompletionAsync().ConfigureAwait(false)) return;
                if (await HoldForOpenHostCircuitAsync().ConfigureAwait(false)) return;

                var claimJson = await _backendClient.ClaimNextRevitCourierJobJsonAsync(null, _executorId, _cts.Token).ConfigureAwait(false);
                using var claimDocument = JsonDocument.Parse(string.IsNullOrWhiteSpace(claimJson) ? "{}" : claimJson);
                if (!claimDocument.RootElement.TryGetProperty("job", out var job) || job.ValueKind != JsonValueKind.Object) return;

                var version = ReadRequiredString(job, "version", 100);
                OperatorActionCall? legacyAction = null;
                OperatorCourierCertificationEnvelopeValidationResult? verifiedV2 = null;
                string method;
                string path;
                string bodyJson;
                DateTimeOffset expiresAt;

                if (string.Equals(version, "revit-operator.revit-tool-job.v1", StringComparison.Ordinal))
                {
                    jobId = ReadRequiredString(job, "id", 200);
                    sessionId = ReadRequiredString(job, "session_id", 200);
                    if (!OperatorCourierRuntimeProfile.IsExactDevelopmentLaboratory(
                        Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE"),
                        Environment.GetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE")))
                    {
                        throw new OperatorCourierCertificationException(
                            "CERTIFICATION_FINAL_LEGACY_V1_REJECTED",
                            "Legacy v1 courier jobs may execute only when REVIT_OPERATOR_MODE=development and OPERATOR_TOOL_EXPOSURE_PROFILE=laboratory.");
                    }

                    correlationId = ReadRequiredString(job, "correlation_id", 160);
                    if (!OperatorCorrelationId.IsValid(correlationId) || !string.Equals(correlationId, jobId, StringComparison.Ordinal))
                        throw new OperatorCourierCertificationException("CERTIFICATION_FINAL_LEGACY_V1_INVALID", "Legacy Revit courier job has an invalid or mismatched correlation_id.");
                    method = ReadRequiredString(job, "method", 10).ToUpperInvariant();
                    path = ReadRequiredString(job, "path", 300);
                    var expectedDocumentTitle = ReadOptionalString(job, "target_document_title", 500);
                    var expectedDocumentPath = ReadOptionalString(job, "target_document_path", 2000);
                    var expiresText = ReadRequiredString(job, "expires_at", 100);
                    if (!DateTimeOffset.TryParse(expiresText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out expiresAt))
                        throw new OperatorCourierCertificationException("CERTIFICATION_FINAL_LEGACY_V1_INVALID", "Legacy Revit courier job has invalid expires_at.");
                    object? body = null;
                    if (job.TryGetProperty("body", out var bodyElement) && bodyElement.ValueKind != JsonValueKind.Null)
                        body = bodyElement.Clone();
                    bodyJson = body is JsonElement bodyJsonElement
                        ? bodyJsonElement.GetRawText()
                        : body == null ? "" : JsonSerializer.Serialize(body);
                    legacyAction = new OperatorActionCall
                    {
                        ActionId = jobId,
                        CorrelationId = correlationId,
                        Method = method,
                        Path = path,
                        Body = body,
                        ExpectedDocumentTitle = expectedDocumentTitle,
                        ExpectedDocumentPath = expectedDocumentPath
                    };
                }
                else if (string.Equals(version, OperatorCourierCertificationEnvelope.JobVersion, StringComparison.Ordinal))
                {
                    verifiedV2 = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(job.GetRawText());
                    if (!verifiedV2.IsValid || verifiedV2.Job == null || verifiedV2.Envelope == null)
                    {
                        // Preserve enough untrusted routing identity to post a
                        // typed terminal receipt when possible. It is never
                        // used to construct or authorize a Revit action.
                        TryReadFailureIdentity(job, ref sessionId, ref jobId);
                        throw new OperatorCourierCertificationException(
                            verifiedV2.Code,
                            "Certified v2 Revit courier job was rejected before final execution: " + verifiedV2.Error);
                    }

                    jobId = verifiedV2.Job.Id;
                    sessionId = verifiedV2.Job.SessionId;
                    correlationId = verifiedV2.Job.CorrelationId;
                    method = verifiedV2.Job.Method;
                    path = verifiedV2.Job.Path;
                    bodyJson = verifiedV2.Job.BodyJson;
                    expiresAt = verifiedV2.Job.ExpiresAtUtc;
                    if (!OperatorCourierFinalExecutionAuthorizationBinder.IsTargetExecutorBound(verifiedV2, _executorId))
                    {
                        throw new OperatorCourierCertificationException(
                            "CERTIFICATION_FINAL_TARGET_EXECUTOR_MISMATCH",
                            "Certified v2 courier job target_executor_id does not exactly match this Revit executor; no Revit action was executed.");
                    }
                }
                else
                {
                    TryReadFailureIdentity(job, ref sessionId, ref jobId);
                    throw new OperatorCourierCertificationException(
                        "CERTIFICATION_FINAL_JOB_VERSION_INVALID",
                        "Unsupported Revit courier job version; no Revit action was executed.");
                }

                var risk = OperatorDryRunTurnPolicy.IsScheduleCellUpdatePreview(method, path, bodyJson)
                    ? OperatorActionRisk.Low
                    : OperatorApprovalPolicy.GetRisk(method, path, bodyJson);
                var approvalMode = _getApprovalMode();
                if (OperatorApprovalPolicy.RequiresApproval(approvalMode, risk))
                {
                    throw new OperatorCourierApprovalException("The courier action requires approval. Set Writes to Allow this session or YOLO, then retry.");
                }
                if (risk == OperatorActionRisk.High)
                {
                    var grant = _ensureWriteGrant();
                    if (!grant.Active) throw new OperatorCourierApprovalException("The courier write grant is not active.");
                }

                using var actionTimeout = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
                var remaining = expiresAt.ToUniversalTime() - DateTimeOffset.UtcNow - TimeSpan.FromSeconds(2);
                if (remaining <= TimeSpan.Zero)
                {
                    if (verifiedV2 != null)
                    {
                        throw new OperatorCourierCertificationException(
                            "CERTIFICATION_FINAL_JOB_EXPIRED",
                            "Certified Revit courier job expired before final execution authorization; no Revit action was executed.");
                    }
                    throw new OperatorCourierJobExpiredException("The Revit courier job expired before local execution started.");
                }
                var deadline = OperatorActionDeadlinePolicy.Resolve(method, path, risk.ToString()).ConstrainTo(remaining);
                actionTimeout.CancelAfter(deadline.Budget);
                Func<CancellationToken, Task<OperatorActionCall>> actionFactory;
                if (legacyAction != null)
                {
                    actionFactory = _ => Task.FromResult(legacyAction);
                }
                else
                {
                    var claimedV2 = verifiedV2!;
                    actionFactory = async cancellationToken =>
                    {
                        var authorization = await RequestFinalExecutionAuthorizationAsync(
                            claimedV2,
                            sessionId!,
                            jobId!,
                            "preflight",
                            cancellationToken).ConfigureAwait(false);
                        var action = CreateCertifiedAction(claimedV2, authorization, _executorId);
                        // The prequeue receipt only decides whether it is safe
                        // to schedule the ExternalEvent. This delegate is the
                        // authoritative second fixed-route check, executed on
                        // the Revit thread immediately before handler.Handle.
                        action.CourierFinalExecutionRefreshAsync = token => RequestFinalExecutionAuthorizationAsync(
                            claimedV2,
                            sessionId!,
                            jobId!,
                            "final",
                            token);
                        return action;
                    };
                }
                var startedAt = DateTime.UtcNow;
                object? result;
                try
                {
                    result = await ExecuteWithBusyRetryAsync(
                        actionFactory,
                        actionTimeout.Token,
                        sessionId!,
                        jobId,
                        correlationId).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!_cts.IsCancellationRequested)
                {
                    throw deadline.CreateTimeoutException(correlationId);
                }
                executionCompleted = true;
                var transportResult = OperatorCourierResultCompactor.Prepare(result);
                _completionOutbox.Save(sessionId!, jobId, _executorId, transportResult.Result);
                await _backendClient.CompleteRevitCourierJobJsonAsync(sessionId!, jobId, _executorId, transportResult.Result, CancellationToken.None).ConfigureAwait(false);
                _completionOutbox.Acknowledge(jobId);
                await LogAsync("courier.action.done", new
                {
                    session_id = sessionId,
                    job_id = jobId,
                    correlation_id = correlationId,
                    method,
                    path,
                    risk = risk.ToString(),
                    deadline_class = deadline.DeadlineClass,
                    deadline_ms = deadline.BudgetMilliseconds,
                    duration_ms = (int)Math.Max(0, (DateTime.UtcNow - startedAt).TotalMilliseconds),
                    result_compacted = transportResult.Compacted,
                    original_result_bytes = transportResult.OriginalResultBytes,
                    transport_result_bytes = transportResult.TransportResultBytes
                }).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (_cts.IsCancellationRequested)
            {
                // Normal shutdown.
            }
            catch (Exception ex)
            {
                if (executionCompleted)
                {
                    // Never convert an executed Revit action into a failure because its completion POST was interrupted.
                    // The durable outbox is replayed before another courier job is claimed.
                    await LogAsync("courier.completion.pending", new
                    {
                        session_id = sessionId,
                        job_id = jobId,
                        correlation_id = correlationId ?? jobId,
                        error = ex.Message,
                        type = ex.GetType().FullName
                    }).ConfigureAwait(false);
                }
                else if (!string.IsNullOrWhiteSpace(sessionId) && !string.IsNullOrWhiteSpace(jobId))
                {
                    var failure = OperatorCourierFailureClassifier.Classify(ex, correlationId ?? jobId);
                    if (failure.OpensCircuit)
                    {
                        _hostCircuit.Open(failure.Code, DateTimeOffset.UtcNow);
                        await LogAsync("courier.host_circuit.open", new
                        {
                            session_id = sessionId,
                            job_id = jobId,
                            correlation_id = correlationId ?? jobId,
                            failure.Code,
                            failure.Phase,
                            failure.HostHealth,
                            failure.OutcomeUnknown,
                            failure.DeadlineClass,
                            failure.DeadlineMs,
                            circuit = _hostCircuit.Snapshot()
                        }).ConfigureAwait(false);
                    }
                    try
                    {
                        await _backendClient.FailRevitCourierJobJsonAsync(
                            sessionId!,
                            jobId!,
                            _executorId,
                            failure.Error,
                            failure,
                            failure.Retryable,
                            CancellationToken.None).ConfigureAwait(false);
                    }
                    catch
                    {
                        // The durable lease will become an outcome-unknown receipt if completion cannot be posted.
                    }
                }
                if (!executionCompleted)
                {
                    await LogAsync("courier.action.failed", new
                    {
                        session_id = sessionId,
                        job_id = jobId,
                        correlation_id = correlationId ?? jobId,
                        error = ex.Message,
                        type = ex.GetType().FullName
                    }).ConfigureAwait(false);
                }
            }
            finally
            {
                try { _runGate.Release(); } catch { }
            }
        }

        private async Task<object?> ExecuteWithBusyRetryAsync(
            Func<CancellationToken, Task<OperatorActionCall>> actionFactory,
            CancellationToken cancellationToken,
            string sessionId,
            string jobId,
            string correlationId)
        {
            return await OperatorCourierBusyRetryExecutor.ExecuteAsync(
                async token =>
                {
                    // v2 factories obtain a new final-execution receipt for
                    // every attempt. A busy ExternalEvent therefore cannot
                    // turn a previous policy decision into a later Revit call.
                    var action = await actionFactory(token).ConfigureAwait(false);
                    return await _actionRunner.ExecuteAsync(action, token).ConfigureAwait(false);
                },
                cancellationToken,
                correlationId,
                ExternalEventBusyRetryDelaysMs,
                async (failure, attempt, delayMs) =>
                {
                    await LogAsync("courier.action.retry", new
                    {
                        session_id = sessionId,
                        job_id = jobId,
                        correlation_id = correlationId,
                        code = failure.Code,
                        attempt,
                        delay_ms = delayMs
                    }).ConfigureAwait(false);
                }).ConfigureAwait(false);
        }

        private async Task<bool> HoldForOpenHostCircuitAsync()
        {
            var snapshot = _hostCircuit.Snapshot();
            if (!snapshot.Open) return false;
            if (!_hostCircuit.TryBeginProbe(DateTimeOffset.UtcNow)) return true;

            try
            {
                using var probeTimeout = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
                probeTimeout.CancelAfter(TimeSpan.FromSeconds(3));
                await _actionRunner.ProbeRevitHostAsync(probeTimeout.Token).ConfigureAwait(false);
                _hostCircuit.RecordProbeSuccess();
                await LogAsync("courier.host_circuit.closed", new
                {
                    previous = snapshot,
                    host_health = "healthy"
                }).ConfigureAwait(false);
            }
            catch (Exception ex) when (!_cts.IsCancellationRequested)
            {
                var normalized = ex is OperationCanceledException
                    ? new TimeoutException("The Revit host health probe exceeded its local deadline.", ex)
                    : ex;
                var failure = OperatorCourierFailureClassifier.Classify(normalized);
                _hostCircuit.RecordProbeFailure(failure.Code, DateTimeOffset.UtcNow);
                await LogAsync("courier.host_circuit.probe_failed", new
                {
                    failure.Code,
                    failure.Phase,
                    failure.HostHealth,
                    circuit = _hostCircuit.Snapshot()
                }).ConfigureAwait(false);
            }
            return true;
        }

        private async Task<bool> FlushOnePendingCompletionAsync()
        {
            var pending = _completionOutbox.ReadPending(1);
            if (pending.Count == 0)
            {
                if (!_completionOutbox.HasUnresolvedEntries) return false;
                await LogAsync("courier.completion.outbox_invalid", new
                {
                    error = "A durable completion outbox entry is unreadable or invalid; new courier work is paused until it is diagnosed."
                }).ConfigureAwait(false);
                return true;
            }
            var completion = pending[0];
            try
            {
                var transportResult = OperatorCourierResultCompactor.Prepare(completion.Result);
                if (transportResult.Compacted)
                {
                    // Persist the bounded form before replay so a process restart cannot
                    // resurrect an impossible-to-post oversized completion.
                    _completionOutbox.Save(
                        completion.SessionId,
                        completion.JobId,
                        completion.ExecutorId,
                        transportResult.Result);
                }
                await _backendClient.CompleteRevitCourierJobJsonAsync(
                    completion.SessionId,
                    completion.JobId,
                    completion.ExecutorId,
                    transportResult.Result,
                    CancellationToken.None).ConfigureAwait(false);
                _completionOutbox.Acknowledge(completion.JobId);
                await LogAsync("courier.completion.replayed", new
                {
                    session_id = completion.SessionId,
                    job_id = completion.JobId,
                    completed_at = completion.CompletedAt,
                    result_compacted = transportResult.Compacted,
                    original_result_bytes = transportResult.OriginalResultBytes,
                    transport_result_bytes = transportResult.TransportResultBytes
                }).ConfigureAwait(false);
            }
            catch (OperatorCourierTerminalConflictException ex)
            {
                // The backend's durable terminal failure is authoritative. Preserve this
                // late local success as resolved evidence, but do not let it starve every
                // later courier job forever.
                _completionOutbox.ResolveTerminalConflict(completion.JobId, ex.Message);
                await LogAsync("courier.completion.reconciled_terminal", new
                {
                    session_id = completion.SessionId,
                    job_id = completion.JobId,
                    completed_at = completion.CompletedAt,
                    resolution_code = "backend_terminal_failure_authoritative",
                    error = ex.Message
                }).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                await LogAsync("courier.completion.retry_pending", new
                {
                    session_id = completion.SessionId,
                    job_id = completion.JobId,
                    error = ex.Message,
                    type = ex.GetType().FullName
                }).ConfigureAwait(false);
            }
            return true;
        }

        private async Task<OperatorCourierFinalExecutionAuthorization> RequestFinalExecutionAuthorizationAsync(
            OperatorCourierCertificationEnvelopeValidationResult claimed,
            string sessionId,
            string jobId,
            string authorizationStage,
            CancellationToken cancellationToken)
        {
            if (!OperatorCourierFinalExecutionAuthorizationBinder.IsTargetExecutorBound(claimed, _executorId))
            {
                throw new OperatorCourierCertificationException(
                    "CERTIFICATION_FINAL_TARGET_EXECUTOR_MISMATCH",
                    "Certified v2 courier job target_executor_id does not exactly match this Revit executor; no Revit action was executed.");
            }

            string authorizationJson;
            try
            {
                var effectiveAuthorizationStage = claimed.Envelope?.RequestFamilyAdmission == null
                    ? null
                    : authorizationStage;
                authorizationJson = await _backendClient.AuthorizeRevitCourierExecutionJsonAsync(
                    sessionId,
                    jobId,
                    _executorId,
                    effectiveAuthorizationStage,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception error) when (!(error is OperatorCourierCertificationException))
            {
                throw new OperatorCourierCertificationException(
                    "CERTIFICATION_FINAL_EXECUTION_UNAVAILABLE",
                    "Fresh certified courier execution authorization was unavailable; no Revit action was executed.",
                    error);
            }

            var binding = OperatorCourierFinalExecutionAuthorizationBinder.Bind(
                authorizationJson,
                claimed,
                _executorId,
                DateTimeOffset.UtcNow,
                authorizationStage);
            if (!binding.IsValid || binding.Authorization == null)
            {
                throw new OperatorCourierCertificationException(
                    binding.Code,
                    "Certified courier execution authorization was rejected: " + binding.Error);
            }
            return binding.Authorization;
        }

        private static OperatorActionCall CreateCertifiedAction(
            OperatorCourierCertificationEnvelopeValidationResult claimed,
            OperatorCourierFinalExecutionAuthorization authorization,
            string localExecutorId)
        {
            if (claimed == null || !claimed.IsValid || claimed.Job == null)
                throw new OperatorCourierCertificationException("CERTIFICATION_FINAL_CLAIM_INVALID", "Certified courier claim was unavailable while building the local action.");
            if (!OperatorCourierFinalExecutionAuthorizationBinder.IsTargetExecutorBound(claimed, localExecutorId)
                || !OperatorCourierFinalExecutionAuthorizationBinder.IsBoundToExecutor(authorization, localExecutorId))
            {
                throw new OperatorCourierCertificationException(
                    "CERTIFICATION_FINAL_TARGET_EXECUTOR_MISMATCH",
                    "Certified courier final execution authorization is not pinned to this Revit executor.");
            }
            if (!OperatorCourierFinalExecutionAuthorizationBinder.IsCurrent(authorization, DateTimeOffset.UtcNow))
                throw new OperatorCourierCertificationException("CERTIFICATION_FINAL_EXECUTION_EXPIRED", "Certified courier execution authorization expired before local action construction.");

            return new OperatorActionCall
            {
                ActionId = claimed.Job.Id,
                CorrelationId = claimed.Job.CorrelationId,
                // Only the final authorization receipt supplies executable
                // method/path/body. The legacy/display v2 job body is never
                // deserialized or attached to this action.
                Method = authorization.Method,
                Path = authorization.Path,
                Body = authorization.BodyPresent && authorization.ParsedBody.HasValue
                    ? authorization.ParsedBody.Value
                    : null,
                ExpectedDocumentTitle = authorization.TargetDocumentTitle ?? "",
                ExpectedDocumentPath = authorization.TargetDocumentPath ?? "",
                CourierFinalExecutionAuthorization = authorization,
                CourierJobExpiresAtUtc = claimed.Job.ExpiresAtUtc,
                CourierVerifiedClaim = claimed,
                CourierLocalExecutorId = localExecutorId
            };
        }

        private async Task LogAsync(string kind, object payload)
        {
            try
            {
                var logger = _getLogger();
                if (logger != null) await logger.LogAsync(kind, payload, CancellationToken.None).ConfigureAwait(false);
            }
            catch
            {
                // Courier telemetry must never stop execution.
            }
        }

        private static string ReadRequiredString(JsonElement obj, string name, int maxLength)
        {
            if (!obj.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
                throw new InvalidOperationException("Revit courier job is missing " + name + ".");
            var text = (value.GetString() ?? "").Trim();
            if (string.IsNullOrWhiteSpace(text) || text.Length > maxLength)
                throw new InvalidOperationException("Revit courier job has invalid " + name + ".");
            return text;
        }

        private static string ReadOptionalString(JsonElement obj, string name, int maxLength)
        {
            if (!obj.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return "";
            if (value.ValueKind != JsonValueKind.String) throw new InvalidOperationException("Revit courier job has invalid " + name + ".");
            var text = (value.GetString() ?? "").Trim();
            if (text.Length > maxLength) throw new InvalidOperationException("Revit courier job has invalid " + name + ".");
            return text;
        }

        private static void TryReadFailureIdentity(JsonElement job, ref string? sessionId, ref string? jobId)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(jobId)) jobId = ReadRequiredString(job, "id", 200);
                if (string.IsNullOrWhiteSpace(sessionId)) sessionId = ReadRequiredString(job, "session_id", 200);
            }
            catch
            {
                // A malformed claim without a bounded identity cannot be
                // completed remotely, but it still cannot reach Revit.
            }
        }

        private sealed class OperatorCourierApprovalException : InvalidOperationException, IOperatorRevitFailureMetadata
        {
            public OperatorCourierApprovalException(string message) : base(message) { }
            public string Code => "revit_courier_approval_required";
            public bool Retryable => true;
            public string Phase => "approval";
            public string HostHealth => "healthy";
            public bool OpensCircuit => false;
            public bool OutcomeUnknown => false;
        }

        private sealed class OperatorCourierJobExpiredException : TimeoutException, IOperatorRevitFailureMetadata
        {
            public OperatorCourierJobExpiredException(string message) : base(message) { }
            public string Code => "revit_courier_job_expired_before_execution";
            public bool Retryable => true;
            public string Phase => "courier_claim";
            public string HostHealth => "healthy";
            public bool OpensCircuit => false;
            public bool OutcomeUnknown => false;
        }

        private sealed class OperatorCourierCertificationException : InvalidOperationException, IOperatorRevitFailureMetadata
        {
            public OperatorCourierCertificationException(string code, string message, Exception? inner = null)
                : base(message, inner)
            {
                Code = string.IsNullOrWhiteSpace(code) ? "CERTIFICATION_FINAL_EXECUTION_INVALID" : code;
            }

            public string Code { get; }
            public bool Retryable => false;
            public string Phase => "certification_final_execution";
            public string HostHealth => "healthy";
            public bool OpensCircuit => false;
            public bool OutcomeUnknown => false;
        }
    }
}

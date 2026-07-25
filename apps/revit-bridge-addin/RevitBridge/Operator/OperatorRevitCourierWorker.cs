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
        private readonly string _executorId = Environment.MachineName + "-revit-courier-" + Process.GetCurrentProcess().Id;
        private readonly SemaphoreSlim _runGate = new SemaphoreSlim(1, 1);
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
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

                jobId = ReadRequiredString(job, "id", 200);
                var version = ReadRequiredString(job, "version", 100);
                if (!string.Equals(version, "revit-operator.revit-tool-job.v1", StringComparison.Ordinal))
                    throw new InvalidOperationException("Unsupported Revit courier job version.");
                var jobSessionId = ReadRequiredString(job, "session_id", 200);
                sessionId = jobSessionId;
                correlationId = ReadRequiredString(job, "correlation_id", 160);
                if (!OperatorCorrelationId.IsValid(correlationId) || !string.Equals(correlationId, jobId, StringComparison.Ordinal))
                    throw new InvalidOperationException("Revit courier job has an invalid or mismatched correlation_id.");
                var method = ReadRequiredString(job, "method", 10).ToUpperInvariant();
                var path = ReadRequiredString(job, "path", 300);
                var expiresText = ReadRequiredString(job, "expires_at", 100);
                if (!DateTime.TryParse(expiresText, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var expiresAt))
                    throw new InvalidOperationException("Revit courier job has invalid expires_at.");
                object? body = null;
                if (job.TryGetProperty("body", out var bodyElement) && bodyElement.ValueKind != JsonValueKind.Null)
                    body = bodyElement.Clone();

                var action = new OperatorActionCall
                {
                    ActionId = jobId,
                    CorrelationId = correlationId,
                    Method = method,
                    Path = path,
                    Body = body
                };
                var risk = OperatorApprovalPolicy.GetRisk(method, path);
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
                var remaining = expiresAt.ToUniversalTime() - DateTime.UtcNow - TimeSpan.FromSeconds(2);
                if (remaining <= TimeSpan.Zero) throw new OperatorCourierJobExpiredException("The Revit courier job expired before local execution started.");
                var deadline = OperatorActionDeadlinePolicy.Resolve(method, path, risk.ToString()).ConstrainTo(remaining);
                actionTimeout.CancelAfter(deadline.Budget);
                var startedAt = DateTime.UtcNow;
                object? result;
                try
                {
                    result = await _actionRunner.ExecuteAsync(action, actionTimeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!_cts.IsCancellationRequested)
                {
                    throw deadline.CreateTimeoutException(correlationId);
                }
                executionCompleted = true;
                _completionOutbox.Save(sessionId!, jobId, _executorId, result);
                await _backendClient.CompleteRevitCourierJobJsonAsync(sessionId!, jobId, _executorId, result, CancellationToken.None).ConfigureAwait(false);
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
                    duration_ms = (int)Math.Max(0, (DateTime.UtcNow - startedAt).TotalMilliseconds)
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
                await _backendClient.CompleteRevitCourierJobJsonAsync(
                    completion.SessionId,
                    completion.JobId,
                    completion.ExecutorId,
                    completion.Result,
                    CancellationToken.None).ConfigureAwait(false);
                _completionOutbox.Acknowledge(completion.JobId);
                await LogAsync("courier.completion.replayed", new
                {
                    session_id = completion.SessionId,
                    job_id = completion.JobId,
                    completed_at = completion.CompletedAt
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
    }
}

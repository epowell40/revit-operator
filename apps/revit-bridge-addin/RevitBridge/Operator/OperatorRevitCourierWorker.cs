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
            var executionCompleted = false;
            try
            {
                // A completed Revit action must be acknowledged before this worker accepts more work.
                // This replays durable completion evidence after a transient backend outage or pane/Revit restart.
                if (await FlushOnePendingCompletionAsync().ConfigureAwait(false)) return;

                var claimJson = await _backendClient.ClaimNextRevitCourierJobJsonAsync(null, _executorId, _cts.Token).ConfigureAwait(false);
                using var claimDocument = JsonDocument.Parse(string.IsNullOrWhiteSpace(claimJson) ? "{}" : claimJson);
                if (!claimDocument.RootElement.TryGetProperty("job", out var job) || job.ValueKind != JsonValueKind.Object) return;

                jobId = ReadRequiredString(job, "id", 200);
                var version = ReadRequiredString(job, "version", 100);
                if (!string.Equals(version, "revit-operator.revit-tool-job.v1", StringComparison.Ordinal))
                    throw new InvalidOperationException("Unsupported Revit courier job version.");
                var jobSessionId = ReadRequiredString(job, "session_id", 200);
                sessionId = jobSessionId;
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
                if (remaining <= TimeSpan.Zero) throw new TimeoutException("The Revit courier job expired before local execution started.");
                var localBudget = remaining < TimeSpan.FromSeconds(210) ? remaining : TimeSpan.FromSeconds(210);
                actionTimeout.CancelAfter(localBudget);
                var startedAt = DateTime.UtcNow;
                object? result;
                try
                {
                    result = await _actionRunner.ExecuteAsync(action, actionTimeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!_cts.IsCancellationRequested)
                {
                    throw new TimeoutException("The Revit action exceeded the courier job's local execution deadline.");
                }
                executionCompleted = true;
                _completionOutbox.Save(sessionId!, jobId, _executorId, result);
                await _backendClient.CompleteRevitCourierJobJsonAsync(sessionId!, jobId, _executorId, result, CancellationToken.None).ConfigureAwait(false);
                _completionOutbox.Acknowledge(jobId);
                await LogAsync("courier.action.done", new
                {
                    session_id = sessionId,
                    job_id = jobId,
                    method,
                    path,
                    risk = risk.ToString(),
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
                        error = ex.Message,
                        type = ex.GetType().FullName
                    }).ConfigureAwait(false);
                }
                else if (!string.IsNullOrWhiteSpace(sessionId) && !string.IsNullOrWhiteSpace(jobId))
                {
                    try
                    {
                        var retryable = ex is OperatorCourierApprovalException ||
                                        ex is TimeoutException ||
                                        ex.Message.IndexOf("busy", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                        ex.Message.IndexOf("retry", StringComparison.OrdinalIgnoreCase) >= 0;
                        await _backendClient.FailRevitCourierJobJsonAsync(
                            sessionId!,
                            jobId!,
                            _executorId,
                            ex.Message,
                            new { error = ex.Message, type = ex.GetType().FullName },
                            retryable,
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

        private sealed class OperatorCourierApprovalException : InvalidOperationException
        {
            public OperatorCourierApprovalException(string message) : base(message) { }
        }
    }
}

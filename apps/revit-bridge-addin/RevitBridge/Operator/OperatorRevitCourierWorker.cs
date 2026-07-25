using System;
using System.Diagnostics;
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
            try
            {
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
                actionTimeout.CancelAfter(TimeSpan.FromSeconds(210));
                var startedAt = DateTime.UtcNow;
                var result = await _actionRunner.ExecuteAsync(action, actionTimeout.Token).ConfigureAwait(false);
                await _backendClient.CompleteRevitCourierJobJsonAsync(sessionId!, jobId, _executorId, result, _cts.Token).ConfigureAwait(false);
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
                if (!string.IsNullOrWhiteSpace(sessionId) && !string.IsNullOrWhiteSpace(jobId))
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
                await LogAsync("courier.action.failed", new
                {
                    session_id = sessionId,
                    job_id = jobId,
                    error = ex.Message,
                    type = ex.GetType().FullName
                }).ConfigureAwait(false);
            }
            finally
            {
                try { _runGate.Release(); } catch { }
            }
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

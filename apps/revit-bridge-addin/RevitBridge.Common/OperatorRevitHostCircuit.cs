using System;
using System.Text.Json.Serialization;

namespace RevitBridge.Common
{
    public interface IOperatorRevitFailureMetadata
    {
        string Code { get; }
        bool Retryable { get; }
        string Phase { get; }
        string HostHealth { get; }
        bool OpensCircuit { get; }
        bool OutcomeUnknown { get; }
    }

    public sealed class OperatorCourierFailureReceipt
    {
        public bool Ok { get; set; }
        public string Error { get; set; } = "";
        public string Code { get; set; } = "revit_action_failed";
        public bool Retryable { get; set; }
        public string Phase { get; set; } = "revit_execution";
        public string HostHealth { get; set; } = "degraded";
        public bool OpensCircuit { get; set; }
        public bool OutcomeUnknown { get; set; }
        public string? CorrelationId { get; set; }
        public string? ExceptionType { get; set; }
        public string? DeadlineClass { get; set; }
        public int? DeadlineMs { get; set; }
        public string? UserErrorCode { get; set; }
        public string? RequiredConfirm { get; set; }
        public string? ConfirmReceived { get; set; }
        public int? MaxChangesPerCall { get; set; }
        public string? Hint { get; set; }
        [JsonPropertyName("canonical_attempt_settlement")]
        public OperatorAttemptSettlement? AttemptSettlement { get; set; }
    }

    public static class OperatorCourierFailureClassifier
    {
        public static OperatorCourierFailureReceipt Classify(Exception error, string? correlationId = null)
        {
            var root = Unwrap(error);
            if (string.IsNullOrWhiteSpace(correlationId) && root is IOperatorCorrelationMetadata correlationMetadata)
                correlationId = correlationMetadata.CorrelationId;
            if (root is IOperatorRevitFailureMetadata metadata)
            {
                return Create(root, metadata.Code, metadata.Retryable, metadata.Phase,
                    metadata.HostHealth, metadata.OpensCircuit, metadata.OutcomeUnknown, correlationId);
            }

            if (root is OperatorToolUserErrorException userError)
            {
                var receipt = Create(root,
                    string.IsNullOrWhiteSpace(userError.Code) ? "revit_action_rejected" : userError.Code,
                    retryable: false,
                    phase: "revit_validation",
                    hostHealth: "healthy",
                    opensCircuit: false,
                    outcomeUnknown: false,
                    correlationId: correlationId);
                receipt.UserErrorCode = string.IsNullOrWhiteSpace(userError.Code) ? null : userError.Code;
                receipt.RequiredConfirm = userError.RequiredConfirm;
                receipt.ConfirmReceived = userError.ConfirmReceived;
                receipt.MaxChangesPerCall = userError.MaxChangesPerCall;
                receipt.Hint = userError.Hint;
                return receipt;
            }

            if (root is TimeoutException)
            {
                return Create(root,
                    "revit_action_deadline_elapsed_outcome_unknown",
                    retryable: false,
                    phase: "revit_external_event",
                    hostHealth: "unavailable",
                    opensCircuit: true,
                    outcomeUnknown: true,
                    correlationId: correlationId);
            }

            if (root is OperationCanceledException)
            {
                return Create(root,
                    "revit_action_canceled",
                    retryable: false,
                    phase: "revit_execution",
                    hostHealth: "degraded",
                    opensCircuit: false,
                    outcomeUnknown: false,
                    correlationId: correlationId);
            }

            return Create(root,
                "revit_action_failed",
                retryable: false,
                phase: "revit_execution",
                hostHealth: "degraded",
                opensCircuit: false,
                outcomeUnknown: false,
                correlationId: correlationId);
        }

        private static OperatorCourierFailureReceipt Create(
            Exception error,
            string code,
            bool retryable,
            string phase,
            string hostHealth,
            bool opensCircuit,
            bool outcomeUnknown,
            string? correlationId)
        {
            var receipt = new OperatorCourierFailureReceipt
            {
                Ok = false,
                Error = error.Message,
                Code = code,
                Retryable = retryable,
                Phase = phase,
                HostHealth = hostHealth,
                OpensCircuit = opensCircuit,
                OutcomeUnknown = outcomeUnknown,
                CorrelationId = string.IsNullOrWhiteSpace(correlationId) ? null : correlationId,
                ExceptionType = error.GetType().FullName
            };
            if (error is IOperatorActionDeadlineMetadata deadlineMetadata)
            {
                receipt.DeadlineClass = deadlineMetadata.DeadlineClass;
                receipt.DeadlineMs = deadlineMetadata.DeadlineMs;
            }
            return receipt;
        }

        private static Exception Unwrap(Exception error)
        {
            if (error is AggregateException aggregate)
            {
                var flattened = aggregate.Flatten();
                if (flattened.InnerExceptions.Count == 1) return Unwrap(flattened.InnerExceptions[0]);
            }
            return error;
        }
    }

    public sealed class OperatorRevitHostCircuitSnapshot
    {
        public bool Open { get; set; }
        public string HostHealth { get; set; } = "healthy";
        public string? ReasonCode { get; set; }
        public int ConsecutiveFailures { get; set; }
        public DateTimeOffset? OpenedAt { get; set; }
        public DateTimeOffset? ProbeAfter { get; set; }
        public bool ProbeInFlight { get; set; }
    }

    public sealed class OperatorRevitHostCircuit
    {
        private readonly object _gate = new object();
        private readonly TimeSpan _minimumDelay;
        private readonly TimeSpan _maximumDelay;
        private bool _open;
        private bool _probeInFlight;
        private string? _reasonCode;
        private int _consecutiveFailures;
        private DateTimeOffset? _openedAt;
        private DateTimeOffset? _probeAfter;

        public OperatorRevitHostCircuit(TimeSpan? minimumDelay = null, TimeSpan? maximumDelay = null)
        {
            _minimumDelay = minimumDelay ?? TimeSpan.FromSeconds(2);
            _maximumDelay = maximumDelay ?? TimeSpan.FromSeconds(30);
            if (_minimumDelay <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(minimumDelay));
            if (_maximumDelay < _minimumDelay) throw new ArgumentOutOfRangeException(nameof(maximumDelay));
        }

        public void Open(string reasonCode, DateTimeOffset now)
        {
            lock (_gate)
            {
                OpenLocked(reasonCode, now);
            }
        }

        public bool TryBeginProbe(DateTimeOffset now)
        {
            lock (_gate)
            {
                if (!_open || _probeInFlight || !_probeAfter.HasValue || now < _probeAfter.Value) return false;
                _probeInFlight = true;
                return true;
            }
        }

        public void RecordProbeSuccess()
        {
            lock (_gate)
            {
                _open = false;
                _probeInFlight = false;
                _reasonCode = null;
                _consecutiveFailures = 0;
                _openedAt = null;
                _probeAfter = null;
            }
        }

        public void RecordProbeFailure(string reasonCode, DateTimeOffset now)
        {
            lock (_gate)
            {
                _probeInFlight = false;
                OpenLocked(reasonCode, now);
            }
        }

        public OperatorRevitHostCircuitSnapshot Snapshot()
        {
            lock (_gate)
            {
                return new OperatorRevitHostCircuitSnapshot
                {
                    Open = _open,
                    HostHealth = _open ? "unavailable" : "healthy",
                    ReasonCode = _reasonCode,
                    ConsecutiveFailures = _consecutiveFailures,
                    OpenedAt = _openedAt,
                    ProbeAfter = _probeAfter,
                    ProbeInFlight = _probeInFlight
                };
            }
        }

        private void OpenLocked(string reasonCode, DateTimeOffset now)
        {
            if (!_open)
            {
                _open = true;
                _openedAt = now;
                _consecutiveFailures = 0;
            }
            _reasonCode = string.IsNullOrWhiteSpace(reasonCode) ? "revit_host_unavailable" : reasonCode.Trim();
            _consecutiveFailures = Math.Min(30, _consecutiveFailures + 1);
            _probeInFlight = false;
            var multiplier = Math.Pow(2, Math.Min(10, _consecutiveFailures - 1));
            var delayMs = Math.Min(_maximumDelay.TotalMilliseconds, _minimumDelay.TotalMilliseconds * multiplier);
            _probeAfter = now.AddMilliseconds(delayMs);
        }
    }
}

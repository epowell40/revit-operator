using System;
using System.Diagnostics;

namespace RevitBridge.Common
{
    // Observability only. No Revit access, wake-up, lease renewal or scheduling.
    public sealed class OperatorIdleDiagnostic
    {
        private readonly object _gate = new object();
        private readonly Func<long> _milliseconds;
        private long? _enteredAt;
        private long? _lastDuration;
        private bool _inCallback, _uiSender, _pending, _lease;
        public OperatorIdleDiagnostic() : this(() => (long)(Stopwatch.GetTimestamp() * (1000.0 / Stopwatch.Frequency))) { }
        public OperatorIdleDiagnostic(Func<long> milliseconds) => _milliseconds = milliseconds ?? throw new ArgumentNullException(nameof(milliseconds));
        public void Enter(bool uiSender, bool pending, bool lease)
        {
            lock (_gate) { _enteredAt = _milliseconds(); _inCallback = true; _uiSender = uiSender; _pending = pending; _lease = lease; }
        }
        public void Exit()
        {
            lock (_gate) { if (_enteredAt.HasValue) _lastDuration = Math.Max(0, _milliseconds() - _enteredAt.Value); _inCallback = false; }
        }
        public string Describe()
        {
            lock (_gate)
            {
                var age = _enteredAt.HasValue ? Math.Max(0, _milliseconds() - _enteredAt.Value).ToString() : "none";
                return $"idle_age_ms={age} idle_in_callback={_inCallback} idle_last_duration_ms={_lastDuration?.ToString() ?? "none"} idle_ui_sender={_uiSender} idle_pending={_pending} idle_lease={_lease}";
            }
        }
    }
}

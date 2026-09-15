using System;
using System.Diagnostics;
using System.Threading;

namespace RevitBridge.Common
{
    // Retain a supported Revit idle session briefly between agent operations.
    // Never starts API work, waits on the UI thread, or renews itself on Idling.
    public sealed class OperatorActiveIdleLease
    {
        private readonly Func<long> _milliseconds;
        private readonly int _durationMilliseconds;
        private long _expiresAt = long.MinValue;
        private int _stopped;

        public OperatorActiveIdleLease()
            : this(() => (long)(Stopwatch.GetTimestamp() * (1000.0 / Stopwatch.Frequency)), 30_000) { }

        public OperatorActiveIdleLease(Func<long> milliseconds, int durationMilliseconds)
        {
            _milliseconds = milliseconds ?? throw new ArgumentNullException(nameof(milliseconds));
            if (durationMilliseconds <= 0 || durationMilliseconds > 60_000)
                throw new ArgumentOutOfRangeException(nameof(durationMilliseconds));
            _durationMilliseconds = durationMilliseconds;
        }

        public bool IsActive => Volatile.Read(ref _stopped) == 0 && _milliseconds() < Interlocked.Read(ref _expiresAt);

        public void RecordActivity()
        {
            if (Volatile.Read(ref _stopped) == 0)
                Interlocked.Exchange(ref _expiresAt, checked(_milliseconds() + _durationMilliseconds));
        }

        public void Stop() => Interlocked.Exchange(ref _stopped, 1);
    }
}

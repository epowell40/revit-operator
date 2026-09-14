using System;
using System.Threading;

namespace RevitBridge.Common
{
    // A UI message-pump signal, never an Autodesk API execution context. Model
    // actions remain owned by ExternalEvent/Idling. At most one callback waits
    // in the dispatcher, including while Revit is busy or showing a dialog.
    public sealed class OperatorUiWakeScheduler
    {
        private readonly Action<Action> _post;
        private readonly Func<bool> _hasPendingWork;
        private readonly Action _wake;
        private readonly Action<Exception>? _onError;
        private int _queued;
        private int _stopped;

        public OperatorUiWakeScheduler(Action<Action> post, Func<bool> hasPendingWork, Action wake, Action<Exception>? onError = null)
        {
            _post = post ?? throw new ArgumentNullException(nameof(post));
            _hasPendingWork = hasPendingWork ?? throw new ArgumentNullException(nameof(hasPendingWork));
            _wake = wake ?? throw new ArgumentNullException(nameof(wake));
            _onError = onError;
        }

        public bool Request()
        {
            if (Volatile.Read(ref _stopped) != 0 || !_hasPendingWork()) return false;
            if (Interlocked.CompareExchange(ref _queued, 1, 0) != 0) return false;
            try
            {
                _post(() =>
                {
                    try
                    {
                        if (Volatile.Read(ref _stopped) == 0 && _hasPendingWork()) _wake();
                    }
                    catch (Exception error)
                    {
                        // A best-effort wake must never fault the host UI loop.
                        try { _onError?.Invoke(error); } catch { }
                    }
                    finally { Interlocked.Exchange(ref _queued, 0); }
                });
                return true;
            }
            catch
            {
                Interlocked.Exchange(ref _queued, 0);
                throw;
            }
        }

        public void Stop() => Interlocked.Exchange(ref _stopped, 1);
    }
}

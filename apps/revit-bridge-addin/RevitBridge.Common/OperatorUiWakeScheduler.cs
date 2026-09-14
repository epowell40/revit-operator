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
        private readonly Action? _wakeMessageLoop;
        private int _queued;
        private int _stopped;

        public OperatorUiWakeScheduler(Action<Action> post, Func<bool> hasPendingWork, Action wake, Action<Exception>? onError = null, Action? wakeMessageLoop = null)
        {
            _post = post ?? throw new ArgumentNullException(nameof(post));
            _hasPendingWork = hasPendingWork ?? throw new ArgumentNullException(nameof(hasPendingWork));
            _wake = wake ?? throw new ArgumentNullException(nameof(wake));
            _onError = onError;
            _wakeMessageLoop = wakeMessageLoop;
        }

        public bool Request()
        {
            if (Volatile.Read(ref _stopped) != 0 || !_hasPendingWork()) return false;
            var ownsSlot = Interlocked.CompareExchange(ref _queued, 1, 0) == 0;
            try
            {
                if (!ownsSlot) return false;
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
            finally
            {
                // WPF can service the dispatcher while the native host remains
                // outside its idle cycle. A separate command-free message is
                // also needed while a dispatcher callback is already queued.
                if (Volatile.Read(ref _stopped) == 0 && _hasPendingWork())
                {
                    try { _wakeMessageLoop?.Invoke(); }
                    catch (Exception error) { try { _onError?.Invoke(error); } catch { } }
                }
            }
        }

        public void Stop() => Interlocked.Exchange(ref _stopped, 1);
    }
}

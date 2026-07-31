using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Operator
{
    [Transaction(TransactionMode.Manual)]
    public class ShowOperatorPaneCommand : IExternalCommand
    {
        private static readonly object DelayedFailureReporterSync = new object();
        private static OperatorDesktopDelayedFailureDialog? DelayedFailureDialog;

        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            if (OperatorDesktopLauncher.UseLegacyPane())
            {
                var pane = commandData.Application.GetDockablePane(OperatorPaneIds.PaneId);
                pane?.Show();
                return Result.Succeeded;
            }

            var delayedFailureReporter = GetDelayedFailureReporter();
            if (!OperatorDesktopLauncher.TryLaunch(delayedFailureReporter, out var detail))
            {
                TaskDialog.Show(
                    "Revit Operator",
                    "Operator Desktop could not be launched.\n\n" + detail
                    + "\n\nRun Operator Desktop from the workstation package, or set OPERATOR_UI_MODE=pane and restart Revit to use the legacy pane.");
                return Result.Cancelled;
            }

            return Result.Succeeded;
        }

        private static Func<string, Action, bool>? GetDelayedFailureReporter()
        {
            lock (DelayedFailureReporterSync)
            {
                if (DelayedFailureDialog != null) return DelayedFailureDialog.TryReport;
                try
                {
                    var handler = new OperatorDesktopDelayedFailureDialog();
                    handler.Attach(ExternalEvent.Create(handler));
                    DelayedFailureDialog = handler;
                    return handler.TryReport;
                }
                catch
                {
                    // The durable receipt remains the fallback and will be surfaced by the
                    // next invocation if Revit cannot create a notification ExternalEvent.
                    return null;
                }
            }
        }
    }

    internal sealed class OperatorDesktopDelayedFailureDialog : IExternalEventHandler
    {
        private readonly ConcurrentQueue<Notification> _notifications = new ConcurrentQueue<Notification>();
        private ExternalEvent? _externalEvent;

        public void Attach(ExternalEvent externalEvent)
        {
            _externalEvent = externalEvent ?? throw new ArgumentNullException(nameof(externalEvent));
        }

        public bool TryReport(string failure, Action persistFallback)
        {
            var externalEvent = _externalEvent;
            if (externalEvent == null) return false;
            var notification = new Notification(failure, persistFallback);
            _notifications.Enqueue(notification);
            try
            {
                var request = externalEvent.Raise();
                if (request == ExternalEventRequest.Accepted) return true;
                if (request == ExternalEventRequest.Pending)
                {
                    _ = RetryPendingRaiseAsync(notification);
                    return true;
                }
            }
            catch
            {
                // The launcher persists the receipt when this reporter returns false.
            }

            notification.CancelWithoutFallback();
            return false;
        }

        private async Task RetryPendingRaiseAsync(Notification notification)
        {
            var externalEvent = _externalEvent;
            if (externalEvent == null)
            {
                notification.CancelAndPersistFallback();
                return;
            }

            for (var attempt = 0; attempt < 4 && notification.IsPending; attempt++)
            {
                await Task.Delay(25 * (attempt + 1)).ConfigureAwait(false);
                if (!notification.IsPending) return;
                try
                {
                    var request = externalEvent.Raise();
                    if (request == ExternalEventRequest.Accepted) return;
                    if (request == ExternalEventRequest.Denied) break;
                    if (request == ExternalEventRequest.TimedOut && attempt == 3) break;
                }
                catch
                {
                    break;
                }
            }

            notification.CancelAndPersistFallback();
        }

        public void Execute(UIApplication app)
        {
            while (_notifications.TryDequeue(out var notification))
            {
                if (!notification.TryBeginDisplay()) continue;
                try
                {
                    TaskDialog.Show(
                        "Revit Operator",
                        "Operator Desktop could not finish launching.\n\n"
                        + notification.Failure
                        + "\n\nStart Operator Desktop from the Windows desktop or workstation package. If that also fails, reinstall the workstation package or set OPERATOR_DESKTOP_LAUNCHER_PATH and restart Revit.");
                }
                catch
                {
                    notification.PersistFallback();
                }
            }
        }

        public string GetName() => "Revit Operator Desktop launch failure notification";

        private sealed class Notification
        {
            private const int Pending = 0;
            private const int Displaying = 1;
            private const int Cancelled = 2;
            private readonly Action _persistFallback;
            private int _state;

            public Notification(string failure, Action persistFallback)
            {
                Failure = string.IsNullOrWhiteSpace(failure)
                    ? "The launcher failed without an error message."
                    : failure.Trim();
                _persistFallback = persistFallback ?? throw new ArgumentNullException(nameof(persistFallback));
            }

            public string Failure { get; }
            public bool IsPending => Volatile.Read(ref _state) == Pending;

            public bool TryBeginDisplay()
                => Interlocked.CompareExchange(ref _state, Displaying, Pending) == Pending;

            public void CancelWithoutFallback()
                => Interlocked.CompareExchange(ref _state, Cancelled, Pending);

            public void CancelAndPersistFallback()
            {
                if (Interlocked.CompareExchange(ref _state, Cancelled, Pending) == Pending)
                {
                    PersistFallback();
                }
            }

            public void PersistFallback() => _persistFallback();
        }
    }
}


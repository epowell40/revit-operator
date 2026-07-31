using System;
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

        internal static void ShutdownDesktopFailureNotifications()
        {
            try
            {
                OperatorDesktopLauncher.BeginShutdown();
            }
            finally
            {
                lock (DelayedFailureReporterSync)
                {
                    var dialog = DelayedFailureDialog;
                    DelayedFailureDialog = null;
                    try { dialog?.Shutdown(); } catch { }
                }
            }
        }

        private static Func<OperatorDesktopPersistedFailure, bool>? GetDelayedFailureReporter()
        {
            lock (DelayedFailureReporterSync)
            {
                if (DelayedFailureDialog != null) return DelayedFailureDialog.TryReport;
                try
                {
                    var handler = new OperatorDesktopDelayedFailureDialog(
                        new OperatorDesktopDelayedFailureBuffer(
                            OperatorDesktopLauncher.SharedFailureReceipts));
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
        private readonly OperatorDesktopDelayedFailureBuffer _buffer;
        private OperatorDesktopDelayedFailureDelivery? _delivery;

        public OperatorDesktopDelayedFailureDialog(OperatorDesktopDelayedFailureBuffer buffer)
        {
            _buffer = buffer ?? throw new ArgumentNullException(nameof(buffer));
        }

        public void Attach(ExternalEvent externalEvent)
        {
            if (_delivery != null) throw new InvalidOperationException("The Operator Desktop failure event is already attached.");
            if (externalEvent == null) throw new ArgumentNullException(nameof(externalEvent));
            _delivery = new OperatorDesktopDelayedFailureDelivery(
                _buffer,
                () => MapRaiseResult(externalEvent.Raise()),
                externalEvent.Dispose);
        }

        public bool TryReport(OperatorDesktopPersistedFailure failure)
        {
            var delivery = _delivery;
            if (delivery != null) return delivery.TryReport(failure);
            _buffer.TryEnqueue(failure);
            _buffer.FailPendingDelivery();
            return true;
        }

        public void Execute(UIApplication app)
        {
            _delivery?.Execute(message =>
            {
                TaskDialog.Show(
                    "Revit Operator",
                    "Operator Desktop could not finish launching.\n\n"
                    + message
                    + "\n\nStart Operator Desktop from the Windows desktop or workstation package. If that also fails, reinstall the workstation package or set OPERATOR_DESKTOP_LAUNCHER_PATH and restart Revit.");
                return true;
            });
        }

        public string GetName() => "Revit Operator Desktop launch failure notification";

        public void Shutdown()
        {
            var delivery = _delivery;
            _delivery = null;
            if (delivery != null) delivery.Dispose();
            else _buffer.Dispose();
        }

        private static OperatorDesktopDelayedFailureRaiseResult MapRaiseResult(ExternalEventRequest request)
        {
            switch (request)
            {
                case ExternalEventRequest.Accepted:
                    return OperatorDesktopDelayedFailureRaiseResult.Accepted;
                case ExternalEventRequest.Pending:
                    return OperatorDesktopDelayedFailureRaiseResult.Pending;
                case ExternalEventRequest.TimedOut:
                    return OperatorDesktopDelayedFailureRaiseResult.TimedOut;
                default:
                    return OperatorDesktopDelayedFailureRaiseResult.Denied;
            }
        }
    }
}


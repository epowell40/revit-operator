using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Services
{
    public sealed class RevitEventQueueException : InvalidOperationException, IOperatorRevitFailureMetadata
    {
        public RevitEventQueueException(string code, string message, bool retryable)
            : base(message)
        {
            Code = code;
            Retryable = retryable;
        }

        public string Code { get; }
        public bool Retryable { get; }
        public string Phase => "revit_external_event";
        public string HostHealth => string.Equals(Code, "revit_external_event_busy", StringComparison.OrdinalIgnoreCase)
            ? "degraded"
            : "unavailable";
        public bool OpensCircuit => !string.Equals(Code, "revit_external_event_busy", StringComparison.OrdinalIgnoreCase);
        public bool OutcomeUnknown => false;
    }

    public class RevitEventService : IExternalEventHandler
    {
        private sealed class QueueItem
        {
            public QueueItem(Func<UIApplication, object> action, TaskCompletionSource<object> completion, CancellationToken cancellationToken)
            {
                Action = action;
                Completion = completion;
                CancellationToken = cancellationToken;
            }

            public Func<UIApplication, object> Action { get; }
            public TaskCompletionSource<object> Completion { get; }
            public CancellationToken CancellationToken { get; }
            public int Started;
        }

        private readonly ConcurrentQueue<QueueItem> _queue = new ConcurrentQueue<QueueItem>();
        private readonly ExternalEvent _externalEvent;
        private int _inFlight;

        public RevitEventService()
        {
            _externalEvent = ExternalEvent.Create(this);
        }

        public Task<T> Run<T>(Func<UIApplication, T> action)
            => Run(action, CancellationToken.None);

        public Task<T> Run<T>(Func<UIApplication, T> action, CancellationToken cancellationToken)
        {
            var tcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            if (cancellationToken.IsCancellationRequested)
            {
                tcs.TrySetCanceled();
                return AwaitResult<T>(tcs.Task);
            }

            // Revit owns a single API thread. Reject concurrent work instead of building an
            // unbounded queue that can make Revit appear frozen after one slow operation.
            if (Interlocked.CompareExchange(ref _inFlight, 1, 0) != 0)
            {
                tcs.TrySetException(new RevitEventQueueException(
                    "revit_external_event_busy",
                    "Revit already has one Operator action in flight. Retry after that action completes.",
                    retryable: true));
                return AwaitResult<T>(tcs.Task);
            }

            if (cancellationToken.CanBeCanceled)
            {
                cancellationToken.Register(() => tcs.TrySetCanceled());
            }

            var item = new QueueItem(app => action(app), tcs, cancellationToken);
            _queue.Enqueue(item);
            ExternalEventRequest request;
            try
            {
                request = _externalEvent.Raise();
            }
            catch (Exception ex)
            {
                FailQueuedItem(item, new RevitEventQueueException(
                    "revit_external_event_raise_failed",
                    $"Revit rejected the Operator action before execution: {ex.Message}",
                    retryable: true));
                return AwaitResult<T>(tcs.Task);
            }

            if (request == ExternalEventRequest.Denied)
            {
                FailQueuedItem(item, new RevitEventQueueException(
                    "revit_external_event_denied",
                    "Revit denied the Operator external event because the event handler is unavailable or failed.",
                    retryable: false));
            }
            else if (request == ExternalEventRequest.TimedOut)
            {
                FailQueuedItem(item, new RevitEventQueueException(
                    "revit_external_event_raise_timed_out",
                    "Revit did not accept the Operator external event because host synchronization timed out.",
                    retryable: true));
            }
            else if (request == ExternalEventRequest.Pending)
            {
                // A narrow race is possible when a new request arrives as Execute is returning.
                // Retry the raise after Revit has left the current handler; never enqueue a
                // second action while this request is outstanding.
                _ = RetryPendingRaiseAsync(item);
            }
            return AwaitResult<T>(tcs.Task);
        }

        private async Task RetryPendingRaiseAsync(QueueItem item)
        {
            for (var attempt = 0; attempt < 4 && !item.Completion.Task.IsCompleted && Volatile.Read(ref item.Started) == 0; attempt++)
            {
                await Task.Delay(25 * (attempt + 1)).ConfigureAwait(false);
                if (item.Completion.Task.IsCompleted || Volatile.Read(ref item.Started) != 0) return;
                ExternalEventRequest request;
                try
                {
                    request = _externalEvent.Raise();
                }
                catch (Exception ex)
                {
                    FailQueuedItem(item, new RevitEventQueueException(
                        "revit_external_event_raise_failed",
                        $"Revit rejected the pending Operator action: {ex.Message}",
                        retryable: true));
                    return;
                }

                if (request == ExternalEventRequest.Accepted) return;
                if (request == ExternalEventRequest.Denied)
                {
                    FailQueuedItem(item, new RevitEventQueueException(
                        "revit_external_event_denied",
                        "Revit denied the pending Operator external event.",
                        retryable: false));
                    return;
                }
                if (request == ExternalEventRequest.TimedOut && attempt == 3)
                {
                    FailQueuedItem(item, new RevitEventQueueException(
                        "revit_external_event_raise_timed_out",
                        "Revit repeatedly failed to accept the pending Operator external event.",
                        retryable: true));
                    return;
                }
            }

            if (!item.Completion.Task.IsCompleted && Volatile.Read(ref item.Started) == 0)
            {
                FailQueuedItem(item, new RevitEventQueueException(
                    "revit_external_event_still_pending",
                    "Revit did not begin the pending Operator external event after bounded raise retries.",
                    retryable: true));
            }
        }

        private void FailQueuedItem(QueueItem expected, Exception error)
        {
            if (_queue.TryDequeue(out var item))
            {
                if (!ReferenceEquals(item, expected))
                {
                    _queue.Enqueue(item);
                    return;
                }
                item.Completion.TrySetException(error);
                Interlocked.Exchange(ref _inFlight, 0);
            }
        }

        private static async Task<T> AwaitResult<T>(Task<object> task)
        {
            return (T)await task.ConfigureAwait(false);
        }

        public void Execute(UIApplication app)
        {
            if (!_queue.TryDequeue(out var item))
            {
                Interlocked.Exchange(ref _inFlight, 0);
                return;
            }

            Interlocked.Exchange(ref item.Started, 1);

            try
            {
                if (item.CancellationToken.IsCancellationRequested || item.Completion.Task.IsCompleted)
                {
                    item.Completion.TrySetCanceled();
                    return;
                }

                var result = item.Action(app);
                item.Completion.TrySetResult(result);
            }
            catch (Exception ex)
            {
                item.Completion.TrySetException(ex);
            }
            finally
            {
                Interlocked.Exchange(ref _inFlight, 0);
            }
        }

        public string GetName()
        {
            return "Revit Operator Event Handler";
        }
    }
}

using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Services
{
    public sealed class RevitEventQueueException : InvalidOperationException, IOperatorRevitFailureMetadata, IOperatorCorrelationMetadata
    {
        public RevitEventQueueException(string code, string message, bool retryable, string? correlationId = null)
            : base(message)
        {
            Code = code;
            Retryable = retryable;
            CorrelationId = OperatorCorrelationId.IsValid(correlationId) ? correlationId!.Trim() : null;
        }

        public string Code { get; }
        public bool Retryable { get; }
        public string Phase => "revit_external_event";
        public string HostHealth => string.Equals(Code, "revit_external_event_busy", StringComparison.OrdinalIgnoreCase)
            ? "degraded"
            : "unavailable";
        public bool OpensCircuit => !string.Equals(Code, "revit_external_event_busy", StringComparison.OrdinalIgnoreCase);
        public bool OutcomeUnknown => false;
        public string? CorrelationId { get; }
    }

    public class RevitEventService : IExternalEventHandler
    {
        private sealed class QueueItem
        {
            public const int Pending = 0;
            public const int Started = 1;
            public const int CancelledBeforeStart = 2;

            public QueueItem(Func<UIApplication, object> action, TaskCompletionSource<object> completion, CancellationToken cancellationToken, string? correlationId)
            {
                Action = action;
                Completion = completion;
                CancellationToken = cancellationToken;
                CorrelationId = correlationId;
            }

            public Func<UIApplication, object> Action { get; }
            public TaskCompletionSource<object> Completion { get; }
            public CancellationToken CancellationToken { get; }
            public string? CorrelationId { get; }
            public int ExecutionState;
        }

        private readonly ConcurrentQueue<QueueItem> _queue = new ConcurrentQueue<QueueItem>();
        private readonly ExternalEvent _externalEvent;
        private int _inFlight;

        public RevitEventService()
        {
            _externalEvent = ExternalEvent.Create(this);
        }

        public Task<T> Run<T>(Func<UIApplication, T> action)
            => Run(action, CancellationToken.None, null);

        public Task<T> Run<T>(Func<UIApplication, T> action, CancellationToken cancellationToken)
            => Run(action, cancellationToken, null);

        public Task<T> Run<T>(Func<UIApplication, T> action, CancellationToken cancellationToken, string? correlationId)
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
                    retryable: true,
                    correlationId));
                return AwaitResult<T>(tcs.Task);
            }

            var item = new QueueItem(app => action(app), tcs, cancellationToken, correlationId);
            _queue.Enqueue(item);
            if (cancellationToken.CanBeCanceled)
            {
                // A cancellation that wins before Execute must remove the pending item and
                // release the single-flight slot. Merely cancelling the Task leaves the item
                // in the queue and can make every later Operator action report busy forever.
                cancellationToken.Register(() => CancelQueuedItem(item));
            }
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
                    retryable: true,
                    item.CorrelationId));
                return AwaitResult<T>(tcs.Task);
            }

            if (request == ExternalEventRequest.Denied)
            {
                FailQueuedItem(item, new RevitEventQueueException(
                    "revit_external_event_denied",
                    "Revit denied the Operator external event because the event handler is unavailable or failed.",
                    retryable: false,
                    item.CorrelationId));
            }
            else if (request == ExternalEventRequest.TimedOut)
            {
                FailQueuedItem(item, new RevitEventQueueException(
                    "revit_external_event_raise_timed_out",
                    "Revit did not accept the Operator external event because host synchronization timed out.",
                    retryable: true,
                    item.CorrelationId));
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
            for (var attempt = 0; attempt < 4 && !item.Completion.Task.IsCompleted && Volatile.Read(ref item.ExecutionState) == QueueItem.Pending; attempt++)
            {
                await Task.Delay(25 * (attempt + 1)).ConfigureAwait(false);
                if (item.Completion.Task.IsCompleted || Volatile.Read(ref item.ExecutionState) != QueueItem.Pending) return;
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
                        retryable: true,
                        item.CorrelationId));
                    return;
                }

                if (request == ExternalEventRequest.Accepted) return;
                if (request == ExternalEventRequest.Denied)
                {
                    FailQueuedItem(item, new RevitEventQueueException(
                        "revit_external_event_denied",
                        "Revit denied the pending Operator external event.",
                        retryable: false,
                        item.CorrelationId));
                    return;
                }
                if (request == ExternalEventRequest.TimedOut && attempt == 3)
                {
                    FailQueuedItem(item, new RevitEventQueueException(
                        "revit_external_event_raise_timed_out",
                        "Revit repeatedly failed to accept the pending Operator external event.",
                        retryable: true,
                        item.CorrelationId));
                    return;
                }
            }

            if (!item.Completion.Task.IsCompleted && Volatile.Read(ref item.ExecutionState) == QueueItem.Pending)
            {
                FailQueuedItem(item, new RevitEventQueueException(
                    "revit_external_event_still_pending",
                    "Revit did not begin the pending Operator external event after bounded raise retries.",
                    retryable: true,
                    item.CorrelationId));
            }
        }

        private void CancelQueuedItem(QueueItem expected)
        {
            expected.Completion.TrySetCanceled();

            // If Execute already started, it owns the slot until the Revit API callback
            // returns. Releasing it here would permit overlapping access to Revit's API.
            if (Interlocked.CompareExchange(
                    ref expected.ExecutionState,
                    QueueItem.CancelledBeforeStart,
                    QueueItem.Pending) != QueueItem.Pending)
            {
                return;
            }

            // Only one item can be in flight, so the head is expected to be this item. If
            // Execute won the dequeue race, it will observe CancelledBeforeStart and release
            // the slot in its finally block.
            if (_queue.TryDequeue(out var item))
            {
                if (ReferenceEquals(item, expected))
                {
                    Interlocked.Exchange(ref _inFlight, 0);
                    return;
                }

                _queue.Enqueue(item);
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

            object? result = null;
            Exception? error = null;
            var canceled = false;
            try
            {
                if (Interlocked.CompareExchange(
                        ref item.ExecutionState,
                        QueueItem.Started,
                        QueueItem.Pending) != QueueItem.Pending)
                {
                    canceled = true;
                }
                else if (item.CancellationToken.IsCancellationRequested || item.Completion.Task.IsCompleted)
                {
                    canceled = true;
                }
                else
                {
                    result = item.Action(app);
                }
            }
            catch (Exception ex)
            {
                error = ex;
            }
            finally
            {
                // Release the single-flight slot before completing the task. Completing it
                // first can wake the next hosted courier request while _inFlight is still 1,
                // producing a false revit_external_event_busy response between sequential
                // Revit actions. A Raise made before this handler returns is safely handled
                // by ExternalEventRequest.Pending and RetryPendingRaiseAsync.
                Interlocked.Exchange(ref _inFlight, 0);
            }

            if (canceled)
            {
                item.Completion.TrySetCanceled();
            }
            else if (error != null)
            {
                item.Completion.TrySetException(error);
            }
            else
            {
                item.Completion.TrySetResult(result!);
            }
        }

        public string GetName()
        {
            return "Revit Operator Event Handler";
        }
    }
}

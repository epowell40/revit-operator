using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Services
{
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
        }

        private readonly ConcurrentQueue<QueueItem> _queue = new ConcurrentQueue<QueueItem>();
        
        private ExternalEvent _externalEvent;

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

            if (cancellationToken.CanBeCanceled)
            {
                cancellationToken.Register(() => tcs.TrySetCanceled());
            }

            _queue.Enqueue(new QueueItem(app => action(app), tcs, cancellationToken));
            _externalEvent.Raise();
            return AwaitResult<T>(tcs.Task);
        }

        private static async Task<T> AwaitResult<T>(Task<object> task)
        {
            return (T)await task.ConfigureAwait(false);
        }

        public void Execute(UIApplication app)
        {
            while (_queue.TryDequeue(out var item))
            {
                try
                {
                    if (item.CancellationToken.IsCancellationRequested)
                    {
                        item.Completion.TrySetCanceled();
                        continue;
                    }

                    var result = item.Action(app);
                    item.Completion.TrySetResult(result);
                }
                catch (Exception ex)
                {
                    item.Completion.TrySetException(ex);
                }
            }
        }

        public string GetName()
        {
            return "Revit Operator Event Handler";
        }
    }
}

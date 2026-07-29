using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace RevitBridge.Common
{
    /// <summary>
    /// Executes a complete courier attempt and retries only a known-safe busy
    /// ExternalEvent receipt. The attempt delegate deliberately includes fresh
    /// authorization plus dispatch, so a retry can never reuse an old final
    /// execution authorization.
    /// </summary>
    public static class OperatorCourierBusyRetryExecutor
    {
        public static async Task<T> ExecuteAsync<T>(
            Func<CancellationToken, Task<T>> executeAttemptAsync,
            CancellationToken cancellationToken,
            string correlationId,
            IReadOnlyList<int> retryDelaysMs,
            Func<OperatorCourierFailureReceipt, int, int, Task>? onRetryAsync = null,
            Func<int, CancellationToken, Task>? delayAsync = null)
        {
            if (executeAttemptAsync == null) throw new ArgumentNullException(nameof(executeAttemptAsync));
            if (retryDelaysMs == null) throw new ArgumentNullException(nameof(retryDelaysMs));
            delayAsync ??= (milliseconds, token) => Task.Delay(milliseconds, token);

            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    return await executeAttemptAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    var failure = OperatorCourierFailureClassifier.Classify(error, correlationId);
                    var safeBusyRetry = string.Equals(failure.Code, "revit_external_event_busy", StringComparison.OrdinalIgnoreCase)
                        && failure.Retryable
                        && !failure.OutcomeUnknown
                        && attempt < retryDelaysMs.Count;
                    if (!safeBusyRetry) throw;

                    var delayMs = retryDelaysMs[attempt];
                    if (delayMs < 0) throw new ArgumentOutOfRangeException(nameof(retryDelaysMs));
                    if (onRetryAsync != null) await onRetryAsync(failure, attempt + 1, delayMs).ConfigureAwait(false);
                    await delayAsync(delayMs, cancellationToken).ConfigureAwait(false);
                }
            }
        }
    }
}

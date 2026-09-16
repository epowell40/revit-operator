using System;
using System.Diagnostics;
using System.Linq;
using System.Threading;

namespace RevitBridge.Common
{
    // Observability only: never consulted for admission, cancellation, or dispatch.
    public sealed class OperatorRevitQueueDiagnostic
    {
        private readonly Stopwatch _elapsed = Stopwatch.StartNew();
        private int _started;

        public OperatorRevitQueueDiagnostic(string? correlationId, string? source)
        {
            Id = OperatorCorrelationId.IsValid(correlationId) ? correlationId!.Trim() : Guid.NewGuid().ToString("N");
            Source = new string((source ?? "unspecified").Take(180)
                .Select(c => char.IsLetterOrDigit(c) || "/:._-".Contains(c) ? c : '_').ToArray());
        }

        public string Id { get; }
        public string Source { get; }
        public void MarkStarted() => Interlocked.Exchange(ref _started, 1);
        public string Describe() => $"id={Id} source={Source} state={(Volatile.Read(ref _started) == 0 ? "pending" : "started")} elapsed_ms={_elapsed.ElapsedMilliseconds}";

        public static void Write(Action<string>? sink, string phase, OperatorRevitQueueDiagnostic? request, OperatorRevitQueueDiagnostic? owner = null, string? idle = null)
        {
            try { sink?.Invoke($"Revit queue {phase}: {request?.Describe() ?? "request=unknown"}; owner=({owner?.Describe() ?? "none"})" + (idle == null ? "" : "; " + idle)); }
            catch { /* Logging must not change the execution result or slot ownership. */ }
        }
    }
}

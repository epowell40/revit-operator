using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class OperatorCapturedNativeFailure
    {
        public string severity { get; set; } = "unknown";
        public string message { get; set; } = "";
        public long[] elementIds { get; set; } = Array.Empty<long>();
        public string? failureDefinitionId { get; set; }
        public string[] captureErrors { get; set; } = Array.Empty<string>();
    }

    /// <summary>
    /// Opt-in transaction policy for unattended mutations: retain every posted
    /// warning/error and request rollback, never resolve or delete it to commit.
    /// The transaction owner, not this policy, establishes the actual effect.
    /// </summary>
    public sealed class OperatorNativeFailureGuard
    {
        private readonly List<OperatorCapturedNativeFailure> _failures = new();
        public IReadOnlyList<OperatorCapturedNativeFailure> Failures => _failures;
        public bool RollbackRequested { get; private set; }

        public void ConfigureAfterStart(Func<string> status, Action<bool> clearAfterRollback,
            Action installPreprocessor)
        {
            if (!string.Equals(status(), "Started", StringComparison.Ordinal))
                throw new InvalidOperationException("Noninteractive failure handling requires a started transaction.");
            clearAfterRollback(true);
            installPreprocessor();
        }

        public bool Preprocess<T>(Func<IEnumerable<T>> messages, Func<T, string> severity,
            Func<T, string> description, Func<T, IEnumerable<long>> elementIds,
            Func<T, string?> definitionId)
        {
            try
            {
                foreach (var message in messages())
                {
                    // Any unresolved message is unsafe for this unattended operation.
                    RollbackRequested = true;
                    var errors = new List<string>();
                    _failures.Add(new OperatorCapturedNativeFailure
                    {
                        severity = Read(() => severity(message), "unknown", "severity", errors),
                        message = Read(() => description(message), "", "description", errors),
                        elementIds = Read(() => elementIds(message).Distinct().ToArray(),
                            Array.Empty<long>(), "elementIds", errors),
                        failureDefinitionId = Read(() => definitionId(message), (string?)null, "failureDefinitionId", errors),
                        captureErrors = errors.ToArray()
                    });
                }
            }
            catch (Exception error)
            {
                RollbackRequested = true;
                _failures.Add(new OperatorCapturedNativeFailure
                {
                    severity = "capture_error",
                    message = "Native failure messages could not be completely inspected.",
                    captureErrors = new[] { error.Message }
                });
            }
            return RollbackRequested;
        }

        private static T Read<T>(Func<T> read, T fallback, string field, List<string> errors)
        {
            try { return read(); }
            catch (Exception error) { errors.Add(field + ": " + error.Message); return fallback; }
        }
    }
}

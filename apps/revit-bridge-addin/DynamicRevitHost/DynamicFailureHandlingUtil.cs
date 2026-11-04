using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    internal sealed class DynamicCapturedFailure
    {
        public string severity { get; set; } = "";
        public string message { get; set; } = "";
        public long[] elementIds { get; set; } = Array.Empty<long>();
        public string? failureDefinitionId { get; set; }
    }

    internal static class DynamicFailureHandlingUtil
    {
        internal static FailureHandlingOptions ConfigureFailureCapture(Transaction transaction, List<DynamicCapturedFailure> failures)
        {
            var options = transaction.GetFailureHandlingOptions();
            options.SetClearAfterRollback(true);
            options.SetFailuresPreprocessor(new FailureCapturePreprocessor(failures));
            return options;
        }

        private sealed class FailureCapturePreprocessor : IFailuresPreprocessor
        {
            private readonly List<DynamicCapturedFailure> _failures;
            internal FailureCapturePreprocessor(List<DynamicCapturedFailure> failures) => _failures = failures;

            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                var hasFailure = false;
                try
                {
                    foreach (var failure in accessor.GetFailureMessages())
                    {
                        // Continue delegates unresolved warnings to Revit's modal
                        // UI. An unattended program cannot consent to losing a
                        // host or other model relationship. Retain diagnostics
                        // and roll back this transaction instead of hiding them.
                        hasFailure = true;
                        if (failure == null) throw new InvalidOperationException("Native failure entry was unavailable.");
                        FailureSeverity severity;
                        try { severity = failure.GetSeverity(); } catch { severity = FailureSeverity.Error; }
                        string message;
                        try { message = failure.GetDescriptionText() ?? ""; } catch { message = ""; }
                        long[] ids;
                        try { ids = failure.GetFailingElementIds().Select(ElementIdCompat.GetValue).Distinct().ToArray(); } catch { ids = Array.Empty<long>(); }
                        string? definitionId;
                        try { definitionId = failure.GetFailureDefinitionId()?.Guid.ToString(); } catch { definitionId = null; }
                        _failures.Add(new DynamicCapturedFailure
                        {
                            severity = severity == FailureSeverity.Warning ? "warning" : severity == FailureSeverity.DocumentCorruption ? "document_corruption" : "error",
                            message = message,
                            elementIds = ids,
                            failureDefinitionId = definitionId
                        });
                    }
                }
                catch
                {
                    hasFailure = true;
                    _failures.Add(new DynamicCapturedFailure { severity = "error", message = "Native failure inventory could not be fully read; transaction requires rollback." });
                }
                return hasFailure ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitBridge.Logic.Handlers
{
    internal sealed class CapturedFailure
    {
        public string severity { get; set; } = "";
        public string message { get; set; } = "";
        public long[] elementIds { get; set; } = Array.Empty<long>();
        public string? failureDefinitionId { get; set; }
    }

    internal static class FailureHandlingUtil
    {
        internal static FailureHandlingOptions ConfigureFailureCapture(Transaction t, List<CapturedFailure> failures, bool rollbackOnErrors = true, bool deleteWarnings = false)
        {
            var fho = t.GetFailureHandlingOptions();
            fho.SetClearAfterRollback(true);
            fho.SetFailuresPreprocessor(new FailureCapturePreprocessor(failures, rollbackOnErrors, deleteWarnings));
            return fho;
        }

        internal static bool HasErrors(List<CapturedFailure> failures)
        {
            foreach (var f in failures)
            {
                if (string.Equals(f.severity, "error", StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(f.severity, "document_corruption", StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private sealed class FailureCapturePreprocessor : IFailuresPreprocessor
        {
            private readonly List<CapturedFailure> _failures;
            private readonly bool _rollbackOnErrors;
            private readonly bool _deleteWarnings;

            public FailureCapturePreprocessor(List<CapturedFailure> failures, bool rollbackOnErrors, bool deleteWarnings)
            {
                _failures = failures;
                _rollbackOnErrors = rollbackOnErrors;
                _deleteWarnings = deleteWarnings;
            }

            public FailureProcessingResult PreprocessFailures(FailuresAccessor failuresAccessor)
            {
                bool hasError = false;

                try
                {
                    var msgs = failuresAccessor.GetFailureMessages();
                    foreach (var m in msgs)
                    {
                        if (m == null) continue;

                        FailureSeverity sev;
                        try { sev = m.GetSeverity(); }
                        catch { sev = FailureSeverity.Warning; }

                        var sevToken = SeverityToken(sev);
                        if (sev != FailureSeverity.Warning) hasError = true;

                        string msg;
                        try { msg = m.GetDescriptionText() ?? ""; }
                        catch { msg = ""; }

                        long[] ids = Array.Empty<long>();
                        try
                        {
                            var failing = m.GetFailingElementIds();
                            if (failing != null && failing.Count > 0)
                                ids = failing.Select(id => RevitBridge.Common.ElementIdCompat.GetValue(id)).Distinct().ToArray();
                        }
                        catch { }

                        string? defId = null;
                        try
                        {
                            var id = m.GetFailureDefinitionId();
                            defId = id?.Guid.ToString();
                        }
                        catch { }

                        _failures.Add(new CapturedFailure
                        {
                            severity = sevToken,
                            message = msg,
                            elementIds = ids,
                            failureDefinitionId = defId
                        });

                        if (_deleteWarnings && sev == FailureSeverity.Warning)
                        {
                            try { failuresAccessor.DeleteWarning(m); } catch { }
                        }
                    }
                }
                catch
                {
                    // best effort
                }

                if (hasError && _rollbackOnErrors)
                    return FailureProcessingResult.ProceedWithRollBack;

                return FailureProcessingResult.Continue;
            }

            private static string SeverityToken(FailureSeverity s)
            {
                return s switch
                {
                    FailureSeverity.Warning => "warning",
                    FailureSeverity.Error => "error",
                    FailureSeverity.DocumentCorruption => "document_corruption",
                    _ => "unknown"
                };
            }
        }
    }
}

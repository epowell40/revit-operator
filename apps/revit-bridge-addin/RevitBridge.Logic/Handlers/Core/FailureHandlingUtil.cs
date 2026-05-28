using System;
using Autodesk.Revit.DB;

namespace RevitBridge.Logic.Handlers.Core
{
    internal sealed class SwallowWarningsPreprocessor : IFailuresPreprocessor
    {
        public FailureProcessingResult PreprocessFailures(FailuresAccessor failuresAccessor)
        {
            try
            {
                var failures = failuresAccessor.GetFailureMessages();
                if (failures == null || failures.Count == 0) return FailureProcessingResult.Continue;

                foreach (var f in failures)
                {
                    try
                    {
                        if (f == null) continue;
                        if (f.GetSeverity() == FailureSeverity.Warning)
                        {
                            failuresAccessor.DeleteWarning(f);
                        }
                    }
                    catch
                    {
                        // ignore per-failure
                    }
                }
            }
            catch
            {
                // ignore
            }

            return FailureProcessingResult.Continue;
        }
    }

    internal static class WarningSuppressionUtil
    {
        public static void SuppressWarnings(Transaction t)
        {
            if (t == null) return;
            try
            {
                var opts = t.GetFailureHandlingOptions();
                opts.SetFailuresPreprocessor(new SwallowWarningsPreprocessor());
                opts.SetClearAfterRollback(true);
                t.SetFailureHandlingOptions(opts);
            }
            catch
            {
                // ignore
            }
        }
    }
}

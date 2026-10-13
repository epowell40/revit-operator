using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class NativeNonInteractiveFailureHandling : IFailuresPreprocessor
    {
        private readonly OperatorNativeFailureGuard _guard;
        private NativeNonInteractiveFailureHandling(OperatorNativeFailureGuard guard) => _guard = guard;

        public static void Configure(Transaction transaction, OperatorNativeFailureGuard guard,
            bool captureBeforeSilentRollback = false)
        {
            var options = transaction.GetFailureHandlingOptions();
            guard.ConfigureAfterStart(() => transaction.GetStatus().ToString(),
                clear => options.SetClearAfterRollback(clear),
                () =>
                {
                    options.SetFailuresPreprocessor(new NativeNonInteractiveFailureHandling(guard));
                    transaction.SetFailureHandlingOptions(options);
                }, captureBeforeSilentRollback);
        }

        public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
        {
            var rollback = _guard.Preprocess(() => accessor.GetFailureMessages(),
                message => message.GetSeverity().ToString(),
                message => message.GetDescriptionText() ?? "",
                message => message.GetFailingElementIds().Select(ElementIdCompat.GetValue),
                message => message.GetFailureDefinitionId()?.Guid.ToString());
            if (rollback)
            {
                // Preserve the real failure before asking Revit to clear it.
                // This also covers intentional preview rollback, where clearing
                // at transaction entry would bypass this callback entirely.
                var options = accessor.GetFailureHandlingOptions();
                options.SetClearAfterRollback(true);
                accessor.SetFailureHandlingOptions(options);
                return FailureProcessingResult.ProceedWithRollBack;
            }
            return FailureProcessingResult.Continue;
        }
    }
}

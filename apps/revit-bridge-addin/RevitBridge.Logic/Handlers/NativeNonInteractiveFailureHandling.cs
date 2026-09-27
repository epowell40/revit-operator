using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    internal sealed class NativeNonInteractiveFailureHandling : IFailuresPreprocessor
    {
        private readonly OperatorNativeFailureGuard _guard;
        private NativeNonInteractiveFailureHandling(OperatorNativeFailureGuard guard) => _guard = guard;

        internal static void Configure(Transaction transaction, OperatorNativeFailureGuard guard)
        {
            var options = transaction.GetFailureHandlingOptions();
            guard.ConfigureAfterStart(() => transaction.GetStatus().ToString(),
                clear => options.SetClearAfterRollback(clear),
                () =>
                {
                    options.SetFailuresPreprocessor(new NativeNonInteractiveFailureHandling(guard));
                    transaction.SetFailureHandlingOptions(options);
                });
        }

        public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
        {
            var rollback = _guard.Preprocess(() => accessor.GetFailureMessages(),
                message => message.GetSeverity().ToString(),
                message => message.GetDescriptionText() ?? "",
                message => message.GetFailingElementIds().Select(ElementIdCompat.GetValue),
                message => message.GetFailureDefinitionId()?.Guid.ToString());
            return rollback ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
        }
    }
}

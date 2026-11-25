using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public static class NativeLifecycleExecution
    {
        public static Dictionary<string, object?> Execute(UIApplication app, Document doc, string path, string action,
            Action invoke, Func<Dictionary<string, object?>> readback)
        {
            var inventory = new OperatorNativeChangeInventory(doc);
            var session = OperatorNativeDocumentSessionAuthority.GetSessionId(doc);
            bool invoking = false;
            int observedFailures = 0, acknowledgedWarnings = 0;
            var failures = new List<object>();
            string? warningHandlingError = null;
            void Processing(object sender, FailuresProcessingEventArgs args)
            {
                if (!invoking) return;
                try
                {
                    var accessor = args.GetFailuresAccessor();
                    if (!doc.Equals(accessor.GetDocument())) return;
                    var messages = accessor.GetFailureMessages().ToArray();
                    OperatorLifecycleWarningPolicy.Acknowledge(true,
                        args.GetProcessingResult() == FailureProcessingResult.Continue, messages,
                        m => m.GetSeverity() == FailureSeverity.Warning,
                        m => {
                            // Read all diagnostic fields even when the bounded presentation
                            // is full; failed observation must not silently dismiss a warning.
                            var ids = m.GetFailingElementIds().Select(ElementIdCompat.GetValue).ToArray();
                            var item = new { severity = m.GetSeverity().ToString(), message = m.GetDescriptionText(),
                                definitionId = m.GetFailureDefinitionId().Guid.ToString(),
                                elementIds = ids.Take(100).ToArray(), elementCount = ids.Length };
                            observedFailures++;
                            if (failures.Count < 100) failures.Add(item);
                        },
                        m => { accessor.DeleteWarning(m); acknowledgedWarnings++; });
                    // Leave Continue unchanged: no recommit, rollback or error resolution.
                }
                catch (Exception ex) { warningHandlingError = ex.Message; }
            }
            void Changed(object sender, DocumentChangedEventArgs args) => inventory.Observe(() => args.GetDocument(),
                () => args.GetAddedElementIds().Select(ElementIdCompat.GetValue),
                () => args.GetModifiedElementIds().Select(ElementIdCompat.GetValue),
                () => args.GetDeletedElementIds().Select(ElementIdCompat.GetValue));
            app.Application.DocumentChanged += Changed;
            app.Application.FailuresProcessing += Processing;
            try
            {
                var result = OperatorNativeLifecycleReceipt.Execute(path, action, session,
                    () => { invoking = true; try { invoke(); } finally { invoking = false; } }, readback);
                result["warningHandling"] = new { scope = "current_document_native_lifecycle_invocation",
                    observedFailureCount = observedFailures, acknowledgedWarningCount = acknowledgedWarnings,
                    reportedFailureCount = failures.Count, truncated = observedFailures > failures.Count,
                    failures, error = warningHandlingError };
                // Event observations do not claim ownership of Revit's internal transactions.
                var observed = inventory.CommittedReceipt();
                result["nativeChanges"] = new { addedElementIds = observed.AddedElementIds,
                    modifiedElementIds = observed.ModifiedElementIds, deletedElementIds = observed.DeletedElementIds };
                result["changeTracking"] = inventory.Diagnostics();
                return result;
            }
            finally { app.Application.FailuresProcessing -= Processing; app.Application.DocumentChanged -= Changed; }
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>Owns an atomic group whose callback commits and verifies its child transactions.</summary>
    public static class NativeAtomicTransactionGroup
    {
        public static Dictionary<string, object?> Execute(UIApplication app, Document doc, string name,
            Func<Dictionary<string, object?>> mutate,
            Func<IEnumerable<long>> nativeCreatedElements,
            Func<IEnumerable<long>> nativeModifiedElements,
            NativeTransactionDisposition disposition)
        {
            var inventory = new OperatorNativeChangeInventory(doc);
            void Changed(object sender, DocumentChangedEventArgs args)
            {
                inventory.Observe(() => args.GetDocument(),
                    () => args.GetAddedElementIds().Select(ElementIdCompat.GetValue),
                    () => args.GetModifiedElementIds().Select(ElementIdCompat.GetValue),
                    () => args.GetDeletedElementIds().Select(ElementIdCompat.GetValue));
            }
            using (var group = new TransactionGroup(doc, name))
            {
                app.Application.DocumentChanged += Changed;
                try
                {
                    // Child commit is still provisional. Only the observed outer
                    // assimilation/rollback establishes the persistent effect.
                    var result = OperatorNativeTransactionExecution.Execute(
                        () => group.Start().ToString(), () => group.Assimilate().ToString(),
                        () => group.RollBack().ToString(), () => group.GetStatus().ToString(), mutate,
                        inventory.CommittedReceipt, nativeCreatedElements, nativeModifiedElements, disposition);
                    result["changeTracking"] = inventory.Diagnostics();
                    return result;
                }
                finally { app.Application.DocumentChanged -= Changed; }
            }
        }
    }
}

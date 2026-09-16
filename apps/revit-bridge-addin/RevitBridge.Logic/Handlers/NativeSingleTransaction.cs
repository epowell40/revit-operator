using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>For handlers that own exactly one transaction, without a surrounding transaction group.</summary>
    public static class NativeSingleTransaction
    {
        public static Dictionary<string, object?> Execute(UIApplication app, Document doc, string name,
            Func<ISet<long>, Dictionary<string, object?>> mutate,
            Func<IEnumerable<long>>? nativeModifiedElements = null)
        {
            var inventory = new OperatorNativeChangeInventory(doc);
            var nativeCreated = new HashSet<long>();
            void Changed(object sender, DocumentChangedEventArgs args)
            {
                inventory.Observe(() => args.GetDocument(),
                    () => args.GetAddedElementIds().Select(ElementIdCompat.GetValue),
                    () => args.GetModifiedElementIds().Select(ElementIdCompat.GetValue),
                    () => args.GetDeletedElementIds().Select(ElementIdCompat.GetValue));
            }
            using (var tx = new Transaction(doc, name))
            {
                app.Application.DocumentChanged += Changed;
                try
                {
                    var result = OperatorNativeTransactionExecution.Execute(
                        () => tx.Start().ToString(), () => tx.Commit().ToString(),
                        () => tx.RollBack().ToString(), () => tx.GetStatus().ToString(), () => mutate(nativeCreated),
                        inventory.CommittedReceipt,
                        () => nativeCreated, nativeModifiedElements);
                    result["changeTracking"] = inventory.Diagnostics();
                    return result;
                }
                finally { app.Application.DocumentChanged -= Changed; }
            }
        }
    }
}

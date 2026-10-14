using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>One outer native group owns child transactions and the final effect receipt.</summary>
    public static class NativeTransactionGroup
    {
        public static Dictionary<string, object?> Execute(UIApplication app, Document doc, string name,
            Func<Dictionary<string, object?>> mutate,
            NativeTransactionDisposition disposition = NativeTransactionDisposition.Commit,
            Func<IEnumerable<long>>? nativeCreatedElements = null)
        {
            var inventory = new OperatorNativeChangeInventory(doc);
            void Changed(object sender, DocumentChangedEventArgs args)
            {
                inventory.Observe(() => args.GetDocument(),
                    () => args.GetAddedElementIds().Select(ElementIdCompat.GetValue),
                    () => args.GetModifiedElementIds().Select(ElementIdCompat.GetValue),
                    () => args.GetDeletedElementIds().Select(ElementIdCompat.GetValue));
            }
            var group = new TransactionGroup(doc, name);
            return OperatorNativeTransactionExecution.ExecuteWithCleanup(() =>
            {
                app.Application.DocumentChanged += Changed;
                try
                {
                    var result = OperatorNativeTransactionExecution.Execute(
                        () => group.Start().ToString(), () => group.Assimilate().ToString(),
                        () => group.RollBack().ToString(), () => group.GetStatus().ToString(),
                        mutate, inventory.CommittedReceipt, nativeCreatedElements: nativeCreatedElements, disposition: disposition);
                    result["changeTracking"] = inventory.Diagnostics();
                    return result;
                }
                finally { app.Application.DocumentChanged -= Changed; }
            }, group.Dispose);
        }
    }
}

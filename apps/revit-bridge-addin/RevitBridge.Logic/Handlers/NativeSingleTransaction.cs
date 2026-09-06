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
    internal static class NativeSingleTransaction
    {
        public static object Execute(UIApplication app, Document doc, string name,
            Func<ISet<long>, Dictionary<string, object?>> mutate)
        {
            var added = new HashSet<long>();
            var modified = new HashSet<long>();
            var deleted = new HashSet<long>();
            var nativeCreated = new HashSet<long>();
            var documentChangedObserved = false;
            void Changed(object sender, DocumentChangedEventArgs args)
            {
                if (!ReferenceEquals(args.GetDocument(), doc)) return;
                added.UnionWith(args.GetAddedElementIds().Select(ElementIdCompat.GetValue));
                modified.UnionWith(args.GetModifiedElementIds().Select(ElementIdCompat.GetValue));
                deleted.UnionWith(args.GetDeletedElementIds().Select(ElementIdCompat.GetValue));
                documentChangedObserved = true;
            }
            using (var tx = new Transaction(doc, name))
            {
                app.Application.DocumentChanged += Changed;
                try
                {
                    var result = OperatorNativeTransactionExecution.Execute(
                        () => tx.Start().ToString(), () => tx.Commit().ToString(),
                        () => tx.RollBack().ToString(), () => tx.GetStatus().ToString(), () => mutate(nativeCreated),
                        () => OperatorNativeTransactionReceipt.CommittedChanges(added, modified, deleted),
                        () => nativeCreated);
                    result["changeTracking"] = new
                    {
                        documentChangedObserved,
                        // Known created IDs do not claim an exhaustive modified/deleted inventory.
                        exhaustiveChangeInventory = documentChangedObserved
                    };
                    return result;
                }
                finally { app.Application.DocumentChanged -= Changed; }
            }
        }
    }
}

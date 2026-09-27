using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class DuplicateElementTypeHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long sourceTypeId { get; set; }
            public string newTypeName { get; set; } = "";
            public bool dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope => HandleCore(app, jsonData, enterNativeScope)));

        private object HandleCore(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.sourceTypeId <= 0) throw new ArgumentException("sourceTypeId is required.");
            var newName = (p.newTypeName ?? "").Trim();
            if (newName.Length == 0) throw new ArgumentException("newTypeName is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var src = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.sourceTypeId)) as ElementType;
            if (src == null) throw new InvalidOperationException($"Element {p.sourceTypeId} not found or is not an ElementType.");

            if (p.dryRun)
            {
                return new
                {
                    ok = true,
                    dryRun = true,
                    sourceTypeId = RevitBridge.Common.ElementIdCompat.GetValue(src.Id),
                    sourceTypeName = src.Name,
                    newTypeName = newName,
                    transaction = OperatorNativeTransactionReceipt.NotStarted(),
                    note = "Dry-run does not guarantee name uniqueness; apply will fail if Revit disallows the name."
                };
            }

            var sourceTypeName = src.Name;
            long createdId = 0;
            enterNativeScope();
            var result = NativeSingleTransaction.Execute(app, doc, "Duplicate Element Type", nativeCreated =>
            {
                var created = src.Duplicate(newName) as ElementType;
                if (created == null) throw new InvalidOperationException("Duplicate did not return an ElementType.");
                createdId = ElementIdCompat.GetValue(created.Id);
                nativeCreated.Add(createdId);
                return new Dictionary<string, object?>
                {
                    ["dryRun"] = false, ["sourceTypeId"] = p.sourceTypeId, ["sourceTypeName"] = sourceTypeName,
                    ["newTypeId"] = createdId, ["newTypeName"] = created.Name
                };
            });
            OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                var persisted = doc.GetElement(ElementIdCompat.Create(createdId)) as ElementType;
                if (persisted == null || persisted.Name != newName)
                    throw new InvalidOperationException("Committed duplicate type readback did not match the new type.");
                return new Dictionary<string, object?> { ["newTypeName"] = persisted.Name };
            });
            try { uidoc.RefreshActiveView(); } catch { }
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Applied");
            return result;
        }
    }
}

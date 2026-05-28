using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public class DeleteElementsHandler : IRequestHandler
    {
        public class Params
        {
            public List<long>? ids { get; set; }

            // Back-compat: legacy callers used {apply:false} for dry-run. Prefer {dryRun:true}.
            public bool? apply { get; set; }
            public bool? dryRun { get; set; }

            // Optional bulk safety: when deleting many elements, require a typed confirmation phrase.
            // Recommended phrase: "DELETE {count} ELEMENTS"
            public string? confirm { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var ids = (p.ids ?? new List<long>()).Where(x => x > 0).Distinct().ToList();
            if (ids.Count == 0) throw new InvalidOperationException("delete.ids is required and must be a non-empty array of element ids.");

            var isDryRun = (p.dryRun ?? false) || (p.apply.HasValue && p.apply.Value == false);
            var apply = !isDryRun;

            // Typed confirm phrases for destructive bulk ops (UI should help populate this field).
            const int ConfirmThreshold = 25;
            var confirmReceived = BulkConfirmUtil.Normalize(p.confirm);
            string? requiredConfirm = null;
            if (apply && ids.Count > ConfirmThreshold)
            {
                requiredConfirm = BulkConfirmUtil.ExpectedDeleteElements(ids.Count);
                if (!BulkConfirmUtil.EqualsNormalized(p.confirm, requiredConfirm))
                {
                    throw new OperatorToolUserErrorException(
                        message: "Bulk delete requires typed confirmation.",
                        code: "bulk_confirm_required",
                        requiredConfirm: requiredConfirm,
                        confirmReceived: confirmReceived,
                        maxChangesPerCall: 10,
                        hint: "Retry with confirm set to the requiredConfirm string (exact, but markdown like **...** is ok). If OPERATOR_BULK_CONFIRM_SIMPLE=1, you can also use confirm:\"yes\".");
                }
            }

            var elementIds = ids.Select(id => RevitBridge.Common.ElementIdCompat.Create(id)).ToList();
            var requestedDetails = new List<object>(capacity: Math.Min(128, elementIds.Count));
            foreach (var id in elementIds)
            {
                var el = doc.GetElement(id);
                requestedDetails.Add(new
                {
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(id),
                    exists = el != null,
                    category = el?.Category?.Name,
                    name = el?.Name,
                    typeId = RevitBridge.Common.ElementIdCompat.GetValue(el?.GetTypeId()),
                    uniqueId = el?.UniqueId
                });
            }

            using (Transaction trans = new Transaction(doc, "Delete Elements"))
            {
                trans.Start();
                
                ICollection<ElementId> deletedIds = null;
                try 
                {
                    deletedIds = doc.Delete(elementIds);
                }
                catch
                {
                    // If deletion fails, we can't report what would be deleted.
                    trans.RollBack();
                    throw;
                }

                var impacted = deletedIds?.Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x)).Distinct().OrderBy(x => x).ToList() ?? new List<long>();
                var requested = ids.OrderBy(x => x).ToList();
                var dependent = impacted.Except(requested).ToList();

                if (apply)
                {
                    trans.Commit();
                    return Task.FromResult<object>(new
                    {
                        status = "Deleted",
                        dryRun = false,
                        requestedCount = requested.Count,
                        impactedCount = impacted.Count,
                        requestedIds = requested,
                        impactedIds = impacted,
                        dependentIds = dependent,
                        requestedDetails,
                        requiredConfirm,
                        confirmReceived
                    });
                }
                else
                {
                    trans.RollBack();
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        dryRun = true,
                        requestedCount = requested.Count,
                        impactedCount = impacted.Count,
                        requestedIds = requested,
                        impactedIds = impacted,
                        dependentIds = dependent,
                        requestedDetails,
                        requiredConfirm,
                        confirmReceived
                    });
                }
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class QuantifyVisualizeHandler : IRequestHandler
    {
        public class Params
        {
            public string resultSetId { get; set; }
            public string mode { get; set; } // "highlight" | "isolate" | "new_view" | "clear" | "forget"
            public long? viewId { get; set; } // optional; default active view
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var uidoc = app.ActiveUIDocument;
            var doc = uidoc.Document;

            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var mode = (p.mode ?? "highlight").Trim().ToLowerInvariant();
            if (mode != "highlight" && mode != "isolate" && mode != "new_view" && mode != "clear" && mode != "forget")
            {
                mode = "highlight";
            }

            var rsid = (p.resultSetId ?? "").Trim();
            if (rsid.Length == 0)
            {
                return Task.FromResult<object>(new { status = "Failed", error = "resultSetId is required." });
            }

            if (mode == "forget")
            {
                var ok = QuantifyResultSetStore.Forget(rsid);
                return Task.FromResult<object>(new { status = "OK", mode, forgotten = ok, resultSetId = rsid });
            }

            if (!QuantifyResultSetStore.TryGetHostIds(rsid, out var hostIds))
            {
                return Task.FromResult<object>(new { status = "Failed", error = "Unknown or expired resultSetId.", resultSetId = rsid });
            }

            var ids = hostIds.Select(x => RevitBridge.Common.ElementIdCompat.Create(x)).ToList();
            if (ids.Count == 0)
            {
                return Task.FromResult<object>(new { status = "OK", mode, resultSetId = rsid, warning = "No host element ids to visualize." });
            }

            View view = null;
            if (p.viewId.HasValue && p.viewId.Value > 0)
            {
                view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
            }
            if (view == null) view = uidoc.ActiveView;

            if (mode == "clear")
            {
                try
                {
                    uidoc.Selection.SetElementIds(new List<ElementId>());
                }
                catch { /* ignore */ }

                bool clearedIsolate = false;
                try
                {
                    if (view != null) view.DisableTemporaryViewMode(TemporaryViewMode.TemporaryHideIsolate);
                    clearedIsolate = true;
                }
                catch { /* ignore */ }

                return Task.FromResult<object>(new { status = "OK", mode, resultSetId = rsid, viewId = RevitBridge.Common.ElementIdCompat.GetValue(view?.Id), clearedIsolate });
            }

            if (mode == "highlight")
            {
                uidoc.Selection.SetElementIds(ids);
                return Task.FromResult<object>(new { status = "OK", mode, resultSetId = rsid, selectedCount = ids.Count, viewId = RevitBridge.Common.ElementIdCompat.GetValue(view?.Id) });
            }

            if (mode == "isolate")
            {
                using (var t = new Transaction(doc, "Quantify: Isolate Result Set"))
                {
                    t.Start();
                    view.IsolateElementsTemporary(ids);
                    t.Commit();
                }
                return Task.FromResult<object>(new { status = "OK", mode, resultSetId = rsid, isolatedCount = ids.Count, viewId = RevitBridge.Common.ElementIdCompat.GetValue(view?.Id) });
            }

            // mode == "new_view"
            View3D v3 = null;
            using (var t = new Transaction(doc, "Quantify: Create Results View"))
            {
                t.Start();
                var vft = new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewFamilyType))
                    .Cast<ViewFamilyType>()
                    .FirstOrDefault(x => x.ViewFamily == ViewFamily.ThreeDimensional);

                if (vft == null)
                {
                    t.RollBack();
                    return Task.FromResult<object>(new { status = "Failed", error = "No 3D ViewFamilyType found." });
                }

                v3 = View3D.CreateIsometric(doc, vft.Id);
                if (v3 == null)
                {
                    t.RollBack();
                    return Task.FromResult<object>(new { status = "Failed", error = "Failed to create 3D view." });
                }

                try
                {
                    var name = $"Quantify_Results_{DateTime.Now:yyyyMMdd_HHmmss}";
                    v3.Name = name;
                }
                catch { /* ignore */ }

                v3.IsolateElementsTemporary(ids);
                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "OK",
                mode,
                resultSetId = rsid,
                createdViewId = RevitBridge.Common.ElementIdCompat.GetValue(v3?.Id),
                isolatedCount = ids.Count
            });
        }
    }
}

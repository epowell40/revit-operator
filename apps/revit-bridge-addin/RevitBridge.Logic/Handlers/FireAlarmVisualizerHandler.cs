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
    public class FireAlarmVisualizerHandler : IRequestHandler
    {
        public class Request
        {
            public long viewId { get; set; }
            public string action { get; set; } // "show" | "hide" | "clear"
            public string runId { get; set; } // optional; if omitted applies to all RO_FA elements in view
            public List<string> layers { get; set; } // optional
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var doc = app.ActiveUIDocument.Document;
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var req = JsonSerializer.Deserialize<Request>(jsonData ?? "{}", opts) ?? new Request();

            var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(req.viewId)) as View;
            if (view == null) throw new Exception("View not found.");

            string action = (req.action ?? "").Trim().ToLowerInvariant();
            if (action != "show" && action != "hide" && action != "clear") throw new Exception("Invalid action. Use show|hide|clear.");

            var ids = FindVisualizerElementIds(doc, view, req.runId, req.layers);
            if (ids.Count == 0) return Task.FromResult<object>(new { viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id), action, matched = 0 });

            using (var t = new Transaction(doc, $"Fire Alarm Visualizer {action}"))
            {
                t.Start();
                try
                {
                    if (action == "hide")
                    {
                        view.HideElements(ids);
                    }
                    else if (action == "show")
                    {
                        view.UnhideElements(ids);
                    }
                    else if (action == "clear")
                    {
                        doc.Delete(ids);
                    }
                    t.Commit();
                }
                catch
                {
                    t.RollBack();
                    throw;
                }
            }

            return Task.FromResult<object>(new { viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id), action, matched = ids.Count });
        }

        private static ICollection<ElementId> FindVisualizerElementIds(Document doc, View view, string runId, List<string> layers)
        {
            var layerSet = new HashSet<string>((layers ?? new List<string>()).Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()), StringComparer.OrdinalIgnoreCase);

            bool filterRunId = !string.IsNullOrWhiteSpace(runId);
            bool filterLayers = layerSet.Count > 0;

            var collector = new FilteredElementCollector(doc, view.Id)
                .WhereElementIsNotElementType()
                .OfClass(typeof(CurveElement));

            var ids = new List<ElementId>();

            foreach (var e in collector)
            {
                var comment = TryGetStringParam(e, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS) ??
                              TryGetStringParam(e, "Comments");
                if (string.IsNullOrWhiteSpace(comment)) continue;
                if (comment.IndexOf("RO_FA", StringComparison.OrdinalIgnoreCase) < 0) continue;

                if (filterRunId && comment.IndexOf($"runId={runId}", StringComparison.OrdinalIgnoreCase) < 0) continue;

                if (filterLayers)
                {
                    var matched = layerSet.Any(l => comment.IndexOf($"layer={l}", StringComparison.OrdinalIgnoreCase) >= 0);
                    if (!matched) continue;
                }

                ids.Add(e.Id);
            }

            return ids;
        }

        private static string TryGetStringParam(Element e, BuiltInParameter bip)
        {
            try
            {
                var p = e.get_Parameter(bip);
                if (p == null) return null;
                if (p.StorageType == StorageType.String) return p.AsString();
                return null;
            }
            catch { return null; }
        }

        private static string TryGetStringParam(Element e, string name)
        {
            try
            {
                var p = e.LookupParameter(name);
                if (p == null) return null;
                if (p.StorageType == StorageType.String) return p.AsString();
                return null;
            }
            catch { return null; }
        }
    }
}

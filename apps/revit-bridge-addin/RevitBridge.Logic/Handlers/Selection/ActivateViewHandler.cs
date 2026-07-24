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
    public class ActivateViewHandler : IRequestHandler
    {
        public class Params
        {
            public long? viewId { get; set; }
            // Compatibility aliases seen in agent/tooling payloads.
            public long? targetViewId { get; set; }
            public long? sheetId { get; set; }
            public long? id { get; set; }
            public string? viewName { get; set; }
            public string? query { get; set; }
            public bool? exact { get; set; }
            public string? viewType { get; set; }
            public List<long>? showElementIds { get; set; }
            public double[]? bboxMinXyz { get; set; }
            public double[]? bboxMaxXyz { get; set; }
            public bool zoomToFit { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");
            var targetViewId = ResolveTargetViewId(app, p);
            if (targetViewId <= 0)
            {
                throw new ArgumentException("Missing required parameter: viewId (aliases accepted: targetViewId, sheetId, id) or a resolvable viewName/query.");
            }

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new Exception("No active UI document.");
            var doc = uidoc.Document;

            var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(targetViewId)) as View;
            if (view == null) throw new ArgumentException($"View {targetViewId} not found.");
            if (view.IsTemplate) throw new ArgumentException("Cannot activate a view template.");

            var warnings = new List<string>();

            try
            {
                uidoc.ActiveView = view;
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Failed to activate view {targetViewId} ('{view.Name}'): {ex.Message}", ex);
            }

            var shown = new List<long>();
            var notShown = new List<long>();
            if (p.showElementIds != null && p.showElementIds.Count > 0)
            {
                var requestedIds = p.showElementIds
                    .Where(id => id != 0)
                    .Distinct()
                    .ToList();
                var existingIds = new List<ElementId>();
                foreach (var id in requestedIds)
                {
                    var elementId = RevitBridge.Common.ElementIdCompat.Create(id);
                    if (doc.GetElement(elementId) == null)
                    {
                        notShown.Add(id);
                        warnings.Add($"ShowElements skipped missing element {id}.");
                        continue;
                    }
                    existingIds.Add(elementId);
                }

                if (existingIds.Count > 0)
                {
                    try
                    {
                        var visibleInRequestedView = new HashSet<long>(
                            new FilteredElementCollector(doc, view.Id)
                                .WhereElementIsNotElementType()
                                .ToElementIds()
                                .Select(RevitBridge.Common.ElementIdCompat.GetValue));
                        var showableIds = existingIds
                            .Where(id => visibleInRequestedView.Contains(RevitBridge.Common.ElementIdCompat.GetValue(id)))
                            .ToList();
                        var hiddenIds = existingIds
                            .Where(id => !visibleInRequestedView.Contains(RevitBridge.Common.ElementIdCompat.GetValue(id)))
                            .Select(RevitBridge.Common.ElementIdCompat.GetValue)
                            .ToList();
                        notShown.AddRange(hiddenIds);

                        if (showableIds.Count == 0)
                        {
                            warnings.Add($"ShowElements skipped: none of the requested elements are visible in activated view {targetViewId} ('{view.Name}').");
                        }
                        else
                        {
                            uidoc.ShowElements(showableIds);
                            shown.AddRange(showableIds.Select(RevitBridge.Common.ElementIdCompat.GetValue));
                            if (hiddenIds.Count > 0)
                                warnings.Add($"ShowElements omitted {hiddenIds.Count} element(s) not visible in activated view {targetViewId} ('{view.Name}'): {string.Join(",", hiddenIds)}.");
                        }
                    }
                    catch (Exception ex)
                    {
                        notShown.AddRange(existingIds
                            .Select(RevitBridge.Common.ElementIdCompat.GetValue)
                            .Where(id => !shown.Contains(id) && !notShown.Contains(id)));
                        warnings.Add($"ShowElements preflight failed; interactive view search was not attempted: {ex.Message}");
                    }
                }
            }

            UIView? uiView = null;
            try
            {
                uiView = uidoc.GetOpenUIViews().FirstOrDefault(v => v.ViewId == view.Id);
            }
            catch (Exception ex)
            {
                warnings.Add($"GetOpenUIViews failed: {ex.Message}");
            }

            var didZoom = false;

            bool HasBbox(double[]? a) => a != null && a.Length >= 3 && a.All(v => !double.IsNaN(v) && !double.IsInfinity(v));
            if (uiView != null && HasBbox(p.bboxMinXyz) && HasBbox(p.bboxMaxXyz))
            {
                var minX = Math.Min(p.bboxMinXyz![0], p.bboxMaxXyz![0]);
                var minY = Math.Min(p.bboxMinXyz![1], p.bboxMaxXyz![1]);
                var minZ = Math.Min(p.bboxMinXyz![2], p.bboxMaxXyz![2]);
                var maxX = Math.Max(p.bboxMinXyz![0], p.bboxMaxXyz![0]);
                var maxY = Math.Max(p.bboxMinXyz![1], p.bboxMaxXyz![1]);
                var maxZ = Math.Max(p.bboxMinXyz![2], p.bboxMaxXyz![2]);

                try
                {
                    uiView.ZoomAndCenterRectangle(new XYZ(minX, minY, minZ), new XYZ(maxX, maxY, maxZ));
                    didZoom = true;
                }
                catch (Exception ex)
                {
                    warnings.Add($"ZoomAndCenterRectangle failed: {ex.Message}");
                }
            }
            else if ((HasBbox(p.bboxMinXyz) || HasBbox(p.bboxMaxXyz)) && uiView == null)
            {
                warnings.Add("Requested bbox zoom but no open UIView was found for the activated view.");
            }

            if (uiView != null && p.zoomToFit)
            {
                try
                {
                    uiView.ZoomToFit();
                    didZoom = true;
                }
                catch (Exception ex)
                {
                    warnings.Add($"ZoomToFit failed: {ex.Message}");
                }
            }

            return Task.FromResult<object>(new
            {
                ok = true,
                activeViewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                activeViewName = view.Name,
                requestedViewId = targetViewId,
                shownElementIds = shown,
                notShownElementIds = notShown.Distinct().ToList(),
                didZoom,
                warnings
            });
        }

        private static long ResolveTargetViewId(UIApplication app, Params p)
        {
            if (p.viewId.HasValue && p.viewId.Value > 0) return p.viewId.Value;
            if (p.targetViewId.HasValue && p.targetViewId.Value > 0) return p.targetViewId.Value;
            if (p.sheetId.HasValue && p.sheetId.Value > 0) return p.sheetId.Value;
            if (p.id.HasValue && p.id.Value > 0) return p.id.Value;
            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) return 0;

            var query = (p.viewName ?? p.query ?? string.Empty).Trim();
            if (query.Length == 0) return 0;

            var exact = p.exact ?? false;
            var requestedType = (p.viewType ?? string.Empty).Trim();
            var candidates = new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(view => !view.IsTemplate)
                .Where(view =>
                {
                    if (!string.IsNullOrWhiteSpace(requestedType) &&
                        !string.Equals(view.ViewType.ToString(), requestedType, StringComparison.OrdinalIgnoreCase))
                    {
                        return false;
                    }

                    var name = (view.Name ?? string.Empty).Trim();
                    return exact
                        ? string.Equals(name, query, StringComparison.OrdinalIgnoreCase)
                        : name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
                })
                .OrderBy(view => view.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            if (candidates.Count == 1) return ElementIdCompat.GetValue(candidates[0].Id);
            if (candidates.Count == 0) return 0;

            var sample = string.Join(", ", candidates.Take(5).Select(view => $"{view.Name} [{view.ViewType}]"));
            throw new ArgumentException(
                $"activate-view query '{query}' was ambiguous ({candidates.Count} matches). Refine with exact:true, viewType, or an explicit viewId. Sample matches: {sample}");
        }
    }
}

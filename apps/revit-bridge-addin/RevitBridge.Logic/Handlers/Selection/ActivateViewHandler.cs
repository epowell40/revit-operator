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
            OperatorViewActivationOutcome activation;
            try
            {
                activation = OperatorViewActivation.Attempt(targetViewId,
                    () => uidoc.ActiveView == null ? (long?)null : ElementIdCompat.GetValue(uidoc.ActiveView.Id),
                    () => uidoc.ActiveView = view, () => uidoc.RequestViewChange(view), IsTemporarilyDisabled);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Failed to activate view {targetViewId} ('{view.Name}'): {ex.Message}", ex);
            }
            var activationPending = activation.ActivationPending;
            if (activation.DeferredRequestAccepted)
                warnings.Add("Revit accepted a deferred view-change request; activation is confirmed only by the observed active view.");
            if (activationPending)
            {
                // Never show elements or zoom an earlier active view. Return to
                // Revit so its asynchronous view change can actually execute.
                return Task.FromResult<object>(new
                {
                    ok = true, activationPending = true,
                    focusPending = p.zoomToFit || (p.showElementIds?.Count ?? 0) > 0 || p.bboxMinXyz != null || p.bboxMaxXyz != null,
                    activeViewId = activation.ActiveViewId, activeViewName = uidoc.ActiveView?.Name,
                    requestedViewId = targetViewId, requestedViewName = view.Name,
                    shownElementIds = Array.Empty<long>(), notShownElementIds = Array.Empty<long>(), didZoom = false,
                    nextAction = "Allow Revit to process the view change, then repeat this request to confirm activation and apply the requested focus. No focus was applied yet.",
                    warnings
                });
            }

            var shown = new List<long>();
            var notShown = new List<long>();
            var scheduleFocusAssociations = new List<OperatorScheduleFocusAssociation>();
            var modelSheetFocusAssociations = new List<OperatorModelSheetFocus>();
            var directSheetFocus = new List<long>();
            var directSheetCorners = new List<XYZ>();
            if ((p.showElementIds?.Count ?? 0) > 200) throw new ArgumentException("Focus is bounded to 200 requested elements.");
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
                    var element = doc.GetElement(elementId);
                    if (element == null)
                    {
                        notShown.Add(id);
                        warnings.Add($"ShowElements skipped missing element {id}.");
                        continue;
                    }
                    if (view is ViewSheet && element is ViewSchedule schedule)
                    {
                        // The inspected schedule definition is not itself a
                        // sheet element. Resolve only its actual unique native
                        // placement on this exact sheet, never by name.
                        var association = OperatorScheduleFocusAssociation.Unique(targetViewId, id,
                            new FilteredElementCollector(doc).OfClass(typeof(ScheduleSheetInstance))
                                .Cast<ScheduleSheetInstance>()
                                .Where(instance => instance.OwnerViewId == view.Id && instance.ScheduleId == schedule.Id)
                                .Take(201).Select(instance => new OperatorScheduleFocusAssociation
                                {
                                    scheduleId = id, scheduleUniqueId = schedule.UniqueId,
                                    instanceId = ElementIdCompat.GetValue(instance.Id), instanceUniqueId = instance.UniqueId,
                                    sheetId = targetViewId, sheetUniqueId = view.UniqueId
                                }));
                        if (association == null)
                        {
                            notShown.Add(id);
                            warnings.Add($"Schedule {id} has no unique observed placement on sheet {targetViewId}; focus was not inferred.");
                            continue;
                        }
                        scheduleFocusAssociations.Add(association);
                        elementId = ElementIdCompat.Create(association.instanceId);
                    }
                    else if (view is ViewSheet sheet && !element.ViewSpecific && !(element is ElementType)
                        && element.Category?.CategoryType == CategoryType.Model)
                    {
                        var association = ModelSheetFocusObservation.Read(doc, sheet, element, warnings);
                        if (association == null)
                        {
                            notShown.Add(id);
                            warnings.Add($"Model element {id} has no unique fully observed sheet projection; no focus or visibility was inferred.");
                        }
                        else modelSheetFocusAssociations.Add(association);
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
                        var showableIds = existingIds.Distinct()
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
                            if (modelSheetFocusAssociations.Count > 0)
                            {
                                // Do not combine asynchronous ShowElements with
                                // a projected sheet zoom. Bound all direct sheet
                                // neighbors in the same sheet-coordinate frame.
                                foreach (var directId in showableIds)
                                {
                                    var box = doc.GetElement(directId)?.get_BoundingBox(view);
                                    if (box == null || !box.Enabled) { notShown.Add(ElementIdCompat.GetValue(directId)); continue; }
                                    directSheetCorners.AddRange(ModelSheetFocusObservation.Corners(box));
                                    directSheetFocus.Add(ElementIdCompat.GetValue(directId));
                                }
                            }
                            else
                            {
                                uidoc.ShowElements(showableIds);
                                shown.AddRange(showableIds.Select(RevitBridge.Common.ElementIdCompat.GetValue));
                            }
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
                // ShowElements may itself affect navigation. Never zoom the
                // requested UIView if it is no longer the displayed view.
                activationPending = uidoc.ActiveView == null || uidoc.ActiveView.Id != view.Id;
                if (!activationPending)
                    uiView = uidoc.GetOpenUIViews().FirstOrDefault(v => v.ViewId == view.Id);
                else
                    warnings.Add("The active view changed during focus; repeat activation before requesting further focus.");
            }
            catch (Exception ex)
            {
                warnings.Add($"GetOpenUIViews failed: {ex.Message}");
            }

            var didZoom = false;

            if (modelSheetFocusAssociations.Count > 0 && p.bboxMinXyz == null && p.bboxMaxXyz == null)
            {
                var points = modelSheetFocusAssociations.SelectMany(a => new[] {a.boundsMinXyz,a.boundsMaxXyz})
                    .Concat(directSheetCorners.Select(v => new[] {v.X,v.Y,0d})).ToArray();
                var minX=points.Min(v=>v[0]);var maxX=points.Max(v=>v[0]);
                var minY=points.Min(v=>v[1]);var maxY=points.Max(v=>v[1]);
                // Context margin in paper feet, not a visibility guarantee.
                var marginX=Math.Max((maxX-minX)*0.25,1d/96);var marginY=Math.Max((maxY-minY)*0.25,1d/96);
                p.bboxMinXyz=new[]{minX-marginX,minY-marginY,0d};
                p.bboxMaxXyz=new[]{maxX+marginX,maxY+marginY,0d};
            }

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

            if (uiView != null && p.zoomToFit && !activationPending)
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
            else if (p.zoomToFit && activationPending)
            {
                warnings.Add("ZoomToFit was deferred because the requested view change is pending.");
            }

            if (modelSheetFocusAssociations.Count > 0)
            {
                if (didZoom && !activationPending) shown.AddRange(directSheetFocus);
                else notShown.AddRange(modelSheetFocusAssociations.Select(a=>a.elementId).Concat(directSheetFocus));
            }

            return Task.FromResult<object>(new
            {
                ok = true,
                activationPending,
                focusPending = activationPending,
                activeViewId = uidoc.ActiveView == null ? (long?)null : ElementIdCompat.GetValue(uidoc.ActiveView.Id),
                activeViewName = uidoc.ActiveView?.Name,
                requestedViewId = targetViewId,
                requestedViewName = view.Name,
                shownElementIds = shown,
                notShownElementIds = notShown.Distinct().ToList(),
                scheduleFocusAssociations,
                modelSheetFocusAssociations,
                didZoom,
                warnings
            });
        }

        private static bool IsTemporarilyDisabled(Exception exception)
        {
            return exception.Message.IndexOf("temporarily disabled", StringComparison.OrdinalIgnoreCase) >= 0;
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

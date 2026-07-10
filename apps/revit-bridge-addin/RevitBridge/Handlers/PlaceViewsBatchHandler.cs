using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class PlaceViewsBatchHandler : IRequestHandler
    {
        public sealed class Placement
        {
            public long? sheetId { get; set; }
            public string? sheetNumber { get; set; }
            public string? sheetQuery { get; set; }
            public bool? sheetExact { get; set; }

            public long? viewId { get; set; }
            public string? viewName { get; set; }
            public string? viewQuery { get; set; }
            public bool? viewExact { get; set; }

            public double? x { get; set; }
            public double? y { get; set; }
            public bool? moveIfAlreadyPlaced { get; set; }
            public bool? avoidOverlap { get; set; }
            public bool? lockViewport { get; set; }
            public long? viewportTypeId { get; set; }
            public string? viewportTypeName { get; set; }
            public string? layoutPolicy { get; set; }
            public double? rightAnchorX { get; set; }
            public double? stackSpacingFeet { get; set; }
        }

        public sealed class Params
        {
            public List<Placement>? placements { get; set; }
            public string? behavior { get; set; } // allOrNothing|bestEffort
            public bool? dryRun { get; set; }
        }

        private sealed class ResultEntry
        {
            public int index { get; set; }
            public bool ok { get; set; }
            public long? sheetId { get; set; }
            public long? viewId { get; set; }
            public long? viewportId { get; set; }
            public long? scheduleSheetInstanceId { get; set; }
            public string? placementType { get; set; }
            public string? action { get; set; }
            public object? viewportType { get; set; }
            public object? lockViewport { get; set; }
            public object? placement { get; set; }
            public object? actualBox { get; set; }
            public string? error { get; set; }
            public double? x { get; set; }
            public double? y { get; set; }
        }

        private sealed class StackState
        {
            public SheetPlacementHelper.SheetRect? LastRect { get; set; }
        }

        private static List<SheetPlacementHelper.SheetRect>? PlannedRectsForSheet(Dictionary<long, List<SheetPlacementHelper.SheetRect>> plannedBySheet, ElementId sheetId)
        {
            var key = RevitBridge.Common.ElementIdCompat.GetValue(sheetId);
            return plannedBySheet.TryGetValue(key, out var rects) ? rects : null;
        }

        private static void AddPlannedRect(Dictionary<long, List<SheetPlacementHelper.SheetRect>> plannedBySheet, ElementId sheetId, SheetPlacementHelper.SheetRect rect)
        {
            var key = RevitBridge.Common.ElementIdCompat.GetValue(sheetId);
            if (!plannedBySheet.TryGetValue(key, out var rects))
            {
                rects = new List<SheetPlacementHelper.SheetRect>();
                plannedBySheet[key] = rects;
            }
            rects.Add(rect);
        }

        private static StackState? StackStateForPlacement(Dictionary<string, StackState> stackStates, ElementId sheetId, Placement placement)
        {
            var policy = (placement.layoutPolicy ?? "").Trim();
            if (!policy.Equals("right_justified_vertical_stack", StringComparison.OrdinalIgnoreCase) &&
                !policy.Equals("right-justified-vertical-stack", StringComparison.OrdinalIgnoreCase) &&
                !placement.rightAnchorX.HasValue &&
                !placement.stackSpacingFeet.HasValue)
            {
                return null;
            }

            var key = $"{RevitBridge.Common.ElementIdCompat.GetValue(sheetId)}:right_justified_vertical_stack";
            if (!stackStates.TryGetValue(key, out var state))
            {
                state = new StackState();
                stackStates[key] = state;
            }
            return state;
        }

        private static double? StackedYOverride(StackState? state, Placement placement)
        {
            if (state?.LastRect == null) return placement.y;
            var spacing = placement.stackSpacingFeet ?? (1.0 / 12.0);
            return state.LastRect.MinY - spacing;
        }

        private static object? BoxObject(SheetPlacementHelper.SheetRect? rect)
        {
            if (rect == null) return null;
            return new
            {
                minU = rect.MinX,
                minV = rect.MinY,
                maxU = rect.MaxX,
                maxV = rect.MaxY
            };
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var placements = (p.placements ?? new List<Placement>()).Where(x => x != null).ToList();
            if (placements.Count == 0) throw new InvalidOperationException("place-views.placements is required and must be a non-empty array.");
            if (placements.Count > 200) throw new InvalidOperationException("place-views.placements too large (max 200).");

            var dryRun = p.dryRun ?? false;
            var behavior = (p.behavior ?? "bestEffort").Trim();
            var allOrNothing = behavior.Equals("allOrNothing", StringComparison.OrdinalIgnoreCase);

            var results = new List<ResultEntry>(capacity: placements.Count);

            if (dryRun)
            {
                var plannedScheduleRectsBySheet = new Dictionary<long, List<SheetPlacementHelper.SheetRect>>();
                var stackStatesBySheet = new Dictionary<string, StackState>();
                for (int i = 0; i < placements.Count; i++)
                {
                    var pl = placements[i];
                    var resolvedSheet = SheetPlacementHelper.ResolveSheet(doc, pl.sheetId, pl.sheetNumber, pl.sheetQuery, pl.sheetExact ?? false);
                    var resolvedView = SheetPlacementHelper.ResolveView(doc, pl.viewId, pl.viewName, pl.viewQuery, pl.viewExact ?? false);
                    var x = pl.x ?? 0;
                    var y = pl.y ?? 0;
                    var moveIfAlreadyPlaced = pl.moveIfAlreadyPlaced ?? false;
                    var coordinatesRequested = pl.x.HasValue || pl.y.HasValue;

                    if (resolvedSheet == null || resolvedView == null)
                    {
                        results.Add(new ResultEntry
                        {
                            index = i,
                            ok = false,
                            placementType = null,
                            x = x,
                            y = y,
                            error = resolvedSheet == null
                                ? "Sheet not found. Provide sheetId, sheetNumber, or sheetQuery."
                                : "View not found. Provide viewId, viewName, or viewQuery."
                        });
                        continue;
                    }

                    var sheetId = resolvedSheet.Id;
                    var viewId = resolvedView.Id;
                    var view = resolvedView;
                    var isRegularSchedule = view is ViewSchedule;
                    var isPanelSchedule = SheetPlacementHelper.IsPanelScheduleView(view);
                    var isSchedule = isRegularSchedule || isPanelSchedule;
                    var avoidOverlap = pl.avoidOverlap ?? (isSchedule && !coordinatesRequested);
                    var existingViewport = isSchedule ? null : SheetPlacementHelper.FindViewportOnSheet(doc, sheetId, viewId);
                    var existingSchedule = isRegularSchedule ? SheetPlacementHelper.FindScheduleInstanceOnSheet(doc, sheetId, viewId) : null;
                    var existingPanelSchedule = isPanelSchedule ? SheetPlacementHelper.FindPanelScheduleInstanceOnSheet(doc, sheetId, viewId) : null;
                    var stackState = isSchedule ? StackStateForPlacement(stackStatesBySheet, sheetId, pl) : null;
                    var requestedY = StackedYOverride(stackState, pl);
                    var otherScheduleInstances = isRegularSchedule
                        ? SheetPlacementHelper.FindScheduleInstances(doc, viewId).Where(ssi => ssi.OwnerViewId != sheetId).ToList()
                        : new List<ScheduleSheetInstance>();
                    var otherPanelInstances = isPanelSchedule
                        ? SheetPlacementHelper.FindPanelScheduleInstances(doc, viewId).Where(ssi => ssi.OwnerViewId != sheetId).ToList()
                        : new List<PanelScheduleSheetInstance>();
                    var schedulePlacement = isSchedule
                        ? SheetPlacementHelper.ResolveSchedulePlacementPoint(
                            doc,
                            resolvedSheet,
                            viewId,
                            pl.x,
                            requestedY,
                            avoidOverlap,
                            (Element?)existingSchedule ?? existingPanelSchedule ?? otherScheduleInstances.Cast<Element>().Concat(otherPanelInstances.Cast<Element>()).FirstOrDefault(),
                            existingSchedule?.Id ?? existingPanelSchedule?.Id,
                            PlannedRectsForSheet(plannedScheduleRectsBySheet, sheetId))
                        : null;
                    var can = isRegularSchedule
                        ? ((existingSchedule == null && (otherScheduleInstances.Count == 0 || moveIfAlreadyPlaced) && SheetPlacementHelper.CanPlaceScheduleOnSheet(doc, sheetId, viewId)) ||
                           (existingSchedule != null && moveIfAlreadyPlaced))
                        : isPanelSchedule
                            ? ((existingPanelSchedule == null && (otherPanelInstances.Count == 0 || moveIfAlreadyPlaced)) ||
                               (existingPanelSchedule != null && moveIfAlreadyPlaced))
                            : ((existingViewport == null && Viewport.CanAddViewToSheet(doc, sheetId, viewId)) ||
                               (existingViewport != null && moveIfAlreadyPlaced));

                    var viewportTypeRequested = !isSchedule && (pl.viewportTypeId.HasValue || !string.IsNullOrWhiteSpace(pl.viewportTypeName));
                    ElementId? resolvedViewportTypeId = null;
                    string? resolvedViewportTypeName = null;
                    bool? viewportTypeResolved = null;
                    if (viewportTypeRequested)
                    {
                        viewportTypeResolved = SheetPlacementHelper.TryResolveViewportType(doc, existingViewport, pl.viewportTypeId, pl.viewportTypeName, out resolvedViewportTypeId, out resolvedViewportTypeName);
                    }

                    results.Add(new ResultEntry
                    {
                        index = i,
                        ok = can,
                        sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                        placementType = isPanelSchedule ? "PanelScheduleSheetInstance" : isRegularSchedule ? "ScheduleSheetInstance" : "Viewport",
                        action = (!isSchedule && existingViewport != null && moveIfAlreadyPlaced) ||
                                 (isRegularSchedule && (existingSchedule != null || otherScheduleInstances.Count > 0) && moveIfAlreadyPlaced) ||
                                 (isPanelSchedule && (existingPanelSchedule != null || otherPanelInstances.Count > 0) && moveIfAlreadyPlaced)
                            ? "MoveExisting"
                            : "Create",
                        x = schedulePlacement?.Point.X ?? x,
                        y = schedulePlacement?.Point.Y ?? y,
                        placement = schedulePlacement == null ? null : new { avoidOverlap, strategy = schedulePlacement.Strategy, box = schedulePlacement.PreviewBox },
                        viewportType = viewportTypeRequested
                            ? new
                            {
                                requested = new { pl.viewportTypeId, pl.viewportTypeName },
                                resolved = viewportTypeResolved,
                                typeId = resolvedViewportTypeId == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(resolvedViewportTypeId),
                                typeName = resolvedViewportTypeName
                            }
                            : null,
                        lockViewport = (!isSchedule && pl.lockViewport.HasValue) ? new { requested = pl.lockViewport.Value } : null,
                        error = can ? null : "Cannot place or move view on sheet (already placed or invalid sheet/view)."
                    });
                    if (can && schedulePlacement != null)
                    {
                        var plannedRect = SheetPlacementHelper.PlacementPreviewRect(schedulePlacement);
                        AddPlannedRect(plannedScheduleRectsBySheet, sheetId, plannedRect);
                        if (stackState != null)
                        {
                            stackState.LastRect = plannedRect;
                        }
                    }
                }

                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    behavior = allOrNothing ? "allOrNothing" : "bestEffort",
                    requestedCount = placements.Count,
                    results
                });
            }

            using (var t = new Transaction(doc, "Place Views (Batch)"))
            {
                t.Start();
                var plannedScheduleRectsBySheet = new Dictionary<long, List<SheetPlacementHelper.SheetRect>>();
                var stackStatesBySheet = new Dictionary<string, StackState>();
                for (int i = 0; i < placements.Count; i++)
                {
                    var pl = placements[i];
                    var resolvedSheet = SheetPlacementHelper.ResolveSheet(doc, pl.sheetId, pl.sheetNumber, pl.sheetQuery, pl.sheetExact ?? false);
                    var resolvedView = SheetPlacementHelper.ResolveView(doc, pl.viewId, pl.viewName, pl.viewQuery, pl.viewExact ?? false);
                    var x = pl.x ?? 0;
                    var y = pl.y ?? 0;
                    var moveIfAlreadyPlaced = pl.moveIfAlreadyPlaced ?? false;
                    var coordinatesRequested = pl.x.HasValue || pl.y.HasValue;
                    if (resolvedSheet == null || resolvedView == null)
                    {
                        results.Add(new ResultEntry
                        {
                            index = i,
                            ok = false,
                            x = x,
                            y = y,
                            error = resolvedSheet == null
                                ? "Sheet not found. Provide sheetId, sheetNumber, or sheetQuery."
                                : "View not found. Provide viewId, viewName, or viewQuery."
                        });
                        if (allOrNothing)
                        {
                            t.RollBack();
                            return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                        }
                        continue;
                    }

                    var sheetId = resolvedSheet.Id;
                    var viewId = resolvedView.Id;
                    var view = resolvedView;
                    var isRegularSchedule = view is ViewSchedule;
                    var isPanelSchedule = SheetPlacementHelper.IsPanelScheduleView(view);
                    var isSchedule = isRegularSchedule || isPanelSchedule;
                    var avoidOverlap = pl.avoidOverlap ?? (isSchedule && !coordinatesRequested);

                    try
                    {
                        if (isRegularSchedule)
                        {
                            var existingSchedule = SheetPlacementHelper.FindScheduleInstanceOnSheet(doc, sheetId, viewId);
                            var otherInstances = SheetPlacementHelper.FindScheduleInstances(doc, viewId)
                                .Where(ssi => ssi.OwnerViewId != sheetId)
                                .ToList();
                            var stackState = StackStateForPlacement(stackStatesBySheet, sheetId, pl);
                            var requestedY = StackedYOverride(stackState, pl);
                            var placement = SheetPlacementHelper.ResolveSchedulePlacementPoint(doc, resolvedSheet, viewId, pl.x, requestedY, avoidOverlap, existingSchedule ?? otherInstances.FirstOrDefault(), existingSchedule?.Id, PlannedRectsForSheet(plannedScheduleRectsBySheet, sheetId));
                            if (existingSchedule != null)
                            {
                                if (!moveIfAlreadyPlaced)
                                {
                                    results.Add(new ResultEntry
                                    {
                                        index = i,
                                        ok = false,
                                        sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                    placementType = "ScheduleSheetInstance",
                                    action = "Create",
                                    x = placement.Point.X,
                                    y = placement.Point.Y,
                                    placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox },
                                    error = "Schedule is already placed on this sheet. Set moveIfAlreadyPlaced=true to reposition it."
                                });
                                    if (allOrNothing)
                                    {
                                        t.RollBack();
                                        return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                                    }
                                    continue;
                                }

                                existingSchedule.Point = placement.Point;
                                doc.Regenerate();
                                var actualRect = SheetPlacementHelper.TryGetSheetRect(existingSchedule, resolvedSheet);
                                var plannedRect = actualRect ?? SheetPlacementHelper.PlacementPreviewRect(placement);
                                AddPlannedRect(plannedScheduleRectsBySheet, sheetId, plannedRect);
                                if (stackState != null)
                                {
                                    stackState.LastRect = plannedRect;
                                }
                                results.Add(new ResultEntry
                                {
                                    index = i,
                                    ok = true,
                                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                    scheduleSheetInstanceId = RevitBridge.Common.ElementIdCompat.GetValue(existingSchedule.Id),
                                    placementType = "ScheduleSheetInstance",
                                    action = "MoveExisting",
                                    x = placement.Point.X,
                                    y = placement.Point.Y,
                                    placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox },
                                    actualBox = BoxObject(actualRect)
                                });
                                continue;
                            }

                            if (otherInstances.Count > 0 && moveIfAlreadyPlaced)
                            {
                                foreach (var other in otherInstances)
                                {
                                    doc.Delete(other.Id);
                                }
                            }

                            if (!SheetPlacementHelper.CanPlaceScheduleOnSheet(doc, sheetId, viewId))
                            {
                                results.Add(new ResultEntry
                                {
                                    index = i,
                                    ok = false,
                                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                    placementType = "ScheduleSheetInstance",
                                    action = "Create",
                                    x = placement.Point.X,
                                    y = placement.Point.Y,
                                    placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox },
                                    error = "Cannot place schedule on sheet (already placed or invalid sheet/view)."
                                });
                                if (allOrNothing)
                                {
                                    t.RollBack();
                                    return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                                }
                                continue;
                            }

                            var ssi = ScheduleSheetInstance.Create(doc, sheetId, viewId, placement.Point);
                            doc.Regenerate();
                            var createdActualRect = SheetPlacementHelper.TryGetSheetRect(ssi, resolvedSheet);
                            var createdPlannedRect = createdActualRect ?? SheetPlacementHelper.PlacementPreviewRect(placement);
                            AddPlannedRect(plannedScheduleRectsBySheet, sheetId, createdPlannedRect);
                            if (stackState != null)
                            {
                                stackState.LastRect = createdPlannedRect;
                            }
                            results.Add(new ResultEntry
                            {
                                index = i,
                                ok = true,
                                sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                scheduleSheetInstanceId = RevitBridge.Common.ElementIdCompat.GetValue(ssi.Id),
                                placementType = "ScheduleSheetInstance",
                                action = otherInstances.Count > 0 && moveIfAlreadyPlaced ? "MoveExisting" : "Create",
                                x = placement.Point.X,
                                y = placement.Point.Y,
                                placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox },
                                actualBox = BoxObject(createdActualRect)
                            });
                            continue;
                        }

                        if (isPanelSchedule)
                        {
                            var existingPanelSchedule = SheetPlacementHelper.FindPanelScheduleInstanceOnSheet(doc, sheetId, viewId);
                            var otherInstances = SheetPlacementHelper.FindPanelScheduleInstances(doc, viewId)
                                .Where(ssi => ssi.OwnerViewId != sheetId)
                                .ToList();
                            var stackState = StackStateForPlacement(stackStatesBySheet, sheetId, pl);
                            var requestedY = StackedYOverride(stackState, pl);
                            var placement = SheetPlacementHelper.ResolveSchedulePlacementPoint(doc, resolvedSheet, viewId, pl.x, requestedY, avoidOverlap, existingPanelSchedule ?? otherInstances.FirstOrDefault(), existingPanelSchedule?.Id, PlannedRectsForSheet(plannedScheduleRectsBySheet, sheetId));

                            if (existingPanelSchedule != null)
                            {
                                if (!moveIfAlreadyPlaced)
                                {
                                    results.Add(new ResultEntry
                                    {
                                        index = i,
                                        ok = false,
                                        sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                        placementType = "PanelScheduleSheetInstance",
                                        action = "Create",
                                        x = placement.Point.X,
                                        y = placement.Point.Y,
                                        placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox },
                                        error = "Panel schedule is already placed on this sheet. Set moveIfAlreadyPlaced=true to reposition it."
                                    });
                                    if (allOrNothing)
                                    {
                                        t.RollBack();
                                        return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                                    }
                                    continue;
                                }

                                existingPanelSchedule.Origin = placement.Point;
                                doc.Regenerate();
                                var actualRect = SheetPlacementHelper.TryGetSheetRect(existingPanelSchedule, resolvedSheet);
                                var plannedRect = actualRect ?? SheetPlacementHelper.PlacementPreviewRect(placement);
                                AddPlannedRect(plannedScheduleRectsBySheet, sheetId, plannedRect);
                                if (stackState != null)
                                {
                                    stackState.LastRect = plannedRect;
                                }
                                results.Add(new ResultEntry
                                {
                                    index = i,
                                    ok = true,
                                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                    scheduleSheetInstanceId = RevitBridge.Common.ElementIdCompat.GetValue(existingPanelSchedule.Id),
                                    placementType = "PanelScheduleSheetInstance",
                                    action = "MoveExisting",
                                    x = placement.Point.X,
                                    y = placement.Point.Y,
                                    placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox },
                                    actualBox = BoxObject(actualRect)
                                });
                                continue;
                            }

                            if (otherInstances.Count > 0)
                            {
                                if (!moveIfAlreadyPlaced)
                                {
                                    results.Add(new ResultEntry
                                    {
                                        index = i,
                                        ok = false,
                                        sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                        placementType = "PanelScheduleSheetInstance",
                                        action = "Create",
                                        x = placement.Point.X,
                                        y = placement.Point.Y,
                                        placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox },
                                        error = "Panel schedule is already placed on another sheet. Set moveIfAlreadyPlaced=true to move it."
                                    });
                                    if (allOrNothing)
                                    {
                                        t.RollBack();
                                        return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                                    }
                                    continue;
                                }

                                foreach (var other in otherInstances)
                                {
                                    doc.Delete(other.Id);
                                }
                            }

                            var psi = PanelScheduleSheetInstance.Create(doc, viewId, resolvedSheet);
                            psi.Origin = placement.Point;
                            doc.Regenerate();
                            var createdActualRect = SheetPlacementHelper.TryGetSheetRect(psi, resolvedSheet);
                            var createdPlannedRect = createdActualRect ?? SheetPlacementHelper.PlacementPreviewRect(placement);
                            AddPlannedRect(plannedScheduleRectsBySheet, sheetId, createdPlannedRect);
                            if (stackState != null)
                            {
                                stackState.LastRect = createdPlannedRect;
                            }
                            results.Add(new ResultEntry
                            {
                                index = i,
                                ok = true,
                                sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                scheduleSheetInstanceId = RevitBridge.Common.ElementIdCompat.GetValue(psi.Id),
                                placementType = "PanelScheduleSheetInstance",
                                action = otherInstances.Count > 0 && moveIfAlreadyPlaced ? "MoveExisting" : "Create",
                                x = placement.Point.X,
                                y = placement.Point.Y,
                                placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox },
                                actualBox = BoxObject(createdActualRect)
                            });
                            continue;
                        }

                        var existingViewport = SheetPlacementHelper.FindViewportOnSheet(doc, sheetId, viewId);
                        Viewport viewport;
                        string action;
                        if (existingViewport != null)
                        {
                            if (!moveIfAlreadyPlaced)
                            {
                                results.Add(new ResultEntry
                                {
                                    index = i,
                                    ok = false,
                                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                    placementType = "Viewport",
                                    action = "Create",
                                    x = x,
                                    y = y,
                                    error = "View is already placed on this sheet. Set moveIfAlreadyPlaced=true to reposition it."
                                });
                                if (allOrNothing)
                                {
                                    t.RollBack();
                                    return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                                }
                                continue;
                            }

                            viewport = existingViewport;
                            if (!SheetPlacementHelper.TrySetViewportCenter(viewport, x, y, out var moveReason))
                            {
                                results.Add(new ResultEntry
                                {
                                    index = i,
                                    ok = false,
                                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                    placementType = "Viewport",
                                    action = "MoveExisting",
                                    x = x,
                                    y = y,
                                    error = moveReason ?? "Unable to move viewport."
                                });
                                if (allOrNothing)
                                {
                                    t.RollBack();
                                    return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                                }
                                continue;
                            }

                            action = "MoveExisting";
                        }
                        else
                        {
                            if (!Viewport.CanAddViewToSheet(doc, sheetId, viewId))
                            {
                                results.Add(new ResultEntry
                                {
                                    index = i,
                                    ok = false,
                                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                    placementType = "Viewport",
                                    action = "Create",
                                    x = x,
                                    y = y,
                                    error = "Cannot place view on sheet (already placed or invalid sheet/view)."
                                });
                                if (allOrNothing)
                                {
                                    t.RollBack();
                                    return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                                }
                                continue;
                            }

                            viewport = Viewport.Create(doc, sheetId, viewId, new XYZ(x, y, 0));
                            action = "Create";
                        }

                        var typeRequested = pl.viewportTypeId.HasValue || !string.IsNullOrWhiteSpace(pl.viewportTypeName);
                        bool? typeApplied = null;
                        string? typeMessage = null;
                        ElementId? resolvedViewportTypeId = null;
                        string? resolvedViewportTypeName = null;
                        if (typeRequested)
                        {
                            var typeResolved = SheetPlacementHelper.TryResolveViewportType(doc, viewport, pl.viewportTypeId, pl.viewportTypeName, out resolvedViewportTypeId, out resolvedViewportTypeName);
                            if (!typeResolved || resolvedViewportTypeId == null)
                            {
                                typeApplied = false;
                                typeMessage = "Viewport type not found.";
                            }
                            else
                            {
                                typeApplied = SheetPlacementHelper.TryApplyViewportType(viewport, resolvedViewportTypeId, out typeMessage);
                            }
                        }

                        bool? lockApplied = null;
                        string? lockMessage = null;
                        if (pl.lockViewport.HasValue)
                        {
                            lockApplied = SheetPlacementHelper.TrySetViewportLock(viewport, pl.lockViewport.Value, out lockMessage);
                        }

                        results.Add(new ResultEntry
                        {
                            index = i,
                            ok = true,
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                            viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                            viewportId = RevitBridge.Common.ElementIdCompat.GetValue(viewport.Id),
                            placementType = "Viewport",
                            action = action,
                            x = x,
                            y = y,
                            viewportType = typeRequested
                                ? new
                                {
                                    requested = new { pl.viewportTypeId, pl.viewportTypeName },
                                    typeId = resolvedViewportTypeId == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(resolvedViewportTypeId),
                                    typeName = resolvedViewportTypeName,
                                    applied = typeApplied,
                                    message = typeMessage
                                }
                                : null,
                            lockViewport = pl.lockViewport.HasValue
                                ? new { requested = pl.lockViewport.Value, applied = lockApplied, message = lockMessage, current = viewport.Pinned }
                                : null
                        });
                    }
                    catch (Exception ex)
                    {
                        results.Add(new ResultEntry
                        {
                            index = i,
                            ok = false,
                            sheetId = resolvedSheet == null ? null : RevitBridge.Common.ElementIdCompat.GetValue(resolvedSheet.Id),
                            viewId = resolvedView == null ? null : RevitBridge.Common.ElementIdCompat.GetValue(resolvedView.Id),
                            placementType = isSchedule ? "ScheduleSheetInstance" : "Viewport",
                            x = x,
                            y = y,
                            error = ex.Message
                        });
                        if (allOrNothing)
                        {
                            t.RollBack();
                            return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                        }
                    }
                }

                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                behavior = allOrNothing ? "allOrNothing" : "bestEffort",
                requestedCount = placements.Count,
                placedCount = results.Count(x => x.ok),
                results
            });
        }
    }
}


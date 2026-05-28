using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
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
            public bool? lockViewport { get; set; }
            public long? viewportTypeId { get; set; }
            public string? viewportTypeName { get; set; }
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
            public string? error { get; set; }
            public double? x { get; set; }
            public double? y { get; set; }
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
                for (int i = 0; i < placements.Count; i++)
                {
                    var pl = placements[i];
                    var resolvedSheet = SheetPlacementHelper.ResolveSheet(doc, pl.sheetId, pl.sheetNumber, pl.sheetQuery, pl.sheetExact ?? false);
                    var resolvedView = SheetPlacementHelper.ResolveView(doc, pl.viewId, pl.viewName, pl.viewQuery, pl.viewExact ?? false);
                    var x = pl.x ?? 0;
                    var y = pl.y ?? 0;
                    var moveIfAlreadyPlaced = pl.moveIfAlreadyPlaced ?? false;

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
                    var isSchedule = view is ViewSchedule;
                    var existingViewport = isSchedule ? null : SheetPlacementHelper.FindViewportOnSheet(doc, sheetId, viewId);
                    var existingSchedule = isSchedule ? SheetPlacementHelper.FindScheduleInstanceOnSheet(doc, sheetId, viewId) : null;
                    var can = isSchedule
                        ? ((existingSchedule == null && SheetPlacementHelper.CanPlaceScheduleOnSheet(doc, sheetId, viewId)) ||
                           (existingSchedule != null && moveIfAlreadyPlaced))
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
                        placementType = isSchedule ? "ScheduleSheetInstance" : "Viewport",
                        action = (!isSchedule && existingViewport != null && moveIfAlreadyPlaced) || (isSchedule && existingSchedule != null && moveIfAlreadyPlaced)
                            ? "MoveExisting"
                            : "Create",
                        x = x,
                        y = y,
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
                for (int i = 0; i < placements.Count; i++)
                {
                    var pl = placements[i];
                    var resolvedSheet = SheetPlacementHelper.ResolveSheet(doc, pl.sheetId, pl.sheetNumber, pl.sheetQuery, pl.sheetExact ?? false);
                    var resolvedView = SheetPlacementHelper.ResolveView(doc, pl.viewId, pl.viewName, pl.viewQuery, pl.viewExact ?? false);
                    var x = pl.x ?? 0;
                    var y = pl.y ?? 0;
                    var moveIfAlreadyPlaced = pl.moveIfAlreadyPlaced ?? false;
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
                    var isSchedule = view is ViewSchedule;

                    try
                    {
                        if (isSchedule)
                        {
                            var existingSchedule = SheetPlacementHelper.FindScheduleInstanceOnSheet(doc, sheetId, viewId);
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
                                        x = x,
                                        y = y,
                                        error = "Schedule is already placed on this sheet. Set moveIfAlreadyPlaced=true to reposition it."
                                    });
                                    if (allOrNothing)
                                    {
                                        t.RollBack();
                                        return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                                    }
                                    continue;
                                }

                                existingSchedule.Point = new XYZ(x, y, 0);
                                results.Add(new ResultEntry
                                {
                                    index = i,
                                    ok = true,
                                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                    scheduleSheetInstanceId = RevitBridge.Common.ElementIdCompat.GetValue(existingSchedule.Id),
                                    placementType = "ScheduleSheetInstance",
                                    action = "MoveExisting",
                                    x = x,
                                    y = y
                                });
                                continue;
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
                                    x = x,
                                    y = y,
                                    error = "Cannot place schedule on sheet (already placed or invalid sheet/view)."
                                });
                                if (allOrNothing)
                                {
                                    t.RollBack();
                                    return Task.FromResult<object>(new { status = "Failed", dryRun = false, behavior = "allOrNothing", requestedCount = placements.Count, results });
                                }
                                continue;
                            }

                            var ssi = ScheduleSheetInstance.Create(doc, sheetId, viewId, new XYZ(x, y, 0));
                            results.Add(new ResultEntry
                            {
                                index = i,
                                ok = true,
                                sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                scheduleSheetInstanceId = RevitBridge.Common.ElementIdCompat.GetValue(ssi.Id),
                                placementType = "ScheduleSheetInstance",
                                action = "Create",
                                x = x,
                                y = y
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


using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class PlaceViewOnSheetHandler : IRequestHandler
    {
        public class Params
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
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var dryRun = p?.dryRun ?? false;
            var x = p?.x ?? 0;
            var y = p?.y ?? 0;
            var moveIfAlreadyPlaced = p?.moveIfAlreadyPlaced ?? false;
            var coordinatesRequested = p?.x.HasValue == true || p?.y.HasValue == true;

            var sheet = SheetPlacementHelper.ResolveSheet(doc, p?.sheetId, p?.sheetNumber, p?.sheetQuery, p?.sheetExact ?? false);
            if (sheet == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "Failed",
                    message = "Sheet not found. Provide sheetId, sheetNumber, or sheetQuery."
                });
            }

            var view = SheetPlacementHelper.ResolveView(doc, p?.viewId, p?.viewName, p?.viewQuery, p?.viewExact ?? false);
            if (view == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "Failed",
                    message = "View not found. Provide viewId, viewName, or viewQuery."
                });
            }

            var sheetId = sheet.Id;
            var viewId = view.Id;

            var isRegularSchedule = view is ViewSchedule;
            var isPanelSchedule = SheetPlacementHelper.IsPanelScheduleView(view);
            var isSchedule = isRegularSchedule || isPanelSchedule;
            var avoidOverlap = p?.avoidOverlap ?? (isSchedule && !coordinatesRequested);
            var existingViewport = isSchedule ? null : SheetPlacementHelper.FindViewportOnSheet(doc, sheetId, viewId);
            var existingSchedule = isRegularSchedule ? SheetPlacementHelper.FindScheduleInstanceOnSheet(doc, sheetId, viewId) : null;
            var existingPanelSchedule = isPanelSchedule ? SheetPlacementHelper.FindPanelScheduleInstanceOnSheet(doc, sheetId, viewId) : null;
            var viewportTypeRequested = p?.viewportTypeId.HasValue == true || !string.IsNullOrWhiteSpace(p?.viewportTypeName);

            if (dryRun)
            {
                if (isRegularSchedule)
                {
                    var otherInstances = SheetPlacementHelper.FindScheduleInstances(doc, viewId)
                        .Where(ssi => ssi.OwnerViewId != sheetId)
                        .ToList();
                    var canCreate = existingSchedule == null && SheetPlacementHelper.CanPlaceScheduleOnSheet(doc, sheetId, viewId);
                    var canMove = existingSchedule != null && moveIfAlreadyPlaced;
                    var canMoveFromOtherSheet = existingSchedule == null && otherInstances.Count > 0 && moveIfAlreadyPlaced;
                    var canPlace = canCreate || canMove || canMoveFromOtherSheet;
                    var placement = SheetPlacementHelper.ResolveSchedulePlacementPoint(doc, sheet, viewId, p?.x, p?.y, avoidOverlap, existingSchedule ?? otherInstances.FirstOrDefault(), existingSchedule?.Id);
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        dryRun = true,
                        placementType = "ScheduleSheetInstance",
                        canPlace,
                        action = canMove || canMoveFromOtherSheet ? "MoveExisting" : "Create",
                        sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                        existingScheduleSheetInstanceId = existingSchedule == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(existingSchedule.Id),
                        existingOtherSheetInstanceIds = otherInstances.Select(ssi => RevitBridge.Common.ElementIdCompat.GetValue(ssi.Id)).ToList(),
                        x = placement.Point.X,
                        y = placement.Point.Y,
                        placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox },
                        reason = canPlace ? null : "Schedule is already placed on this sheet. Set moveIfAlreadyPlaced=true to reposition it."
                    });
                }

                if (isPanelSchedule)
                {
                    var otherInstances = SheetPlacementHelper.FindPanelScheduleInstances(doc, viewId)
                        .Where(ssi => ssi.OwnerViewId != sheetId)
                        .ToList();
                    var canMove = existingPanelSchedule != null && moveIfAlreadyPlaced;
                    var canCreate = existingPanelSchedule == null && (otherInstances.Count == 0 || moveIfAlreadyPlaced);
                    var placement = SheetPlacementHelper.ResolveSchedulePlacementPoint(doc, sheet, viewId, p?.x, p?.y, avoidOverlap, existingPanelSchedule ?? otherInstances.FirstOrDefault(), existingPanelSchedule?.Id);
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        dryRun = true,
                        placementType = "PanelScheduleSheetInstance",
                        canPlace = canCreate || canMove,
                        action = canMove || (otherInstances.Count > 0 && moveIfAlreadyPlaced) ? "MoveExisting" : "Create",
                        sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                        existingPanelScheduleSheetInstanceId = existingPanelSchedule == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(existingPanelSchedule.Id),
                        existingOtherSheetInstanceIds = otherInstances.Select(ssi => RevitBridge.Common.ElementIdCompat.GetValue(ssi.Id)).ToList(),
                        x = placement.Point.X,
                        y = placement.Point.Y,
                        placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox },
                        reason = canCreate || canMove ? null : "Panel schedule is already placed on another sheet. Set moveIfAlreadyPlaced=true to move it."
                    });
                }

                var canCreateViewport = existingViewport == null && Viewport.CanAddViewToSheet(doc, sheetId, viewId);
                var canMoveViewport = existingViewport != null && moveIfAlreadyPlaced;
                var canPlaceViewport = canCreateViewport || canMoveViewport;
                ElementId? resolvedViewportTypeId = null;
                string? resolvedViewportTypeName = null;
                var viewportTypeResolved = !viewportTypeRequested || SheetPlacementHelper.TryResolveViewportType(doc, existingViewport, p?.viewportTypeId, p?.viewportTypeName, out resolvedViewportTypeId, out resolvedViewportTypeName);

                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    placementType = "Viewport",
                    canPlace = canPlaceViewport,
                    action = canMoveViewport ? "MoveExisting" : "Create",
                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                    existingViewportId = existingViewport == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(existingViewport.Id),
                    x,
                    y,
                    lockViewport = p?.lockViewport,
                    viewportType = viewportTypeRequested
                        ? new
                        {
                            requested = new { p?.viewportTypeId, p?.viewportTypeName },
                            resolved = viewportTypeResolved,
                            typeId = resolvedViewportTypeId == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(resolvedViewportTypeId),
                            typeName = resolvedViewportTypeName
                        }
                        : null,
                    reason = canPlaceViewport ? null : "View is already placed on this sheet. Set moveIfAlreadyPlaced=true to reposition it."
                });
            }

            try
            {
                using (Transaction trans = new Transaction(doc, "Place View on Sheet"))
                {
                    trans.Start();

                    if (isRegularSchedule)
                    {
                        var otherInstances = SheetPlacementHelper.FindScheduleInstances(doc, viewId)
                            .Where(ssi => ssi.OwnerViewId != sheetId)
                            .ToList();
                        var sample = (Element?)existingSchedule ?? otherInstances.FirstOrDefault();
                        var placement = SheetPlacementHelper.ResolveSchedulePlacementPoint(doc, sheet, viewId, p?.x, p?.y, avoidOverlap, sample, existingSchedule?.Id);

                        if (existingSchedule != null)
                        {
                            if (!moveIfAlreadyPlaced)
                            {
                                trans.RollBack();
                                return Task.FromResult<object>(new
                                {
                                    status = "AlreadyPlaced",
                                    placementType = "ScheduleSheetInstance",
                                    id = RevitBridge.Common.ElementIdCompat.GetValue(existingSchedule.Id),
                                    message = "Schedule is already placed on this sheet. Set moveIfAlreadyPlaced=true to reposition it."
                                });
                            }

                            existingSchedule.Point = placement.Point;
                            trans.Commit();
                            return Task.FromResult<object>(new
                            {
                                status = "Moved",
                                action = "MoveExisting",
                                placementType = "ScheduleSheetInstance",
                                id = RevitBridge.Common.ElementIdCompat.GetValue(existingSchedule.Id),
                                sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                x = placement.Point.X,
                                y = placement.Point.Y,
                                placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox }
                            });
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
                            trans.RollBack();
                            return Task.FromResult<object>(new { status = "Failed", placementType = "ScheduleSheetInstance", message = "Cannot place schedule on sheet." });
                        }

                        var ssi = ScheduleSheetInstance.Create(doc, sheetId, viewId, placement.Point);
                        trans.Commit();
                        return Task.FromResult<object>(new
                        {
                            id = RevitBridge.Common.ElementIdCompat.GetValue(ssi.Id),
                            status = "Placed",
                            action = "Create",
                            placementType = "ScheduleSheetInstance",
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                            viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                            x = placement.Point.X,
                            y = placement.Point.Y,
                            placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox }
                        });
                    }

                    if (isPanelSchedule)
                    {
                        var otherInstances = SheetPlacementHelper.FindPanelScheduleInstances(doc, viewId)
                            .Where(ssi => ssi.OwnerViewId != sheetId)
                            .ToList();
                        var sample = (Element?)existingPanelSchedule ?? otherInstances.FirstOrDefault();
                        var placement = SheetPlacementHelper.ResolveSchedulePlacementPoint(doc, sheet, viewId, p?.x, p?.y, avoidOverlap, sample, existingPanelSchedule?.Id);

                        if (existingPanelSchedule != null)
                        {
                            if (!moveIfAlreadyPlaced)
                            {
                                trans.RollBack();
                                return Task.FromResult<object>(new
                                {
                                    status = "AlreadyPlaced",
                                    placementType = "PanelScheduleSheetInstance",
                                    id = RevitBridge.Common.ElementIdCompat.GetValue(existingPanelSchedule.Id),
                                    message = "Panel schedule is already placed on this sheet. Set moveIfAlreadyPlaced=true to reposition it."
                                });
                            }

                            existingPanelSchedule.Origin = placement.Point;
                            trans.Commit();
                            return Task.FromResult<object>(new
                            {
                                status = "Moved",
                                action = "MoveExisting",
                                placementType = "PanelScheduleSheetInstance",
                                id = RevitBridge.Common.ElementIdCompat.GetValue(existingPanelSchedule.Id),
                                sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                x = placement.Point.X,
                                y = placement.Point.Y,
                                placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox }
                            });
                        }

                        if (otherInstances.Count > 0)
                        {
                            if (!moveIfAlreadyPlaced)
                            {
                                trans.RollBack();
                                return Task.FromResult<object>(new
                                {
                                    status = "AlreadyPlaced",
                                    placementType = "PanelScheduleSheetInstance",
                                    id = RevitBridge.Common.ElementIdCompat.GetValue(otherInstances.First().Id),
                                    message = "Panel schedule is already placed on another sheet. Set moveIfAlreadyPlaced=true to move it."
                                });
                            }

                            foreach (var other in otherInstances)
                            {
                                doc.Delete(other.Id);
                            }
                        }

                        var psi = PanelScheduleSheetInstance.Create(doc, viewId, sheet);
                        psi.Origin = placement.Point;
                        trans.Commit();
                        return Task.FromResult<object>(new
                        {
                            id = RevitBridge.Common.ElementIdCompat.GetValue(psi.Id),
                            status = "Placed",
                            action = otherInstances.Count > 0 ? "MoveExisting" : "Create",
                            placementType = "PanelScheduleSheetInstance",
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                            viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                            x = placement.Point.X,
                            y = placement.Point.Y,
                            placement = new { avoidOverlap, strategy = placement.Strategy, box = placement.PreviewBox }
                        });
                    }

                    Viewport viewport;
                    string action;
                    if (existingViewport != null)
                    {
                        if (!moveIfAlreadyPlaced)
                        {
                            trans.RollBack();
                            return Task.FromResult<object>(new
                            {
                                status = "AlreadyPlaced",
                                placementType = "Viewport",
                                id = RevitBridge.Common.ElementIdCompat.GetValue(existingViewport.Id),
                                message = "View is already placed on this sheet. Set moveIfAlreadyPlaced=true to reposition it."
                            });
                        }

                        viewport = existingViewport;
                        if (!SheetPlacementHelper.TrySetViewportCenter(viewport, x, y, out var moveReason))
                        {
                            trans.RollBack();
                            return Task.FromResult<object>(new { status = "Failed", placementType = "Viewport", message = moveReason ?? "Unable to move viewport." });
                        }
                        action = "MoveExisting";
                    }
                    else
                    {
                        if (!Viewport.CanAddViewToSheet(doc, sheetId, viewId))
                        {
                            trans.RollBack();
                            return Task.FromResult<object>(new { status = "Failed", placementType = "Viewport", message = "Cannot place view on sheet (already placed or invalid)." });
                        }

                        viewport = Viewport.Create(doc, sheetId, viewId, new XYZ(x, y, 0));
                        action = "Create";
                    }

                    var typeApplied = (bool?)null;
                    string? typeMessage = null;
                    ElementId? resolvedViewportTypeId = null;
                    string? resolvedViewportTypeName = null;
                    if (viewportTypeRequested)
                    {
                        var typeResolved = SheetPlacementHelper.TryResolveViewportType(doc, viewport, p?.viewportTypeId, p?.viewportTypeName, out resolvedViewportTypeId, out resolvedViewportTypeName);
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

                    var lockApplied = (bool?)null;
                    string? lockMessage = null;
                    if (p?.lockViewport.HasValue == true)
                    {
                        lockApplied = SheetPlacementHelper.TrySetViewportLock(viewport, p.lockViewport.Value, out lockMessage);
                    }

                    trans.Commit();
                    return Task.FromResult<object>(new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(viewport.Id),
                        status = action == "Create" ? "Placed" : "Moved",
                        action,
                        placementType = "Viewport",
                        sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                        x,
                        y,
                        viewportType = viewportTypeRequested
                            ? new
                            {
                                requested = new { p?.viewportTypeId, p?.viewportTypeName },
                                typeId = resolvedViewportTypeId == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(resolvedViewportTypeId),
                                typeName = resolvedViewportTypeName,
                                applied = typeApplied,
                                message = typeMessage
                            }
                            : null,
                        lockViewport = p?.lockViewport.HasValue == true
                            ? new { requested = p.lockViewport.Value, applied = lockApplied, message = lockMessage, current = viewport.Pinned }
                            : null
                    });
                }
            }
            catch (Exception ex)
            {
                return Task.FromResult<object>(new
                {
                    status = "Failed",
                    message = ex.Message
                });
            }
        }
    }
}

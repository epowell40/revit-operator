using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
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

            var isSchedule = view is ViewSchedule;
            var existingViewport = isSchedule ? null : SheetPlacementHelper.FindViewportOnSheet(doc, sheetId, viewId);
            var existingSchedule = isSchedule ? SheetPlacementHelper.FindScheduleInstanceOnSheet(doc, sheetId, viewId) : null;
            var viewportTypeRequested = p?.viewportTypeId.HasValue == true || !string.IsNullOrWhiteSpace(p?.viewportTypeName);

            if (dryRun)
            {
                if (isSchedule)
                {
                    var canCreate = existingSchedule == null && SheetPlacementHelper.CanPlaceScheduleOnSheet(doc, sheetId, viewId);
                    var canMove = existingSchedule != null && moveIfAlreadyPlaced;
                    var canPlace = canCreate || canMove;
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        dryRun = true,
                        placementType = "ScheduleSheetInstance",
                        canPlace,
                        action = canMove ? "MoveExisting" : "Create",
                        sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                        existingScheduleSheetInstanceId = existingSchedule == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(existingSchedule.Id),
                        x,
                        y,
                        reason = canPlace ? null : "Schedule is already placed on this sheet. Set moveIfAlreadyPlaced=true to reposition it."
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

                    if (isSchedule)
                    {
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

                            existingSchedule.Point = new XYZ(x, y, 0);
                            trans.Commit();
                            return Task.FromResult<object>(new
                            {
                                status = "Moved",
                                action = "MoveExisting",
                                placementType = "ScheduleSheetInstance",
                                id = RevitBridge.Common.ElementIdCompat.GetValue(existingSchedule.Id),
                                sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                                viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                                x,
                                y
                            });
                        }

                        if (!SheetPlacementHelper.CanPlaceScheduleOnSheet(doc, sheetId, viewId))
                        {
                            trans.RollBack();
                            return Task.FromResult<object>(new { status = "Failed", placementType = "ScheduleSheetInstance", message = "Cannot place schedule on sheet." });
                        }

                        var ssi = ScheduleSheetInstance.Create(doc, sheetId, viewId, new XYZ(x, y, 0));
                        trans.Commit();
                        return Task.FromResult<object>(new
                        {
                            id = RevitBridge.Common.ElementIdCompat.GetValue(ssi.Id),
                            status = "Placed",
                            action = "Create",
                            placementType = "ScheduleSheetInstance",
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                            viewId = RevitBridge.Common.ElementIdCompat.GetValue(viewId),
                            x,
                            y
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

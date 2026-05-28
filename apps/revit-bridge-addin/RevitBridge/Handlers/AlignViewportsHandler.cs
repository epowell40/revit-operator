using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class AlignViewportsHandler : IRequestHandler
    {
        public sealed class ModelAnchor
        {
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        public sealed class Options
        {
            public bool? failOnPinned { get; set; }
            public bool? unpinIfAllowed { get; set; }
        }

        public sealed class Params
        {
            public long? referenceSheetId { get; set; }
            public long? referenceViewportId { get; set; }

            public List<long>? sheetIds { get; set; } // if provided, aligns all viewports on these sheets
            public List<long>? viewportIds { get; set; } // optional explicit list; overrides sheetIds

            public string? mode { get; set; } // box|modelAnchor
            public string? alignTo { get; set; } // reference|titleBlockOrigin
            public string? horizontal { get; set; } // left|center|right
            public string? vertical { get; set; } // bottom|middle|top

            public double? offsetX { get; set; } // sheet coords (feet)
            public double? offsetY { get; set; } // sheet coords (feet)

            public ModelAnchor? modelAnchor { get; set; } // required for mode=modelAnchor
            public long? modelAnchorElementId { get; set; } // optional convenience: derive anchor from an element
            public string? modelAnchorElementPoint { get; set; } // location|bboxCenter

            public bool? dryRun { get; set; }
            public Options? options { get; set; }
        }

        private sealed class MoveEntry
        {
            public long viewportId { get; set; }
            public long sheetId { get; set; }
            public double deltaX { get; set; }
            public double deltaY { get; set; }
            public double fromCenterX { get; set; }
            public double fromCenterY { get; set; }
            public double toCenterX { get; set; }
            public double toCenterY { get; set; }
            public double anchorBeforeX { get; set; }
            public double anchorBeforeY { get; set; }
            public double targetX { get; set; }
            public double targetY { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var dryRun = p.dryRun ?? false;
            var mode = (p.mode ?? "box").Trim();
            var alignTo = (p.alignTo ?? "reference").Trim();
            var horizontal = (p.horizontal ?? "center").Trim();
            var vertical = (p.vertical ?? "middle").Trim();
            var offsetX = p.offsetX ?? 0;
            var offsetY = p.offsetY ?? 0;

            var failOnPinned = p.options?.failOnPinned ?? true;
            var unpinIfAllowed = p.options?.unpinIfAllowed ?? false;

            var targetViewportIds = ResolveTargetViewportIds(doc, p);
            if (targetViewportIds.Count == 0) throw new InvalidOperationException("align-viewports requires viewportIds or sheetIds with viewports.");
            if (targetViewportIds.Count > 500) throw new InvalidOperationException("align-viewports too large (max 500 viewports).");

            Viewport? referenceViewport = null;
            if (alignTo.Equals("reference", StringComparison.OrdinalIgnoreCase))
            {
                referenceViewport = ResolveReferenceViewport(doc, p);
                if (referenceViewport == null) throw new InvalidOperationException("align-viewports.alignTo=reference requires a reference viewport (referenceViewportId or referenceSheetId with a viewport).");
            }

            XYZ? fixedTargetPoint = null;
            if (alignTo.Equals("reference", StringComparison.OrdinalIgnoreCase))
            {
                if (mode.Equals("modelAnchor", StringComparison.OrdinalIgnoreCase))
                {
                    var anchor = ResolveModelAnchor(doc, p);
                    fixedTargetPoint = GetModelAnchorSheetPoint(doc, referenceViewport!, anchor);
                }
                else
                {
                    fixedTargetPoint = GetBoxAnchorSheetPoint(referenceViewport!, horizontal, vertical);
                }

                fixedTargetPoint = new XYZ(fixedTargetPoint!.X + offsetX, fixedTargetPoint.Y + offsetY, 0);
            }

            var moved = new List<MoveEntry>(capacity: Math.Min(128, targetViewportIds.Count));
            var errors = new List<object>();

            Action doWork = () =>
            {
                foreach (var id in targetViewportIds)
                {
                    try
                    {
                        var vp = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id)) as Viewport;
                        if (vp == null)
                        {
                            errors.Add(new { viewportId = id, error = "Viewport not found." });
                            continue;
                        }

                        var sheetId = vp.SheetId;
                        var targetPoint = fixedTargetPoint;
                        if (!alignTo.Equals("reference", StringComparison.OrdinalIgnoreCase))
                        {
                            // titleBlockOrigin is per-sheet (but typically consistent). If missing, fall back to (0,0).
                            var origin = GetTitleBlockOriginOnSheet(doc, sheetId) ?? new XYZ(0, 0, 0);
                            targetPoint = new XYZ(origin.X + offsetX, origin.Y + offsetY, 0);
                        }

                        XYZ anchorBefore;
                        if (mode.Equals("modelAnchor", StringComparison.OrdinalIgnoreCase))
                        {
                            var anchor = ResolveModelAnchor(doc, p);
                            anchorBefore = GetModelAnchorSheetPoint(doc, vp, anchor);
                        }
                        else
                        {
                            anchorBefore = GetBoxAnchorSheetPoint(vp, horizontal, vertical);
                        }

                        var delta = targetPoint! - anchorBefore;
                        var center = vp.GetBoxCenter();
                        var fromCenter = center;
                        var toCenter = new XYZ(center.X + delta.X, center.Y + delta.Y, 0);

                        if (!dryRun)
                        {
                            var wasPinned = vp.Pinned;
                            if (wasPinned && failOnPinned && !unpinIfAllowed)
                                throw new InvalidOperationException("Viewport is pinned.");

                            if (wasPinned && unpinIfAllowed)
                            {
                                try { vp.Pinned = false; } catch { }
                            }

                            vp.SetBoxCenter(toCenter);

                            if (wasPinned && unpinIfAllowed)
                            {
                                try { vp.Pinned = true; } catch { }
                            }
                        }

                        moved.Add(new MoveEntry
                        {
                            viewportId = RevitBridge.Common.ElementIdCompat.GetValue(vp.Id),
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheetId),
                            deltaX = delta.X,
                            deltaY = delta.Y,
                            fromCenterX = fromCenter.X,
                            fromCenterY = fromCenter.Y,
                            toCenterX = toCenter.X,
                            toCenterY = toCenter.Y,
                            anchorBeforeX = anchorBefore.X,
                            anchorBeforeY = anchorBefore.Y,
                            targetX = targetPoint!.X,
                            targetY = targetPoint!.Y
                        });
                    }
                    catch (Exception ex)
                    {
                        errors.Add(new { viewportId = id, error = ex.Message });
                    }
                }
            };

            if (dryRun)
            {
                doWork();
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    mode = mode.Equals("modelAnchor", StringComparison.OrdinalIgnoreCase) ? "modelAnchor" : "box",
                    alignTo = alignTo.Equals("reference", StringComparison.OrdinalIgnoreCase) ? "reference" : "titleBlockOrigin",
                    referenceViewportId = RevitBridge.Common.ElementIdCompat.GetValue(referenceViewport?.Id),
                    moved,
                    errors
                });
            }

            using (var t = new Transaction(doc, "Align Viewports"))
            {
                t.Start();
                doWork();
                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Aligned",
                dryRun = false,
                mode = mode.Equals("modelAnchor", StringComparison.OrdinalIgnoreCase) ? "modelAnchor" : "box",
                alignTo = alignTo.Equals("reference", StringComparison.OrdinalIgnoreCase) ? "reference" : "titleBlockOrigin",
                referenceViewportId = RevitBridge.Common.ElementIdCompat.GetValue(referenceViewport?.Id),
                moved,
                errors
            });
        }

        private static List<long> ResolveTargetViewportIds(Document doc, Params p)
        {
            if (p.viewportIds != null && p.viewportIds.Count > 0)
            {
                return p.viewportIds.Where(x => x > 0).Distinct().ToList();
            }

            var sheetIds = (p.sheetIds ?? new List<long>()).Where(x => x > 0).Distinct().ToList();
            if (sheetIds.Count == 0 && p.referenceSheetId.HasValue && p.referenceSheetId.Value > 0)
                sheetIds.Add(p.referenceSheetId.Value);

            var outIds = new List<long>();
            foreach (var sid in sheetIds)
            {
                var sheet = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(sid)) as ViewSheet;
                if (sheet == null || sheet.IsPlaceholder) continue;
                foreach (var vpid in sheet.GetAllViewports())
                {
                    if (vpid == null || vpid == ElementId.InvalidElementId) continue;
                    outIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(vpid));
                }
            }
            return outIds.Distinct().ToList();
        }

        private static Viewport? ResolveReferenceViewport(Document doc, Params p)
        {
            if (p.referenceViewportId.HasValue && p.referenceViewportId.Value > 0)
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.referenceViewportId.Value)) as Viewport;

            if (p.referenceSheetId.HasValue && p.referenceSheetId.Value > 0)
            {
                var sheet = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.referenceSheetId.Value)) as ViewSheet;
                if (sheet == null || sheet.IsPlaceholder) return null;
                var viewportIds = sheet.GetAllViewports();
                if (viewportIds == null || viewportIds.Count == 0) return null;

                // Choose "primary" viewport by largest box area.
                Viewport? best = null;
                double bestArea = -1;
                foreach (var vpid in viewportIds)
                {
                    var vp = doc.GetElement(vpid) as Viewport;
                    if (vp == null) continue;
                    try
                    {
                        var o = vp.GetBoxOutline();
                        var min = o.MinimumPoint;
                        var max = o.MaximumPoint;
                        var area = Math.Abs((max.X - min.X) * (max.Y - min.Y));
                        if (area > bestArea)
                        {
                            bestArea = area;
                            best = vp;
                        }
                    }
                    catch { }
                }
                return best;
            }

            return null;
        }

        private static XYZ GetBoxAnchorSheetPoint(Viewport vp, string horizontal, string vertical)
        {
            var o = vp.GetBoxOutline();
            var min = o.MinimumPoint;
            var max = o.MaximumPoint;
            var center = vp.GetBoxCenter();

            var h = (horizontal ?? "center").Trim();
            var v = (vertical ?? "middle").Trim();

            var x = h.Equals("left", StringComparison.OrdinalIgnoreCase) ? min.X :
                    h.Equals("right", StringComparison.OrdinalIgnoreCase) ? max.X :
                    center.X;

            var y = v.Equals("bottom", StringComparison.OrdinalIgnoreCase) ? min.Y :
                    v.Equals("top", StringComparison.OrdinalIgnoreCase) ? max.Y :
                    center.Y;

            return new XYZ(x, y, 0);
        }

        private static XYZ? GetTitleBlockOriginOnSheet(Document doc, ElementId sheetId)
        {
            try
            {
                var titleBlock = new FilteredElementCollector(doc, sheetId)
                    .OfCategory(BuiltInCategory.OST_TitleBlocks)
                    .WhereElementIsNotElementType()
                    .Cast<FamilyInstance>()
                    .FirstOrDefault();

                if (titleBlock?.Location is LocationPoint lp)
                {
                    var p = lp.Point;
                    return new XYZ(p.X, p.Y, 0);
                }
            }
            catch
            {
                // ignore
            }
            return null;
        }

        private static XYZ GetModelAnchorSheetPoint(Document doc, Viewport vp, ModelAnchor anchor)
        {
            var view = doc.GetElement(vp.ViewId) as View;
            if (view == null) throw new InvalidOperationException("Viewport view not found.");
            var scale = view.Scale;
            if (scale <= 0) throw new InvalidOperationException("View scale is invalid.");

            BoundingBoxXYZ crop;
            try { crop = view.CropBox; }
            catch { crop = null; }
            if (crop == null) throw new InvalidOperationException("View crop box not available.");

            var model = new XYZ(anchor.x, anchor.y, anchor.z);
            var inv = crop.Transform.Inverse;
            var inView = inv.OfPoint(model);

            var viewCenter = (crop.Min + crop.Max) * 0.5;
            var dv = inView - viewCenter; // in view coordinates

            // Map view-space delta to sheet-space delta using viewport rotation.
            var rot = vp.Rotation;
            XYZ dvRot;
            if (rot == ViewportRotation.None) dvRot = dv;
            else if (rot == ViewportRotation.Clockwise) dvRot = new XYZ(dv.Y, -dv.X, 0);
            else if (rot == ViewportRotation.Counterclockwise) dvRot = new XYZ(-dv.Y, dv.X, 0);
            else dvRot = dv; // best-effort for any future enum values

            var center = vp.GetBoxCenter();
            var sheetX = center.X + (dvRot.X / scale);
            var sheetY = center.Y + (dvRot.Y / scale);
            return new XYZ(sheetX, sheetY, 0);
        }

        private static ModelAnchor ResolveModelAnchor(Document doc, Params p)
        {
            if (p.modelAnchor != null) return p.modelAnchor;
            if (p.modelAnchorElementId.HasValue && p.modelAnchorElementId.Value > 0)
            {
                var el = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.modelAnchorElementId.Value));
                if (el == null) throw new InvalidOperationException("align-viewports.modelAnchorElementId not found.");

                var mode = (p.modelAnchorElementPoint ?? "location").Trim();
                XYZ? point = null;

                if (mode.Equals("location", StringComparison.OrdinalIgnoreCase))
                {
                    if (el.Location is LocationPoint lp) point = lp.Point;
                    else if (el.Location is LocationCurve lc)
                    {
                        var c = lc.Curve;
                        try { point = c.Evaluate(0.5, true); } catch { point = null; }
                    }
                }

                if (point == null)
                {
                    var bb = el.get_BoundingBox(null);
                    if (bb == null) throw new InvalidOperationException("Unable to resolve model anchor point from element.");
                    point = (bb.Min + bb.Max) * 0.5;
                }

                return new ModelAnchor { x = point.X, y = point.Y, z = point.Z };
            }

            throw new InvalidOperationException("align-viewports.modelAnchor is required when mode=modelAnchor (or provide modelAnchorElementId).");
        }
    }
}

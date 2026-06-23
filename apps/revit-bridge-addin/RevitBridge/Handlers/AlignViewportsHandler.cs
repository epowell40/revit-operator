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
            public bool? boundaryCheck { get; set; }
            public string? boundaryPolicy { get; set; } // skip|warn|fail|allow
            public double? boundaryMarginInches { get; set; }
        }

        public sealed class Params
        {
            public long? referenceSheetId { get; set; }
            public string? referenceSheetNumber { get; set; }
            public string? referenceSheetQuery { get; set; }
            public long? referenceViewportId { get; set; }

            public List<long>? sheetIds { get; set; } // if provided, aligns all viewports on these sheets
            public List<string>? sheetNumbers { get; set; }
            public string? sheetNumberPrefix { get; set; }
            public string? sheetQuery { get; set; }
            public List<long>? viewportIds { get; set; } // optional explicit list; overrides sheetIds
            public bool? primaryOnly { get; set; }
            public string? viewNameContains { get; set; }

            public string? mode { get; set; } // box|modelAnchor
            public string? anchorStrategy { get; set; } // referenceCropCenter|explicit|element
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
            public long? viewId { get; set; }
            public string? viewName { get; set; }
            public string? sheetNumber { get; set; }
            public string? sheetName { get; set; }
            public bool? applied { get; set; }
            public bool? boundaryCheck { get; set; }
            public string? boundaryPolicy { get; set; }
            public string? boundaryStatus { get; set; }
            public bool? blockedByBoundary { get; set; }
            public string? boundaryMessage { get; set; }
            public object? proposedOutline { get; set; }
            public object? usableOutline { get; set; }
            public object? outOfBounds { get; set; }
        }

        private sealed class Rect2
        {
            public double MinX { get; set; }
            public double MinY { get; set; }
            public double MaxX { get; set; }
            public double MaxY { get; set; }

            public double Width => MaxX - MinX;
            public double Height => MaxY - MinY;

            public Rect2 Translate(double dx, double dy)
            {
                return new Rect2 { MinX = MinX + dx, MinY = MinY + dy, MaxX = MaxX + dx, MaxY = MaxY + dy };
            }

            public object ToResponse()
            {
                return new
                {
                    minX = MinX,
                    minY = MinY,
                    maxX = MaxX,
                    maxY = MaxY,
                    width = Width,
                    height = Height
                };
            }
        }

        private sealed class BoundaryAssessment
        {
            public bool CheckEnabled { get; set; }
            public string Policy { get; set; } = "skip";
            public string Status { get; set; } = "not_checked";
            public bool IsOutside { get; set; }
            public bool Block { get; set; }
            public string? Message { get; set; }
            public Rect2? ProposedOutline { get; set; }
            public Rect2? UsableOutline { get; set; }
            public object? OutOfBounds { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var dryRun = p.dryRun ?? false;
            var alignTo = (p.alignTo ?? "reference").Trim();
            var mode = ResolveAlignmentMode(p, alignTo);
            var horizontal = (p.horizontal ?? "center").Trim();
            var vertical = (p.vertical ?? "middle").Trim();
            var offsetX = p.offsetX ?? 0;
            var offsetY = p.offsetY ?? 0;

            var failOnPinned = p.options?.failOnPinned ?? true;
            var unpinIfAllowed = p.options?.unpinIfAllowed ?? false;
            var boundaryCheck = p.options?.boundaryCheck ?? true;
            var boundaryPolicy = NormalizeBoundaryPolicy(p.options?.boundaryPolicy);
            var boundaryMarginFt = Math.Max(0, p.options?.boundaryMarginInches ?? 0.125) / 12.0;

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
            ModelAnchor? resolvedModelAnchor = null;
            string? resolvedAnchorStrategy = null;
            if (alignTo.Equals("reference", StringComparison.OrdinalIgnoreCase))
            {
                if (mode.Equals("modelAnchor", StringComparison.OrdinalIgnoreCase))
                {
                    resolvedModelAnchor = ResolveModelAnchor(doc, p, referenceViewport, out resolvedAnchorStrategy);
                    fixedTargetPoint = GetModelAnchorSheetPoint(doc, referenceViewport!, resolvedModelAnchor);
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
                        var sheet = doc.GetElement(sheetId) as ViewSheet;
                        var view = doc.GetElement(vp.ViewId) as View;
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
                            resolvedModelAnchor ??= ResolveModelAnchor(doc, p, referenceViewport, out resolvedAnchorStrategy);
                            anchorBefore = GetModelAnchorSheetPoint(doc, vp, resolvedModelAnchor);
                        }
                        else
                        {
                            anchorBefore = GetBoxAnchorSheetPoint(vp, horizontal, vertical);
                        }

                        var delta = targetPoint! - anchorBefore;
                        var center = vp.GetBoxCenter();
                        var fromCenter = center;
                        var toCenter = new XYZ(center.X + delta.X, center.Y + delta.Y, 0);
                        var boundary = AssessBoundary(doc, sheet, vp, delta, boundaryCheck, boundaryPolicy, boundaryMarginFt);
                        var applied = false;

                        if (!dryRun)
                        {
                            if (boundary.Block)
                            {
                                if (boundary.Policy.Equals("fail", StringComparison.OrdinalIgnoreCase))
                                {
                                    throw new InvalidOperationException(boundary.Message ?? "Proposed viewport position would extend outside the titleblock/sheet usable area.");
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
                                    targetY = targetPoint!.Y,
                                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(vp.ViewId),
                                    viewName = view?.Name,
                                    sheetNumber = sheet?.SheetNumber,
                                    sheetName = sheet?.Name,
                                    applied = false,
                                    boundaryCheck = boundary.CheckEnabled,
                                    boundaryPolicy = boundary.Policy,
                                    boundaryStatus = boundary.Status,
                                    blockedByBoundary = true,
                                    boundaryMessage = boundary.Message,
                                    proposedOutline = boundary.ProposedOutline?.ToResponse(),
                                    usableOutline = boundary.UsableOutline?.ToResponse(),
                                    outOfBounds = boundary.OutOfBounds
                                });
                                continue;
                            }

                            var wasPinned = vp.Pinned;
                            if (wasPinned && failOnPinned && !unpinIfAllowed)
                                throw new InvalidOperationException("Viewport is pinned.");

                            if (wasPinned && unpinIfAllowed)
                            {
                                try { vp.Pinned = false; } catch { }
                            }

                            vp.SetBoxCenter(toCenter);
                            applied = true;

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
                            targetY = targetPoint!.Y,
                            viewId = RevitBridge.Common.ElementIdCompat.GetValue(vp.ViewId),
                            viewName = view?.Name,
                            sheetNumber = sheet?.SheetNumber,
                            sheetName = sheet?.Name,
                            applied = dryRun ? null : applied,
                            boundaryCheck = boundary.CheckEnabled,
                            boundaryPolicy = boundary.Policy,
                            boundaryStatus = boundary.Status,
                            blockedByBoundary = boundary.Block,
                            boundaryMessage = boundary.Message,
                            proposedOutline = boundary.ProposedOutline?.ToResponse(),
                            usableOutline = boundary.UsableOutline?.ToResponse(),
                            outOfBounds = boundary.OutOfBounds
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
                    boundaryCheck,
                    boundaryPolicy,
                    boundaryMarginInches = boundaryMarginFt * 12.0,
                    mode = mode.Equals("modelAnchor", StringComparison.OrdinalIgnoreCase) ? "modelAnchor" : "box",
                    anchorStrategy = resolvedAnchorStrategy,
                    modelAnchor = resolvedModelAnchor == null ? null : new { resolvedModelAnchor.x, resolvedModelAnchor.y, resolvedModelAnchor.z },
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
                status = BuildApplyStatus(moved, errors),
                dryRun = false,
                boundaryCheck,
                boundaryPolicy,
                boundaryMarginInches = boundaryMarginFt * 12.0,
                mode = mode.Equals("modelAnchor", StringComparison.OrdinalIgnoreCase) ? "modelAnchor" : "box",
                anchorStrategy = resolvedAnchorStrategy,
                modelAnchor = resolvedModelAnchor == null ? null : new { resolvedModelAnchor.x, resolvedModelAnchor.y, resolvedModelAnchor.z },
                alignTo = alignTo.Equals("reference", StringComparison.OrdinalIgnoreCase) ? "reference" : "titleBlockOrigin",
                referenceViewportId = RevitBridge.Common.ElementIdCompat.GetValue(referenceViewport?.Id),
                moved,
                errors
            });
        }

        private static string BuildApplyStatus(List<MoveEntry> moved, List<object> errors)
        {
            if (errors.Count > 0) return moved.Count > 0 ? "AlignedWithErrors" : "Failed";
            var blocked = moved.Count(x => x.blockedByBoundary == true);
            var applied = moved.Count(x => x.applied == true);
            if (blocked > 0 && applied == 0) return "Blocked";
            if (blocked > 0) return "AlignedWithWarnings";
            return "Aligned";
        }

        private static List<long> ResolveTargetViewportIds(Document doc, Params p)
        {
            if (p.viewportIds != null && p.viewportIds.Count > 0)
            {
                return p.viewportIds.Where(x => x > 0).Distinct().ToList();
            }

            var sheetIds = ResolveSheetIds(doc, p);
            if (sheetIds.Count == 0)
            {
                var refSheet = ResolveSheet(doc, p.referenceSheetId, p.referenceSheetNumber, p.referenceSheetQuery);
                if (refSheet != null) sheetIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(refSheet.Id));
            }

            var outIds = new List<long>();
            var primaryOnly = p.primaryOnly ?? (p.sheetNumbers != null && p.sheetNumbers.Count > 0 || !string.IsNullOrWhiteSpace(p.sheetNumberPrefix) || !string.IsNullOrWhiteSpace(p.sheetQuery));
            foreach (var sid in sheetIds)
            {
                var sheet = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(sid)) as ViewSheet;
                if (sheet == null || sheet.IsPlaceholder) continue;
                if (primaryOnly)
                {
                    var primary = ResolvePrimaryViewport(doc, sheet, p.viewNameContains);
                    if (primary != null) outIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(primary.Id));
                    continue;
                }
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

            var referenceSheet = ResolveSheet(doc, p.referenceSheetId, p.referenceSheetNumber, p.referenceSheetQuery);
            if (referenceSheet != null)
            {
                return ResolvePrimaryViewport(doc, referenceSheet, p.viewNameContains);
            }

            return null;
        }

        private static string ResolveAlignmentMode(Params p, string alignTo)
        {
            var requested = (p.mode ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(requested)) return requested;
            if (!alignTo.Equals("reference", StringComparison.OrdinalIgnoreCase)) return "box";

            // Sheet flipping/layout tasks care about where the building lands on the sheet, not
            // where the viewport box lands. Default those calls to model-coordinate alignment.
            if (p.viewportIds == null || p.viewportIds.Count == 0)
            {
                if ((p.sheetNumbers != null && p.sheetNumbers.Count > 0) ||
                    (p.sheetIds != null && p.sheetIds.Count > 0) ||
                    !string.IsNullOrWhiteSpace(p.sheetNumberPrefix) ||
                    !string.IsNullOrWhiteSpace(p.sheetQuery))
                {
                    return "modelAnchor";
                }
            }

            return "box";
        }

        private static List<long> ResolveSheetIds(Document doc, Params p)
        {
            var ids = (p.sheetIds ?? new List<long>()).Where(x => x > 0).Distinct().ToList();

            foreach (var number in (p.sheetNumbers ?? new List<string>()).Where(x => !string.IsNullOrWhiteSpace(x)))
            {
                var sheet = ResolveSheet(doc, null, number.Trim(), null);
                if (sheet != null) ids.Add(RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id));
            }

            var prefix = (p.sheetNumberPrefix ?? "").Trim();
            var query = (p.sheetQuery ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(prefix) || !string.IsNullOrWhiteSpace(query))
            {
                var sheets = new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .Where(s => s != null && !s.IsPlaceholder)
                    .Where(s =>
                    {
                        var sn = (s.SheetNumber ?? "").Trim();
                        var name = (s.Name ?? "").Trim();
                        if (!string.IsNullOrWhiteSpace(prefix) && sn.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
                        if (!string.IsNullOrWhiteSpace(query) && (sn.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)) return true;
                        return false;
                    });
                ids.AddRange(sheets.Select(s => RevitBridge.Common.ElementIdCompat.GetValue(s.Id)));
            }

            return ids.Distinct().ToList();
        }

        private static ViewSheet? ResolveSheet(Document doc, long? sheetId, string? sheetNumber, string? query)
        {
            if (sheetId.HasValue && sheetId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(sheetId.Value)) as ViewSheet;
            }

            var number = (sheetNumber ?? "").Trim();
            var q = (query ?? "").Trim();
            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .Where(s => s != null && !s.IsPlaceholder)
                .Where(s =>
                {
                    var sn = (s.SheetNumber ?? "").Trim();
                    var name = (s.Name ?? "").Trim();
                    if (!string.IsNullOrWhiteSpace(number) && sn.Equals(number, StringComparison.OrdinalIgnoreCase)) return true;
                    if (!string.IsNullOrWhiteSpace(q) && (sn.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0)) return true;
                    return false;
                })
                .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        private static Viewport? ResolvePrimaryViewport(Document doc, ViewSheet sheet, string? viewNameContains)
        {
            var filter = (viewNameContains ?? "").Trim();
            Viewport? best = null;
            double bestScore = double.NegativeInfinity;
            foreach (var vpid in sheet.GetAllViewports())
            {
                var vp = doc.GetElement(vpid) as Viewport;
                if (vp == null) continue;
                var view = doc.GetElement(vp.ViewId) as View;
                if (view == null) continue;
                double area = 0;
                try
                {
                    var o = vp.GetBoxOutline();
                    area = Math.Abs((o.MaximumPoint.X - o.MinimumPoint.X) * (o.MaximumPoint.Y - o.MinimumPoint.Y));
                }
                catch { }

                var score = area;
                if (!string.IsNullOrWhiteSpace(filter))
                {
                    if ((view.Name ?? "").IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0) score += 1000000;
                    else score -= 1000000;
                }
                if (view.ViewType == ViewType.FloorPlan || view.ViewType == ViewType.CeilingPlan || view.ViewType == ViewType.EngineeringPlan) score += 10000;
                if (view.ViewType == ViewType.Legend || view.ViewType == ViewType.DraftingView) score -= 10000;

                if (score > bestScore)
                {
                    bestScore = score;
                    best = vp;
                }
            }
            return best;
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

        private static string NormalizeBoundaryPolicy(string? requested)
        {
            var s = (requested ?? "skip").Trim();
            if (s.Equals("allow", StringComparison.OrdinalIgnoreCase)) return "allow";
            if (s.Equals("warn", StringComparison.OrdinalIgnoreCase)) return "warn";
            if (s.Equals("fail", StringComparison.OrdinalIgnoreCase)) return "fail";
            return "skip";
        }

        private static BoundaryAssessment AssessBoundary(Document doc, ViewSheet? sheet, Viewport vp, XYZ delta, bool checkEnabled, string policy, double marginFt)
        {
            var result = new BoundaryAssessment
            {
                CheckEnabled = checkEnabled,
                Policy = policy,
                Status = checkEnabled ? "ok" : "disabled"
            };

            if (!checkEnabled || policy.Equals("allow", StringComparison.OrdinalIgnoreCase))
            {
                result.Status = checkEnabled ? "allowed" : "disabled";
                return result;
            }

            Rect2 current;
            try { current = GetViewportRect(vp); }
            catch (Exception ex)
            {
                result.Status = "unknown";
                result.Message = "Could not read viewport outline for boundary check: " + ex.Message;
                return result;
            }

            var proposed = current.Translate(delta.X, delta.Y);
            var usable = GetUsableSheetRect(doc, sheet, marginFt);
            result.ProposedOutline = proposed;
            result.UsableOutline = usable;

            if (usable == null)
            {
                result.Status = "unknown";
                result.Message = "No titleblock or sheet outline was available for boundary check.";
                return result;
            }

            var left = Math.Max(0, usable.MinX - proposed.MinX);
            var right = Math.Max(0, proposed.MaxX - usable.MaxX);
            var bottom = Math.Max(0, usable.MinY - proposed.MinY);
            var top = Math.Max(0, proposed.MaxY - usable.MaxY);
            var outside = left > 1e-7 || right > 1e-7 || bottom > 1e-7 || top > 1e-7;
            result.IsOutside = outside;
            result.OutOfBounds = new
            {
                leftFt = left,
                rightFt = right,
                bottomFt = bottom,
                topFt = top,
                leftInches = left * 12.0,
                rightInches = right * 12.0,
                bottomInches = bottom * 12.0,
                topInches = top * 12.0
            };

            if (!outside) return result;

            result.Status = "outside_boundary";
            result.Message = "Proposed viewport position would extend outside the titleblock/sheet usable area.";
            if (policy.Equals("skip", StringComparison.OrdinalIgnoreCase) || policy.Equals("fail", StringComparison.OrdinalIgnoreCase))
            {
                result.Block = true;
            }
            return result;
        }

        private static Rect2 GetViewportRect(Viewport vp)
        {
            var o = vp.GetBoxOutline();
            return new Rect2
            {
                MinX = Math.Min(o.MinimumPoint.X, o.MaximumPoint.X),
                MinY = Math.Min(o.MinimumPoint.Y, o.MaximumPoint.Y),
                MaxX = Math.Max(o.MinimumPoint.X, o.MaximumPoint.X),
                MaxY = Math.Max(o.MinimumPoint.Y, o.MaximumPoint.Y)
            };
        }

        private static Rect2? GetUsableSheetRect(Document doc, ViewSheet? sheet, double marginFt)
        {
            if (sheet == null) return null;

            Rect2? best = null;
            try
            {
                var titleBlocks = new FilteredElementCollector(doc, sheet.Id)
                    .OfCategory(BuiltInCategory.OST_TitleBlocks)
                    .WhereElementIsNotElementType()
                    .Cast<FamilyInstance>();

                foreach (var tb in titleBlocks)
                {
                    BoundingBoxXYZ? bb = null;
                    try { bb = tb.get_BoundingBox(sheet); } catch { bb = null; }
                    if (bb == null) continue;
                    var rect = new Rect2
                    {
                        MinX = Math.Min(bb.Min.X, bb.Max.X),
                        MinY = Math.Min(bb.Min.Y, bb.Max.Y),
                        MaxX = Math.Max(bb.Min.X, bb.Max.X),
                        MaxY = Math.Max(bb.Min.Y, bb.Max.Y)
                    };
                    if (rect.Width <= 1e-9 || rect.Height <= 1e-9) continue;
                    if (best == null || rect.Width * rect.Height > best.Width * best.Height) best = rect;
                }
            }
            catch
            {
                // Fall back to sheet outline below.
            }

            if (best == null)
            {
                try
                {
                    var outline = sheet.Outline;
                    if (outline != null)
                    {
                        best = new Rect2
                        {
                            MinX = Math.Min(outline.Min.U, outline.Max.U),
                            MinY = Math.Min(outline.Min.V, outline.Max.V),
                            MaxX = Math.Max(outline.Min.U, outline.Max.U),
                            MaxY = Math.Max(outline.Min.V, outline.Max.V)
                        };
                    }
                }
                catch
                {
                    best = null;
                }
            }

            if (best == null) return null;
            if (marginFt <= 0) return best;

            var minX = best.MinX + marginFt;
            var minY = best.MinY + marginFt;
            var maxX = best.MaxX - marginFt;
            var maxY = best.MaxY - marginFt;
            if (maxX <= minX || maxY <= minY) return best;
            return new Rect2 { MinX = minX, MinY = minY, MaxX = maxX, MaxY = maxY };
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

        private static ModelAnchor ResolveModelAnchor(Document doc, Params p, Viewport? referenceViewport, out string strategy)
        {
            var requestedStrategy = (p.anchorStrategy ?? "").Trim();
            if (p.modelAnchor != null)
            {
                strategy = "explicit";
                return p.modelAnchor;
            }
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

                strategy = "element";
                return new ModelAnchor { x = point.X, y = point.Y, z = point.Z };
            }

            if (requestedStrategy.Equals("explicit", StringComparison.OrdinalIgnoreCase) ||
                requestedStrategy.Equals("element", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("align-viewports.modelAnchor or modelAnchorElementId is required for the requested anchorStrategy.");
            }

            if (referenceViewport == null)
            {
                throw new InvalidOperationException("align-viewports requires a reference viewport to derive the default model anchor.");
            }

            var referenceView = doc.GetElement(referenceViewport.ViewId) as View;
            if (referenceView == null) throw new InvalidOperationException("Reference viewport view not found.");

            BoundingBoxXYZ crop;
            try { crop = referenceView.CropBox; }
            catch { crop = null; }
            if (crop == null) throw new InvalidOperationException("Reference view crop box not available for default model anchor.");

            var viewCenter = (crop.Min + crop.Max) * 0.5;
            var modelPoint = crop.Transform.OfPoint(viewCenter);
            strategy = "referenceCropCenter";
            return new ModelAnchor { x = modelPoint.X, y = modelPoint.Y, z = modelPoint.Z };
        }
    }
}

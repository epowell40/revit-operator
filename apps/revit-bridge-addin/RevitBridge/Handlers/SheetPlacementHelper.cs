using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;

namespace RevitBridge.Handlers
{
    internal static class SheetPlacementHelper
    {
        public sealed class SchedulePlacementPoint
        {
            public XYZ Point { get; set; } = XYZ.Zero;
            public string Strategy { get; set; } = "requested";
            public object? PreviewBox { get; set; }
        }

        internal sealed class SheetRect
        {
            public double MinX { get; set; }
            public double MinY { get; set; }
            public double MaxX { get; set; }
            public double MaxY { get; set; }

            public double Width => Math.Max(0.0, MaxX - MinX);
            public double Height => Math.Max(0.0, MaxY - MinY);
        }

        private sealed class PlacementFootprint
        {
            public double MinDx { get; set; }
            public double MinDy { get; set; }
            public double MaxDx { get; set; }
            public double MaxDy { get; set; }
            public double Width => Math.Max(0.0, MaxDx - MinDx);
            public double Height => Math.Max(0.0, MaxDy - MinDy);

            public SheetRect At(double x, double y)
            {
                return new SheetRect
                {
                    MinX = x + MinDx,
                    MinY = y + MinDy,
                    MaxX = x + MaxDx,
                    MaxY = y + MaxDy
                };
            }
        }

        public static ViewSheet? ResolveSheet(Document doc, long? sheetId, string? sheetNumber, string? sheetQuery, bool exact)
        {
            if (sheetId.HasValue && sheetId.Value > 0)
            {
                var byId = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(sheetId.Value)) as ViewSheet;
                if (byId != null && !byId.IsPlaceholder) return byId;
            }

            var number = (sheetNumber ?? string.Empty).Trim();
            if (number.Length > 0)
            {
                return new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .FirstOrDefault(s => !s.IsPlaceholder &&
                        string.Equals((s.SheetNumber ?? string.Empty).Trim(), number, StringComparison.OrdinalIgnoreCase));
            }

            var query = (sheetQuery ?? string.Empty).Trim();
            if (query.Length == 0) return null;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .Where(s => !s.IsPlaceholder)
                .Where(s =>
                {
                    var sn = (s.SheetNumber ?? string.Empty).Trim();
                    var nm = (s.Name ?? string.Empty).Trim();
                    return exact
                        ? sn.Equals(query, StringComparison.OrdinalIgnoreCase) || nm.Equals(query, StringComparison.OrdinalIgnoreCase)
                        : sn.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 || nm.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
                })
                .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        public static View? ResolveView(Document doc, long? viewId, string? viewName, string? viewQuery, bool exact)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                var byId = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
                if (byId != null && !byId.IsTemplate && !IsTitleblockRevisionSchedule(byId)) return byId;
            }

            var name = (viewName ?? string.Empty).Trim();
            if (name.Length > 0)
            {
                return CollectCandidateViews(doc)
                    .FirstOrDefault(v => string.Equals((v.Name ?? string.Empty).Trim(), name, StringComparison.OrdinalIgnoreCase));
            }

            var query = (viewQuery ?? string.Empty).Trim();
            if (query.Length == 0) return null;

            return CollectCandidateViews(doc)
                .Where(v =>
                {
                    var n = (v.Name ?? string.Empty).Trim();
                    return exact
                        ? n.Equals(query, StringComparison.OrdinalIgnoreCase)
                        : n.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
                })
                .OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        public static Viewport? FindViewportOnSheet(Document doc, ElementId sheetId, ElementId viewId)
        {
            return new FilteredElementCollector(doc, sheetId)
                .OfClass(typeof(Viewport))
                .Cast<Viewport>()
                .FirstOrDefault(vp => vp.ViewId == viewId);
        }

        public static ScheduleSheetInstance? FindScheduleInstanceOnSheet(Document doc, ElementId sheetId, ElementId scheduleViewId)
        {
            return new FilteredElementCollector(doc, sheetId)
                .OfClass(typeof(ScheduleSheetInstance))
                .Cast<ScheduleSheetInstance>()
                .FirstOrDefault(ssi => ssi.ScheduleId == scheduleViewId);
        }

        public static List<ScheduleSheetInstance> FindScheduleInstances(Document doc, ElementId scheduleViewId)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(ScheduleSheetInstance))
                .Cast<ScheduleSheetInstance>()
                .Where(ssi => ssi.ScheduleId == scheduleViewId)
                .ToList();
        }

        public static bool IsPanelScheduleView(View view)
        {
            return view is PanelScheduleView || view.ViewType == ViewType.PanelSchedule;
        }

        public static PanelScheduleSheetInstance? FindPanelScheduleInstanceOnSheet(Document doc, ElementId sheetId, ElementId scheduleViewId)
        {
            return new FilteredElementCollector(doc, sheetId)
                .OfClass(typeof(PanelScheduleSheetInstance))
                .Cast<PanelScheduleSheetInstance>()
                .FirstOrDefault(ssi => ssi.ScheduleId == scheduleViewId);
        }

        public static List<PanelScheduleSheetInstance> FindPanelScheduleInstances(Document doc, ElementId scheduleViewId)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(PanelScheduleSheetInstance))
                .Cast<PanelScheduleSheetInstance>()
                .Where(ssi => ssi.ScheduleId == scheduleViewId)
                .ToList();
        }

        public static bool CanPlaceScheduleOnSheet(Document doc, ElementId sheetId, ElementId scheduleViewId)
        {
            if (sheetId == null || sheetId == ElementId.InvalidElementId) return false;
            if (scheduleViewId == null || scheduleViewId == ElementId.InvalidElementId) return false;

            var sheet = doc.GetElement(sheetId) as ViewSheet;
            if (sheet == null || sheet.IsPlaceholder) return false;

            var view = doc.GetElement(scheduleViewId) as ViewSchedule;
            if (view == null || IsTitleblockRevisionSchedule(view)) return false;

            return FindScheduleInstanceOnSheet(doc, sheetId, scheduleViewId) == null;
        }

        public static SchedulePlacementPoint ResolveSchedulePlacementPoint(
            Document doc,
            ViewSheet sheet,
            ElementId scheduleViewId,
            double? requestedX,
            double? requestedY,
            bool avoidOverlap,
            Element? sampleInstance = null,
            ElementId? ignoreElementId = null,
            List<SheetRect>? additionalOccupied = null)
        {
            var requested = requestedX.HasValue || requestedY.HasValue;
            var x = requestedX ?? 0.0;
            var y = requestedY ?? 0.0;

            var footprint = BuildFootprint(sampleInstance, sheet) ?? new PlacementFootprint
            {
                MinDx = 0.0,
                MaxDx = 1.35,
                MinDy = -0.75,
                MaxDy = 0.0
            };

            if (!avoidOverlap && requested)
            {
                return BuildPlacementPoint(x, y, "requested", footprint);
            }

            if (!avoidOverlap && !requested)
            {
                var existing = sampleInstance != null ? TryGetPoint(sampleInstance) : null;
                if (existing != null) return BuildPlacementPoint(existing.X, existing.Y, "source-position", footprint);
                return BuildPlacementPoint(0.0, 0.0, "default-origin", footprint);
            }

            var occupied = CollectSheetOccupancy(doc, sheet, ignoreElementId);
            if (additionalOccupied != null && additionalOccupied.Count > 0)
            {
                occupied.AddRange(additionalOccupied);
            }
            var start = requested
                ? new XYZ(x, y, 0)
                : (sampleInstance != null ? TryGetPoint(sampleInstance) : null);
            if (start != null && IsPlacementUsable(footprint.At(start.X, start.Y), occupied, sheet))
            {
                return BuildPlacementPoint(start.X, start.Y, requested ? "requested-non-overlap" : "source-position-non-overlap", footprint);
            }

            var o = sheet.Outline;
            const double margin = 0.18;
            const double step = 0.22;
            var usableMinX = o.Min.U + margin;
            var usableMaxX = o.Max.U - margin;
            var usableMinY = o.Min.V + margin;
            var usableMaxY = o.Max.V - margin;

            for (var yCursor = usableMaxY - Math.Max(0.0, footprint.MaxDy); yCursor >= usableMinY - footprint.MinDy; yCursor -= Math.Max(step, footprint.Height + 0.10))
            {
                for (var xCursor = usableMinX - footprint.MinDx; xCursor <= usableMaxX - footprint.MaxDx; xCursor += Math.Max(step, footprint.Width + 0.10))
                {
                    var rect = footprint.At(xCursor, yCursor);
                    if (IsPlacementUsable(rect, occupied, sheet))
                    {
                        return BuildPlacementPoint(xCursor, yCursor, "auto-non-overlap", footprint);
                    }
                }
            }

            if (start != null) return BuildPlacementPoint(start.X, start.Y, "fallback-source-overlap-possible", footprint);
            return BuildPlacementPoint(usableMinX - footprint.MinDx, usableMaxY - footprint.MaxDy, "fallback-sheet-corner-overlap-possible", footprint);
        }

        public static SheetRect PlacementPreviewRect(SchedulePlacementPoint placement)
        {
            var previewRect = SheetRectFromPreviewBox(placement.PreviewBox);
            if (previewRect != null) return previewRect;
            return new SheetRect
                {
                    MinX = placement.Point.X,
                    MinY = placement.Point.Y,
                    MaxX = placement.Point.X,
                    MaxY = placement.Point.Y
                };
        }

        public static SheetRect? TryGetSheetRect(Element element, ViewSheet sheet)
        {
            return TryGetElementSheetRect(element, sheet);
        }

        public static bool TrySetViewportCenter(Viewport viewport, double x, double y, out string? reason)
        {
            reason = null;
            try
            {
                viewport.SetBoxCenter(new XYZ(x, y, 0));
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        public static bool TrySetViewportLock(Viewport viewport, bool locked, out string? reason)
        {
            reason = null;
            try
            {
                viewport.Pinned = locked;
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        public static bool TryResolveViewportType(Document doc, Viewport? viewport, long? viewportTypeId, string? viewportTypeName, out ElementId? resolvedTypeId, out string? resolvedTypeName)
        {
            resolvedTypeId = null;
            resolvedTypeName = null;

            if (viewportTypeId.HasValue && viewportTypeId.Value > 0)
            {
                var candidate = RevitBridge.Common.ElementIdCompat.Create(viewportTypeId.Value);
                if (doc.GetElement(candidate) is ElementType et)
                {
                    resolvedTypeId = candidate;
                    resolvedTypeName = et.Name;
                    return true;
                }
                return false;
            }

            var typeName = (viewportTypeName ?? string.Empty).Trim();
            if (typeName.Length == 0) return true;

            var validIds = new HashSet<long>();
            if (viewport != null)
            {
                try
                {
                    foreach (var id in viewport.GetValidTypes())
                    {
                        validIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(id));
                    }
                }
                catch
                {
                    // ignore and fall back to broader lookup
                }
            }

            ElementType? matched = null;
            if (validIds.Count > 0)
            {
                matched = validIds
                    .Select(id => doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id)) as ElementType)
                    .FirstOrDefault(et => et != null && string.Equals((et.Name ?? string.Empty).Trim(), typeName, StringComparison.OrdinalIgnoreCase));
            }
            else
            {
                matched = new FilteredElementCollector(doc)
                    .OfClass(typeof(ElementType))
                    .Cast<ElementType>()
                    .Where(et => et.Category != null)
                    .Where(et => et.Category.Id == RevitBridge.Common.ElementIdCompat.Create((long)BuiltInCategory.OST_Viewports))
                    .FirstOrDefault(et => string.Equals((et.Name ?? string.Empty).Trim(), typeName, StringComparison.OrdinalIgnoreCase));
            }

            if (matched == null) return false;

            resolvedTypeId = matched.Id;
            resolvedTypeName = matched.Name;
            return true;
        }

        public static bool TryApplyViewportType(Viewport viewport, ElementId viewportTypeId, out string? reason)
        {
            reason = null;
            try
            {
                viewport.ChangeTypeId(viewportTypeId);
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        private static IEnumerable<View> CollectCandidateViews(Document doc)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => !v.IsTemplate)
                .Where(v => !IsTitleblockRevisionSchedule(v));
        }

        private static bool IsTitleblockRevisionSchedule(View view)
        {
            if (view is not ViewSchedule schedule) return false;
            try
            {
                var prop = schedule.GetType().GetProperty("IsTitleblockRevisionSchedule", BindingFlags.Instance | BindingFlags.Public);
                return prop?.GetValue(schedule, null) is bool b && b;
            }
            catch
            {
                return false;
            }
        }

        private static SchedulePlacementPoint BuildPlacementPoint(double x, double y, string strategy, PlacementFootprint footprint)
        {
            var rect = footprint.At(x, y);
            return new SchedulePlacementPoint
            {
                Point = new XYZ(x, y, 0),
                Strategy = strategy,
                PreviewBox = new
                {
                    minU = rect.MinX,
                    minV = rect.MinY,
                    maxU = rect.MaxX,
                    maxV = rect.MaxY
                }
            };
        }

        private static XYZ? TryGetPoint(Element element)
        {
            try
            {
                if (element is ScheduleSheetInstance ssi) return ssi.Point;
                if (element is PanelScheduleSheetInstance psi) return psi.Origin;
            }
            catch
            {
                return null;
            }
            return null;
        }

        private static PlacementFootprint? BuildFootprint(Element? sampleInstance, ViewSheet sheet)
        {
            if (sampleInstance == null) return null;
            var p = TryGetPoint(sampleInstance);
            var r = TryGetElementSheetRect(sampleInstance, sheet);
            if (p == null || r == null) return null;
            return new PlacementFootprint
            {
                MinDx = r.MinX - p.X,
                MinDy = r.MinY - p.Y,
                MaxDx = r.MaxX - p.X,
                MaxDy = r.MaxY - p.Y
            };
        }

        private static SheetRect? SheetRectFromPreviewBox(object? previewBox)
        {
            if (previewBox == null) return null;
            var type = previewBox.GetType();
            try
            {
                var minU = Convert.ToDouble(type.GetProperty("minU")?.GetValue(previewBox));
                var minV = Convert.ToDouble(type.GetProperty("minV")?.GetValue(previewBox));
                var maxU = Convert.ToDouble(type.GetProperty("maxU")?.GetValue(previewBox));
                var maxV = Convert.ToDouble(type.GetProperty("maxV")?.GetValue(previewBox));
                return new SheetRect
                {
                    MinX = Math.Min(minU, maxU),
                    MinY = Math.Min(minV, maxV),
                    MaxX = Math.Max(minU, maxU),
                    MaxY = Math.Max(minV, maxV)
                };
            }
            catch
            {
                return null;
            }
        }

        private static List<SheetRect> CollectSheetOccupancy(Document doc, ViewSheet sheet, ElementId? ignoreElementId)
        {
            var rects = new List<SheetRect>();
            var ignore = ignoreElementId == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(ignoreElementId);

            foreach (var vpId in sheet.GetAllViewports())
            {
                if (ignore.HasValue && RevitBridge.Common.ElementIdCompat.GetValue(vpId) == ignore.Value) continue;
                if (doc.GetElement(vpId) is not Viewport vp) continue;
                try
                {
                    var o = vp.GetBoxOutline();
                    rects.Add(new SheetRect
                    {
                        MinX = o.MinimumPoint.X,
                        MinY = o.MinimumPoint.Y,
                        MaxX = o.MaximumPoint.X,
                        MaxY = o.MaximumPoint.Y
                    });
                }
                catch
                {
                    // Ignore geometry Revit cannot report.
                }
            }

            foreach (var el in new FilteredElementCollector(doc, sheet.Id).OfClass(typeof(ScheduleSheetInstance)).Cast<Element>()
                .Concat(new FilteredElementCollector(doc, sheet.Id).OfClass(typeof(PanelScheduleSheetInstance)).Cast<Element>()))
            {
                if (ignore.HasValue && RevitBridge.Common.ElementIdCompat.GetValue(el.Id) == ignore.Value) continue;
                var rect = TryGetElementSheetRect(el, sheet);
                if (rect != null) rects.Add(rect);
            }

            return rects;
        }

        private static SheetRect? TryGetElementSheetRect(Element element, ViewSheet sheet)
        {
            try
            {
                var bb = element.get_BoundingBox(sheet);
                if (bb == null) return null;
                return new SheetRect
                {
                    MinX = Math.Min(bb.Min.X, bb.Max.X),
                    MinY = Math.Min(bb.Min.Y, bb.Max.Y),
                    MaxX = Math.Max(bb.Min.X, bb.Max.X),
                    MaxY = Math.Max(bb.Min.Y, bb.Max.Y)
                };
            }
            catch
            {
                return null;
            }
        }

        private static bool IsPlacementUsable(SheetRect candidate, List<SheetRect> occupied, ViewSheet sheet)
        {
            const double clearance = 0.05;
            var o = sheet.Outline;
            if (candidate.MinX < o.Min.U + clearance) return false;
            if (candidate.MaxX > o.Max.U - clearance) return false;
            if (candidate.MinY < o.Min.V + clearance) return false;
            if (candidate.MaxY > o.Max.V - clearance) return false;

            foreach (var rect in occupied)
            {
                if (Intersects(candidate, rect, clearance)) return false;
            }

            return true;
        }

        private static bool Intersects(SheetRect a, SheetRect b, double clearance)
        {
            return a.MinX < b.MaxX + clearance &&
                   a.MaxX > b.MinX - clearance &&
                   a.MinY < b.MaxY + clearance &&
                   a.MaxY > b.MinY - clearance;
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;

namespace RevitBridge.Handlers
{
    internal static class SheetPlacementHelper
    {
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
    }
}

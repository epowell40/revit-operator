using System;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    /// <summary>Read-only target semantics for width edits. No row-height or bounding-box equality: wrapping may reflow.</summary>
    internal static class ScheduleWidthPreservation
    {
        internal static object Capture(Document doc, ViewSchedule schedule)
        {
            try
            {
                var definition = schedule.Definition;
                if (schedule.IsTemplate || schedule.IsTitleblockRevisionSchedule || definition.IsKeySchedule
                    || definition.IsMaterialTakeoff || definition.HasEmbeddedSchedule || definition.IncludeLinkedFiles
                    || definition.IsFilteredBySheet)
                    throw new InvalidOperationException("Target membership requires a flat host-only schedule without per-sheet filtering.");
                var table = ScheduleCellAppearanceOperations.ReadAllCellsForPreservation(schedule);
                using var collector = new FilteredElementCollector(doc, schedule.Id);
                var elements = collector.WhereElementIsNotElementType().Take(5001).ToArray();
                if (elements.Length > 5000) throw new InvalidOperationException("Target member census exceeds 5000 host elements.");
                var members = elements.OrderBy(e => ElementIdCompat.GetValue(e.Id)).Select(e => new
                {
                    id = ElementIdCompat.GetValue(e.Id), uniqueId = e.UniqueId
                }).ToArray();
                if (members.Any(e => e.id <= 0 || string.IsNullOrWhiteSpace(e.uniqueId)))
                    throw new InvalidOperationException("Native member identity is unavailable.");
                using var placementsCollector = new FilteredElementCollector(doc);
                var instances = placementsCollector.OfClass(typeof(ScheduleSheetInstance)).Cast<ScheduleSheetInstance>()
                    .Where(p => p.ScheduleId == schedule.Id).Take(129).ToArray();
                if (instances.Length > 128) throw new InvalidOperationException("Target placement census exceeds 128 instances.");
                var placements = instances.OrderBy(p => ElementIdCompat.GetValue(p.Id)).Select(p =>
                {
                    var sheet = doc.GetElement(p.OwnerViewId) as ViewSheet
                        ?? throw new InvalidOperationException("Native schedule placement sheet is unavailable.");
                    var point = p.Point;
                    return new { id = ElementIdCompat.GetValue(p.Id), uniqueId = p.UniqueId,
                        sheetId = ElementIdCompat.GetValue(sheet.Id), sheetUniqueId = sheet.UniqueId,
                        point = new[] { point.X, point.Y, point.Z } };
                }).ToArray();
                return new { schema = "operator.schedule_width_preservation.v1", complete = true,
                    coverage = "host_members_table_text_cell_styles_placement_anchors_v1",
                    scheduleId = ElementIdCompat.GetValue(schedule.Id), uniqueId = schedule.UniqueId,
                    memberCount = members.Length, members, table, placements };
            }
            catch (Exception ex)
            {
                return new { schema = "operator.schedule_width_preservation.v1", complete = false,
                    scheduleId = ElementIdCompat.GetValue(schedule.Id), uniqueId = schedule.UniqueId, error = ex.Message };
            }
        }
    }
}

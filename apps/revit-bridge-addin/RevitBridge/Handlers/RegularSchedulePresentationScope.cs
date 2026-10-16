using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    /// <summary>Bounded native preservation evidence; never accepts a dependency based on its name.</summary>
    internal static class RegularSchedulePresentationScope
    {
        private static string Hash(object value)
        {
            using (var hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value))))
                    .Replace("-", "").ToLowerInvariant();
        }

        internal static object Capture(Document doc, ViewSchedule target)
        {
            try
            {
                var timer = Stopwatch.StartNew();
                var others = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
                    .Where(view => view.Id != target.Id && !view.IsTitleblockRevisionSchedule)
                    .OrderBy(view => ElementIdCompat.GetValue(view.Id)).ToArray();
                if (others.Length > 100) throw new InvalidOperationException("Presentation scope exceeds 100 regular schedules.");
                var rows = new List<object>(); var cells = 0;
                foreach (var view in others)
                {
                    if (timer.ElapsedMilliseconds > 10000) throw new InvalidOperationException("Presentation scope exceeded its 10-second census bound.");
                    var state = SchedulesHandler.ReadPresentationScopeState(doc, view);
                    var cellState = ScheduleCellAppearanceOperations.ReadAllCellsForPreservation(view);
                    var raw = JsonSerializer.SerializeToElement(cellState);
                    cells += raw.GetProperty("totalCells").GetInt32();
                    if (cells > 20000) throw new InvalidOperationException("Presentation scope exceeds 20000 unrequested cells.");
                    var geometry = ReadGeometry(view);
                    rows.Add(new { scheduleId = ElementIdCompat.GetValue(view.Id), uniqueId = view.UniqueId,
                        semanticHash = Hash(new { state, cellState, geometry }) });
                }
                var ids = target.GetDependentElements(null);
                if (ids.Count > 1024) throw new InvalidOperationException("Presentation dependency census exceeds 1024 native elements.");
                var dependencies = ids.OrderBy(ElementIdCompat.GetValue).Select(id =>
                {
                    var element = doc.GetElement(id) ?? throw new InvalidOperationException("Native dependent element could not be resolved.");
                    return new { id = ElementIdCompat.GetValue(id), uniqueId = element.UniqueId,
                        className = element.GetType().FullName, ownerViewId = ElementIdCompat.GetValue(element.OwnerViewId) };
                }).ToArray();
                return new { schema = "operator.regular_schedule_presentation_scope.v1", complete = true,
                    coverage = "configuration_cell_text_style_geometry_v1", targetId = ElementIdCompat.GetValue(target.Id), targetUniqueId = target.UniqueId,
                    unrequestedSchedules = rows, dependencies, totalUnrequestedCells = cells,
                    note = "Native logical dependencies and sampled complete regular-schedule configuration/cell appearance; not engineering or rendered visual approval." };
            }
            catch (Exception ex)
            {
                return new { schema = "operator.regular_schedule_presentation_scope.v1", complete = false, error = ex.Message };
            }
        }

        private static object ReadGeometry(ViewSchedule view)
        {
            var sections = new List<object>();
            using (var table = view.GetTableData())
            foreach (var kind in new[] { SectionType.Header, SectionType.Body, SectionType.Summary, SectionType.Footer })
            {
                if (!view.IsValidSectionType(kind)) continue;
                using (var section = table.GetSectionData(kind))
                {
                    var rows = new List<double>(); var columns = new List<double>(); var merged = new List<int[]>();
                    for (var r = section.FirstRowNumber; r <= section.LastRowNumber && section.NumberOfRows > 0; r++)
                    {
                        rows.Add(section.GetRowHeight(r));
                        for (var c = section.FirstColumnNumber; c <= section.LastColumnNumber && section.NumberOfColumns > 0; c++)
                        {
                            if (merged.Count >= 10000) throw new InvalidOperationException("Presentation geometry exceeds 10000 cells.");
                            var range = section.GetMergedCell(r, c);
                            merged.Add(new[] { r, c, range.Top, range.Left, range.Bottom, range.Right });
                        }
                    }
                    for (var c = section.FirstColumnNumber; c <= section.LastColumnNumber && section.NumberOfColumns > 0; c++) columns.Add(section.GetColumnWidth(c));
                    sections.Add(new { section = kind.ToString(), rowCount = section.NumberOfRows, columnCount = section.NumberOfColumns, rows, columns, merged });
                }
            }
            return sections;
        }

        internal static object Read(Document doc, long scheduleId)
        {
            var schedule = doc.GetElement(ElementIdCompat.Create(scheduleId)) as ViewSchedule;
            if (schedule == null || schedule.IsTitleblockRevisionSchedule)
                throw new ArgumentException("Presentation read requires one actual regular schedule resolved from the active document.");
            return new { status = "Ok", action = "presentation", read_only = true,
                schedule = new { id = scheduleId, uniqueId = schedule.UniqueId, kind = "schedule" },
                presentation = RegularSchedulePresentation.Read(doc, schedule), scope = Capture(doc, schedule) };
        }
    }
}

using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    // Separate from default text styles: a field/column change is not a row-height read.
    internal static class RegularScheduleRowHeights
    {
        internal static object Read(ViewSchedule schedule)
        {
            var sections = new List<object>();
            try
            {
                int total = 0;
                using (var table = schedule.GetTableData())
                foreach (var section in new[] { SectionType.Header, SectionType.Body, SectionType.Summary, SectionType.Footer })
                {
                    if (!schedule.IsValidSectionType(section))
                    {
                        sections.Add(new { section = section.ToString(), validSection = false, firstRowNumber = (int?)null, rowCount = 0, rows = new object[0] });
                        continue;
                    }
                    using (var data = table.GetSectionData(section))
                    {
                    int count = data.NumberOfRows;
                    if (count < 0 || total + count > 4096) throw new InvalidOperationException("Native row-height census exceeds its 4096-row bound.");
                    var rows = new List<object>();
                    for (int i = 0; i < count; i++)
                    {
                        int row = data.FirstRowNumber + i;
                        double height = data.GetRowHeight(row);
                        if (double.IsNaN(height) || double.IsInfinity(height) || height < 0) throw new InvalidOperationException("Native row height is unavailable.");
                        rows.Add(new { rowNumber = row, heightFeet = height });
                    }
                    total += count;
                    sections.Add(new { section = section.ToString(), validSection = true, firstRowNumber = data.FirstRowNumber, rowCount = count, rows });
                    }
                }
                return new { schema = "operator.regular_schedule_row_heights.v1", complete = true,
                    scheduleId = ElementIdCompat.GetValue(schedule.Id), uniqueId = schedule.UniqueId, sections };
            }
            catch (Exception ex)
            {
                return new { schema = "operator.regular_schedule_row_heights.v1", complete = false,
                    scheduleId = ElementIdCompat.GetValue(schedule.Id), uniqueId = schedule.UniqueId, sections, error = ex.Message };
            }
        }
    }
}

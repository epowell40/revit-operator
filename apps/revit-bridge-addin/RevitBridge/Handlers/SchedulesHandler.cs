using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class SchedulesHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? action { get; set; } // list (default) | detail
            public long? scheduleId { get; set; }
            public string? query { get; set; }
            public bool? exact { get; set; }
            public int? max { get; set; }
            public bool? includeFields { get; set; }
            public bool? includeData { get; set; }
            public int? rowOffset { get; set; }
            public int? columnOffset { get; set; }
            public int? maxRows { get; set; }
            public int? maxColumns { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "NoDocument",
                    message = "No active Revit document."
                });
            }

            var action = (p.action ?? "list").Trim().ToLowerInvariant();
            if (action == "detail")
            {
                return Task.FromResult<object>(BuildDetail(doc, p));
            }

            return Task.FromResult<object>(BuildList(doc, p));
        }

        private static object BuildList(Document doc, Params p)
        {
            var q = (p.query ?? "").Trim();
            var exact = p.exact ?? false;
            var max = p.max.HasValue && p.max.Value > 0 ? Math.Min(p.max.Value, 2000) : 200;

            var schedules = CollectSchedules(doc)
                .Where(s =>
                {
                    if (string.IsNullOrWhiteSpace(q)) return true;
                    var n = (s.Name ?? "").Trim();
                    if (exact) return n.Equals(q, StringComparison.OrdinalIgnoreCase);
                    return n.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0;
                })
                .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .Take(max)
                .ToList();

            var items = schedules.Select(s => BuildScheduleSummary(doc, s)).ToList();
            return new
            {
                status = "Ok",
                action = "list",
                returned = items.Count,
                query = string.IsNullOrWhiteSpace(q) ? null : q,
                exact,
                items
            };
        }

        private static object BuildDetail(Document doc, Params p)
        {
            var exact = p.exact ?? false;
            var q = (p.query ?? "").Trim();

            var schedule = ResolveSchedule(doc, p.scheduleId, q, exact);
            if (schedule == null)
            {
                return new
                {
                    status = "NotFound",
                    action = "detail",
                    message = "Schedule not found. Provide scheduleId or query."
                };
            }

            var includeFields = p.includeFields ?? true;
            var includeData = p.includeData ?? false;
            var summary = BuildScheduleSummary(doc, schedule);
            var details = includeFields ? BuildFieldDetails(doc, schedule) : null;
            var table = includeData ? BuildTableData(schedule, p) : null;

            return new
            {
                status = "Ok",
                action = "detail",
                schedule = summary,
                fields = details,
                table
            };
        }

        private static object BuildTableData(ViewSchedule schedule, Params p)
        {
            var rowOffset = Math.Max(0, p.rowOffset ?? 0);
            var columnOffset = Math.Max(0, p.columnOffset ?? 0);
            var maxRows = Math.Min(500, Math.Max(1, p.maxRows ?? 100));
            var maxColumns = Math.Min(100, Math.Max(1, p.maxColumns ?? 40));

            try
            {
                var tableData = schedule.GetTableData();
                return new
                {
                    rowOffset,
                    columnOffset,
                    maxRows,
                    maxColumns,
                    header = ReadTableSection(schedule, tableData.GetSectionData(SectionType.Header), SectionType.Header, 0, columnOffset, 25, maxColumns),
                    body = ReadTableSection(schedule, tableData.GetSectionData(SectionType.Body), SectionType.Body, rowOffset, columnOffset, maxRows, maxColumns)
                };
            }
            catch (Exception ex)
            {
                return new
                {
                    rowOffset,
                    columnOffset,
                    maxRows,
                    maxColumns,
                    error = ex.Message
                };
            }
        }

        private static object ReadTableSection(
            ViewSchedule schedule,
            TableSectionData section,
            SectionType sectionType,
            int rowOffset,
            int columnOffset,
            int maxRows,
            int maxColumns)
        {
            var totalRows = Math.Max(0, section.NumberOfRows);
            var totalColumns = Math.Max(0, section.NumberOfColumns);
            var firstRow = section.FirstRowNumber;
            var firstColumn = section.FirstColumnNumber;
            var returnedRows = Math.Max(0, Math.Min(maxRows, totalRows - rowOffset));
            var returnedColumns = Math.Max(0, Math.Min(maxColumns, totalColumns - columnOffset));
            var rows = new List<object>(returnedRows);

            for (var rowIndex = 0; rowIndex < returnedRows; rowIndex++)
            {
                var absoluteRow = firstRow + rowOffset + rowIndex;
                var cells = new List<string>(returnedColumns);
                for (var columnIndex = 0; columnIndex < returnedColumns; columnIndex++)
                {
                    var absoluteColumn = firstColumn + columnOffset + columnIndex;
                    try
                    {
                        cells.Add(schedule.GetCellText(sectionType, absoluteRow, absoluteColumn) ?? "");
                    }
                    catch
                    {
                        cells.Add("");
                    }
                }

                rows.Add(new { rowIndex = absoluteRow, cells });
            }

            var nextRowOffset = rowOffset + returnedRows < totalRows ? rowOffset + returnedRows : (int?)null;
            var nextColumnOffset = columnOffset + returnedColumns < totalColumns ? columnOffset + returnedColumns : (int?)null;
            return new
            {
                section = sectionType.ToString(),
                totalRows,
                totalColumns,
                rowOffset,
                columnOffset,
                returnedRows,
                returnedColumns,
                hasMoreRows = nextRowOffset.HasValue,
                nextRowOffset,
                hasMoreColumns = nextColumnOffset.HasValue,
                nextColumnOffset,
                rows
            };
        }

        private static List<ViewSchedule> CollectSchedules(Document doc)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSchedule))
                .Cast<ViewSchedule>()
                .Where(s => s != null)
                .Where(s => !IsTitleblockRevisionSchedule(s))
                .ToList();
        }

        private static ViewSchedule? ResolveSchedule(Document doc, long? scheduleId, string query, bool exact)
        {
            if (scheduleId.HasValue && scheduleId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(scheduleId.Value)) as ViewSchedule;
            }

            if (string.IsNullOrWhiteSpace(query)) return null;

            return CollectSchedules(doc)
                .Where(s =>
                {
                    var n = (s.Name ?? "").Trim();
                    if (exact) return n.Equals(query, StringComparison.OrdinalIgnoreCase);
                    return n.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
                })
                .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        private static object BuildScheduleSummary(Document doc, ViewSchedule schedule)
        {
            var definition = schedule.Definition;
            var fieldCount = SafeGetFieldCount(definition);
            var categoryId = TryGetCategoryId(definition);
            var categoryName = categoryId.HasValue
                ? doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(categoryId.Value))?.Name
                : null;

            return new
            {
                id = RevitBridge.Common.ElementIdCompat.GetValue(schedule.Id),
                name = schedule.Name,
                viewType = schedule.ViewType.ToString(),
                kind = "schedule",
                categoryId,
                categoryName,
                fieldCount
            };
        }

        private static List<object> BuildFieldDetails(Document doc, ViewSchedule schedule)
        {
            var fields = new List<object>();
            var definition = schedule.Definition;
            var fieldCount = SafeGetFieldCount(definition);
            for (var i = 0; i < fieldCount; i++)
            {
                try
                {
                    var field = definition.GetField(i);
                    var name = ReadFieldName(field, doc);
                    var isHidden = TryGetBoolProperty(field, "IsHidden");
                    var heading = TryGetStringProperty(field, "ColumnHeading")
                        ?? TryGetStringProperty(field, "Heading");
                    var headingOrientation = TryGetPropertyText(field, "HeadingOrientation");
                    var horizontalAlignment = TryGetPropertyText(field, "HorizontalAlignment");
                    fields.Add(new
                    {
                        index = i,
                        name,
                        heading,
                        headingOrientation,
                        horizontalAlignment,
                        isHidden
                    });
                }
                catch
                {
                    fields.Add(new
                    {
                        index = i,
                        name = (string?)null,
                        heading = (string?)null,
                        headingOrientation = (string?)null,
                        horizontalAlignment = (string?)null,
                        isHidden = (bool?)null
                    });
                }
            }

            return fields;
        }

        private static bool IsTitleblockRevisionSchedule(ViewSchedule schedule)
        {
            var value = TryGetBoolProperty(schedule, "IsTitleblockRevisionSchedule");
            return value ?? false;
        }

        private static int SafeGetFieldCount(ScheduleDefinition definition)
        {
            try { return definition.GetFieldCount(); }
            catch { return 0; }
        }

        private static long? TryGetCategoryId(ScheduleDefinition definition)
        {
            try
            {
                var p = definition.GetType().GetProperty("CategoryId", BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(definition, null);
                if (raw is ElementId id && RevitBridge.Common.ElementIdCompat.GetValue(id) > 0) return RevitBridge.Common.ElementIdCompat.GetValue(id);
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static string? ReadFieldName(ScheduleField field, Document doc)
        {
            if (field == null) return null;
            try
            {
                var noArg = field.GetType().GetMethod("GetName", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                if (noArg != null)
                {
                    var raw = noArg.Invoke(field, null);
                    var text = raw?.ToString();
                    if (!string.IsNullOrWhiteSpace(text)) return text;
                }

                var docArg = field.GetType().GetMethod("GetName", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(Document) }, null);
                if (docArg != null)
                {
                    var raw = docArg.Invoke(field, new object[] { doc });
                    var text = raw?.ToString();
                    if (!string.IsNullOrWhiteSpace(text)) return text;
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static bool? TryGetBoolProperty(object obj, string propName)
        {
            try
            {
                var p = obj.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(obj, null);
                if (raw is bool b) return b;
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static string? TryGetStringProperty(object obj, string propName)
        {
            try
            {
                var p = obj.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(obj, null);
                var text = raw?.ToString();
                return string.IsNullOrWhiteSpace(text) ? null : text;
            }
            catch
            {
                return null;
            }
        }

        private static string? TryGetPropertyText(object obj, string propName)
        {
            try
            {
                var p = obj.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(obj, null);
                var text = raw?.ToString();
                return string.IsNullOrWhiteSpace(text) ? null : text;
            }
            catch
            {
                return null;
            }
        }
    }
}

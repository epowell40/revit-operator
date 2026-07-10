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
    public sealed class ConfigureScheduleHandler : IRequestHandler
    {
        public sealed class FilterSpec
        {
            public string? field { get; set; }
            public string? op { get; set; } // equals|not_equals|contains|not_contains|begins_with|ends_with
            public string? value { get; set; }
        }

        public sealed class SortGroupSpec
        {
            public string? field { get; set; }
            public bool? ascending { get; set; }
            public bool? showHeader { get; set; }
            public bool? showFooter { get; set; }
            public bool? showBlankLine { get; set; }
            public bool? showFooterCount { get; set; }
            public bool? showFooterTitle { get; set; }
        }

        public sealed class ColumnWidthSpec
        {
            public string? field { get; set; }
            public double? widthFeet { get; set; }
        }

        public sealed class RowHeightSpec
        {
            public string? section { get; set; } // header|body|summary|footer
            public int? rowNumber { get; set; }
            public double? heightFeet { get; set; }
        }

        public sealed class CalculatedFieldSpec
        {
            public string? name { get; set; }
            public string? formula { get; set; }
            public string? valueType { get; set; } // number|integer|currency|text|percentage
        }

        public sealed class FieldFormatSpec
        {
            public string? field { get; set; }
            public string? heading { get; set; }
            public string? headingOrientation { get; set; } // horizontal|vertical
            public string? horizontalAlignment { get; set; } // left|center|right
            public bool? hidden { get; set; }
            public double? widthFeet { get; set; } // convenience alias to column width
            public int[]? textColorRgb { get; set; } // [r,g,b]
            public int[]? backgroundColorRgb { get; set; } // [r,g,b]
        }

        public sealed class ConditionalFormatSpec
        {
            public string? field { get; set; }
            public string? op { get; set; } // equals|not_equals|contains|not_contains|begins_with|ends_with|greater|greater_or_equal|less|less_or_equal|has_value|has_no_value
            public string? value { get; set; }
            public int[]? textColorRgb { get; set; } // [r,g,b]
            public int[]? backgroundColorRgb { get; set; } // [r,g,b]
        }

        public sealed class AppearanceSpec
        {
            public bool? showTitle { get; set; }
            public bool? showHeaders { get; set; }
            public bool? stripedRows { get; set; }
            public bool? freezeHeaders { get; set; } // best-effort per API support
        }

        public sealed class Params
        {
            public long? scheduleId { get; set; }
            public string? query { get; set; }
            public bool? exact { get; set; }

            public List<string>? addFields { get; set; }
            public List<FilterSpec>? filters { get; set; }
            public bool? replaceFilters { get; set; }

            public List<SortGroupSpec>? sortGroup { get; set; }
            public bool? replaceSortGroup { get; set; }
            public bool? showGrandTotals { get; set; }

            public List<ColumnWidthSpec>? columnWidths { get; set; }
            public List<RowHeightSpec>? rowHeights { get; set; }
            public List<CalculatedFieldSpec>? calculatedFields { get; set; }
            public List<FieldFormatSpec>? fieldFormats { get; set; }
            public List<ConditionalFormatSpec>? conditionalFormats { get; set; }
            public AppearanceSpec? appearance { get; set; }
            public bool? filterBySheet { get; set; }

            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var exact = p.exact ?? false;
            var schedule = ScheduleSelectionHelper.ResolveSchedule(doc, p.scheduleId, p.query, exact);
            if (schedule == null)
            {
                throw new InvalidOperationException("Schedule not found. Provide scheduleId or query.");
            }

            var hasAddFields = p.addFields != null && p.addFields.Any(x => !string.IsNullOrWhiteSpace(x));
            var hasFilters = p.filters != null;
            var hasSort = p.sortGroup != null || p.showGrandTotals.HasValue;
            var hasColumnWidths = p.columnWidths != null && p.columnWidths.Count > 0;
            var hasRowHeights = p.rowHeights != null && p.rowHeights.Count > 0;
            var hasCalculatedFields = p.calculatedFields != null && p.calculatedFields.Count > 0;
            var hasFieldFormats = p.fieldFormats != null && p.fieldFormats.Count > 0;
            var hasConditionalFormats = p.conditionalFormats != null && p.conditionalFormats.Count > 0;
            var hasAppearance = p.appearance != null;
            var hasFilterBySheet = p.filterBySheet.HasValue;

            if (!hasAddFields && !hasFilters && !hasSort && !hasColumnWidths && !hasRowHeights && !hasCalculatedFields && !hasFieldFormats && !hasConditionalFormats && !hasAppearance && !hasFilterBySheet)
            {
                throw new InvalidOperationException("configure-schedule requires at least one operation (addFields, filters, sortGroup/showGrandTotals, columnWidths, rowHeights, calculatedFields, fieldFormats, conditionalFormats, appearance, filterBySheet).");
            }

            var dryRun = p.dryRun ?? false;
            var plan = BuildPlan(doc, schedule, p);
            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    schedule = new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(schedule.Id),
                        name = schedule.Name
                    },
                    plan
                });
            }

            var applySummary = ApplyOperations(doc, schedule, p);
            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                schedule = new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(schedule.Id),
                    name = schedule.Name,
                    fieldCount = ScheduleSelectionHelper.SafeGetFieldCount(schedule.Definition)
                },
                applied = applySummary
            });
        }

        private static object BuildPlan(Document doc, ViewSchedule schedule, Params p)
        {
            var definition = schedule.Definition;
            var existingNames = ScheduleSelectionHelper.GetFields(schedule)
                .Select(f => (ScheduleSelectionHelper.ReadFieldName(f, doc) ?? "").Trim())
                .Where(n => n.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
                .ToList();

            var addFieldPlan = new List<object>();
            var requestedFields = (p.addFields ?? new List<string>())
                .Select(x => (x ?? "").Trim())
                .Where(x => x.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            foreach (var name in requestedFields)
            {
                var already = existingNames.Any(x => x.Equals(name, StringComparison.OrdinalIgnoreCase));
                var schedulable = FindSchedulableFieldByName(schedule, doc, name) != null;
                addFieldPlan.Add(new
                {
                    field = name,
                    alreadyPresent = already,
                    schedulableFound = schedulable,
                    willAdd = !already && schedulable
                });
            }

            var filterPlan = (p.filters ?? new List<FilterSpec>()).Select(f => new
            {
                field = (f.field ?? "").Trim(),
                op = NormalizeFilterOp(f.op),
                value = f.value,
                fieldFound = ScheduleSelectionHelper.FindFieldByName(schedule, doc, (f.field ?? "").Trim()) != null
            }).ToList();

            var sortPlan = (p.sortGroup ?? new List<SortGroupSpec>()).Select(s => new
            {
                field = (s.field ?? "").Trim(),
                ascending = s.ascending ?? true,
                fieldFound = ScheduleSelectionHelper.FindFieldByName(schedule, doc, (s.field ?? "").Trim()) != null,
                s.showHeader,
                s.showFooter,
                s.showBlankLine,
                s.showFooterCount,
                s.showFooterTitle
            }).ToList();

            var widthPlan = (p.columnWidths ?? new List<ColumnWidthSpec>()).Select(c => new
            {
                field = (c.field ?? "").Trim(),
                widthFeet = c.widthFeet,
                fieldFound = ScheduleSelectionHelper.FindFieldByName(schedule, doc, (c.field ?? "").Trim()) != null
            }).ToList();

            var rowHeightPlan = (p.rowHeights ?? new List<RowHeightSpec>()).Select(h => BuildRowHeightPlanItem(schedule, h)).ToList();

            var calculatedPlan = (p.calculatedFields ?? new List<CalculatedFieldSpec>()).Select(c => new
            {
                name = (c.name ?? "").Trim(),
                formula = c.formula,
                valueType = (c.valueType ?? "number").Trim().ToLowerInvariant(),
                alreadyPresent = existingNames.Any(x => x.Equals((c.name ?? "").Trim(), StringComparison.OrdinalIgnoreCase))
            }).ToList();

            var fieldFormatPlan = (p.fieldFormats ?? new List<FieldFormatSpec>()).Select(f => new
            {
                field = (f.field ?? "").Trim(),
                fieldFound = ScheduleSelectionHelper.FindFieldByName(schedule, doc, (f.field ?? "").Trim()) != null,
                heading = f.heading,
                headingOrientation = f.headingOrientation,
                horizontalAlignment = f.horizontalAlignment,
                hidden = f.hidden,
                widthFeet = f.widthFeet,
                hasTextColor = TryParseColor(f.textColorRgb, out _),
                hasBackgroundColor = TryParseColor(f.backgroundColorRgb, out _)
            }).ToList();

            var conditionalPlan = (p.conditionalFormats ?? new List<ConditionalFormatSpec>()).Select(c => new
            {
                field = (c.field ?? "").Trim(),
                op = NormalizeFilterOp(c.op),
                value = c.value,
                fieldFound = ScheduleSelectionHelper.FindFieldByName(schedule, doc, (c.field ?? "").Trim()) != null,
                hasTextColor = TryParseColor(c.textColorRgb, out _),
                hasBackgroundColor = TryParseColor(c.backgroundColorRgb, out _)
            }).ToList();

            return new
            {
                addFields = new
                {
                    requestedCount = requestedFields.Count,
                    items = addFieldPlan
                },
                filters = new
                {
                    replace = p.replaceFilters ?? true,
                    requestedCount = filterPlan.Count,
                    items = filterPlan
                },
                sortGroup = new
                {
                    replace = p.replaceSortGroup ?? true,
                    requestedCount = sortPlan.Count,
                    showGrandTotals = p.showGrandTotals,
                    items = sortPlan
                },
                columnWidths = new
                {
                    requestedCount = widthPlan.Count,
                    items = widthPlan
                },
                rowHeights = new
                {
                    requestedCount = rowHeightPlan.Count,
                    items = rowHeightPlan
                },
                calculatedFields = new
                {
                    requestedCount = calculatedPlan.Count,
                    items = calculatedPlan
                },
                fieldFormats = new
                {
                    requestedCount = fieldFormatPlan.Count,
                    items = fieldFormatPlan
                },
                conditionalFormats = new
                {
                    requestedCount = conditionalPlan.Count,
                    items = conditionalPlan
                },
                appearance = new
                {
                    showTitle = p.appearance?.showTitle,
                    showHeaders = p.appearance?.showHeaders,
                    stripedRows = p.appearance?.stripedRows,
                    freezeHeaders = p.appearance?.freezeHeaders
                },
                filterBySheet = p.filterBySheet
            };
        }

        private static object ApplyOperations(Document doc, ViewSchedule schedule, Params p)
        {
            var addResults = new List<object>();
            var filterResults = new List<object>();
            var sortResults = new List<object>();
            var widthResults = new List<object>();
            var rowHeightResults = new List<object>();
            var calculatedResults = new List<object>();
            var fieldFormatResults = new List<object>();
            var conditionalResults = new List<object>();
            var appearanceResults = new List<object>();
            var filterBySheetResults = new List<object>();

            using (var tx = new Transaction(doc, "Configure Schedule"))
            {
                tx.Start();

                if (p.addFields != null)
                {
                    ApplyAddFields(doc, schedule, p.addFields, addResults);
                }

                if (p.filters != null)
                {
                    ApplyFilters(doc, schedule, p.filters, p.replaceFilters ?? true, filterResults);
                }

                if (p.sortGroup != null || p.showGrandTotals.HasValue)
                {
                    ApplySortGroup(doc, schedule, p.sortGroup ?? new List<SortGroupSpec>(), p.replaceSortGroup ?? true, p.showGrandTotals, sortResults);
                }

                if (p.columnWidths != null)
                {
                    ApplyColumnWidths(doc, schedule, p.columnWidths, widthResults);
                }

                if (p.rowHeights != null)
                {
                    ApplyRowHeights(schedule, p.rowHeights, rowHeightResults);
                }

                if (p.calculatedFields != null)
                {
                    ApplyCalculatedFields(schedule, p.calculatedFields, calculatedResults);
                }

                if (p.fieldFormats != null)
                {
                    ApplyFieldFormats(doc, schedule, p.fieldFormats, fieldFormatResults);
                }

                if (p.conditionalFormats != null)
                {
                    ApplyConditionalFormats(doc, schedule, p.conditionalFormats, conditionalResults);
                }

                if (p.appearance != null)
                {
                    ApplyAppearance(schedule, p.appearance, appearanceResults);
                }

                if (p.filterBySheet.HasValue)
                {
                    ApplyFilterBySheet(schedule, p.filterBySheet.Value, filterBySheetResults);
                }

                tx.Commit();
            }

            return new
            {
                addFields = addResults,
                filters = filterResults,
                sortGroup = sortResults,
                columnWidths = widthResults,
                rowHeights = rowHeightResults,
                calculatedFields = calculatedResults,
                fieldFormats = fieldFormatResults,
                conditionalFormats = conditionalResults,
                appearance = appearanceResults,
                filterBySheet = filterBySheetResults
            };
        }

        private static void ApplyAddFields(Document doc, ViewSchedule schedule, List<string> addFields, List<object> addResults)
        {
            var requested = addFields
                .Select(x => (x ?? "").Trim())
                .Where(x => x.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            foreach (var name in requested)
            {
                var existing = ScheduleSelectionHelper.FindFieldByName(schedule, doc, name);
                if (existing != null)
                {
                    addResults.Add(new { field = name, status = "AlreadyPresent" });
                    continue;
                }

                var sf = FindSchedulableFieldByName(schedule, doc, name);
                if (sf == null)
                {
                    addResults.Add(new { field = name, status = "NotSchedulable" });
                    continue;
                }

                if (!TryAddField(schedule.Definition, sf, out var reason))
                {
                    addResults.Add(new { field = name, status = "Failed", reason });
                    continue;
                }

                addResults.Add(new { field = name, status = "Added" });
            }
        }

        private static void ApplyFilters(Document doc, ViewSchedule schedule, List<FilterSpec> filters, bool replaceFilters, List<object> filterResults)
        {
            var definition = schedule.Definition;
            if (replaceFilters)
            {
                TryClearFilters(definition);
            }

            foreach (var f in filters)
            {
                var fieldName = (f.field ?? "").Trim();
                if (fieldName.Length == 0)
                {
                    filterResults.Add(new { field = fieldName, status = "Skipped", reason = "field is required" });
                    continue;
                }

                var field = ScheduleSelectionHelper.FindFieldByName(schedule, doc, fieldName);
                if (field == null)
                {
                    filterResults.Add(new { field = fieldName, status = "NotFound" });
                    continue;
                }

                if (!TryParseFilterType(f.op, out var filterType, out var normalizedOp, out var valueRequired, out var parseReason))
                {
                    filterResults.Add(new { field = fieldName, status = "Skipped", op = NormalizeFilterOp(f.op), reason = parseReason });
                    continue;
                }

                var value = (f.value ?? "").Trim();
                if (valueRequired && value.Length == 0)
                {
                    filterResults.Add(new { field = fieldName, status = "Skipped", op = normalizedOp, reason = "value is required" });
                    continue;
                }

                if (!TryAddFilter(definition, field.FieldId, filterType, value, valueRequired, out var addReason))
                {
                    filterResults.Add(new { field = fieldName, status = "Failed", op = normalizedOp, reason = addReason });
                    continue;
                }

                filterResults.Add(new { field = fieldName, status = "Applied", op = normalizedOp, value = valueRequired ? value : null });
            }
        }

        private static void ApplySortGroup(Document doc, ViewSchedule schedule, List<SortGroupSpec> sortGroup, bool replaceSortGroup, bool? showGrandTotals, List<object> sortResults)
        {
            var definition = schedule.Definition;
            if (replaceSortGroup)
            {
                TryClearSortGroup(definition);
            }

            foreach (var item in sortGroup)
            {
                var fieldName = (item.field ?? "").Trim();
                if (fieldName.Length == 0)
                {
                    sortResults.Add(new { field = fieldName, status = "Skipped", reason = "field is required" });
                    continue;
                }

                var field = ScheduleSelectionHelper.FindFieldByName(schedule, doc, fieldName);
                if (field == null)
                {
                    sortResults.Add(new { field = fieldName, status = "NotFound" });
                    continue;
                }

                var s = new ScheduleSortGroupField(field.FieldId);
                if (item.ascending.HasValue)
                {
                    TrySetSortOrder(s, item.ascending.Value);
                }

                TrySetOptionalBoolProperty(s, "ShowHeader", item.showHeader);
                TrySetOptionalBoolProperty(s, "ShowFooter", item.showFooter);
                TrySetOptionalBoolProperty(s, "ShowBlankLine", item.showBlankLine);
                TrySetOptionalBoolProperty(s, "ShowFooterCount", item.showFooterCount);
                TrySetOptionalBoolProperty(s, "ShowFooterTitle", item.showFooterTitle);

                if (!TryAddSortGroup(definition, s, out var reason))
                {
                    sortResults.Add(new { field = fieldName, status = "Failed", reason });
                    continue;
                }

                sortResults.Add(new
                {
                    field = fieldName,
                    status = "Applied",
                    ascending = item.ascending ?? true,
                    item.showHeader,
                    item.showFooter,
                    item.showBlankLine,
                    item.showFooterCount,
                    item.showFooterTitle
                });
            }

            if (showGrandTotals.HasValue)
            {
                var changed = TrySetBoolProperty(definition, new[] { "ShowGrandTotal", "ShowGrandTotals" }, showGrandTotals.Value);
                sortResults.Add(new
                {
                    field = "<definition>",
                    status = changed ? "Applied" : "Skipped",
                    setting = "showGrandTotals",
                    value = showGrandTotals.Value
                });
            }
        }

        private static void ApplyColumnWidths(Document doc, ViewSchedule schedule, List<ColumnWidthSpec> columnWidths, List<object> widthResults)
        {
            foreach (var item in columnWidths)
            {
                var fieldName = (item.field ?? "").Trim();
                if (fieldName.Length == 0)
                {
                    widthResults.Add(new { field = fieldName, status = "Skipped", reason = "field is required" });
                    continue;
                }

                if (!item.widthFeet.HasValue || item.widthFeet.Value <= 0 || item.widthFeet.Value > 100)
                {
                    widthResults.Add(new { field = fieldName, status = "Skipped", reason = "widthFeet must be > 0 and <= 100" });
                    continue;
                }

                var field = ScheduleSelectionHelper.FindFieldByName(schedule, doc, fieldName);
                if (field == null)
                {
                    widthResults.Add(new { field = fieldName, status = "NotFound" });
                    continue;
                }

                var width = item.widthFeet.Value;
                var setGrid = TrySetDoubleProperty(field, "GridColumnWidth", width);
                var setSheet = TrySetDoubleProperty(field, "SheetColumnWidth", width);

                widthResults.Add(new
                {
                    field = fieldName,
                    status = (setGrid || setSheet) ? "Applied" : "Skipped",
                    widthFeet = width,
                    appliedTo = new { grid = setGrid, sheet = setSheet }
                });
            }
        }

        private static object BuildRowHeightPlanItem(ViewSchedule schedule, RowHeightSpec item)
        {
            var sectionName = NormalizeSectionName(item.section);
            var validSection = TryParseSectionType(sectionName, out var sectionType);
            var validHeight = item.heightFeet.HasValue && item.heightFeet.Value > 0 && item.heightFeet.Value <= 10;
            var rowNumbers = new List<int>();
            var reason = "";

            if (validSection)
            {
                try
                {
                    var data = schedule.GetTableData().GetSectionData(sectionType);
                    rowNumbers = TargetRowNumbers(data, item.rowNumber, out reason);
                }
                catch (Exception ex)
                {
                    reason = ex.Message;
                }
            }

            return new
            {
                section = sectionName,
                rowNumber = item.rowNumber,
                heightFeet = item.heightFeet,
                sectionFound = validSection,
                validHeight,
                targetRows = rowNumbers,
                reason = string.IsNullOrWhiteSpace(reason) ? null : reason
            };
        }

        private static void ApplyRowHeights(ViewSchedule schedule, List<RowHeightSpec> rowHeights, List<object> results)
        {
            foreach (var item in rowHeights)
            {
                var sectionName = NormalizeSectionName(item.section);
                if (!TryParseSectionType(sectionName, out var sectionType))
                {
                    results.Add(new { section = sectionName, rowNumber = item.rowNumber, status = "Skipped", reason = "section must be header, body, summary, or footer" });
                    continue;
                }

                if (!item.heightFeet.HasValue || item.heightFeet.Value <= 0 || item.heightFeet.Value > 10)
                {
                    results.Add(new { section = sectionName, rowNumber = item.rowNumber, status = "Skipped", reason = "heightFeet must be > 0 and <= 10" });
                    continue;
                }

                if (sectionType == SectionType.Body && !item.rowNumber.HasValue)
                {
                    // Revit 2024+ exposes schedule-wide body height properties. Resolve
                    // them dynamically so the same net48 assembly still compiles against
                    // the Revit 2023 API; older hosts fall back to per-row heights below.
                    if (TryApplyScheduleBodyHeight(schedule, item.heightFeet.Value, sectionName, results))
                    {
                        continue;
                    }
                }

                TableSectionData data;
                try
                {
                    data = schedule.GetTableData().GetSectionData(sectionType);
                }
                catch (Exception ex)
                {
                    results.Add(new { section = sectionName, rowNumber = item.rowNumber, status = "Skipped", reason = ex.Message });
                    continue;
                }

                var rowNumbers = TargetRowNumbers(data, item.rowNumber, out var rowReason);
                if (rowNumbers.Count == 0)
                {
                    results.Add(new { section = sectionName, rowNumber = item.rowNumber, status = "Skipped", reason = rowReason.Length == 0 ? "no target rows" : rowReason });
                    continue;
                }

                foreach (var rowNumber in rowNumbers)
                {
                    var before = TryGetRowHeight(data, rowNumber);
                    try
                    {
                        data.SetRowHeight(rowNumber, item.heightFeet.Value);
                        results.Add(new
                        {
                            section = sectionName,
                            rowNumber,
                            status = "Applied",
                            beforeHeightFeet = before,
                            heightFeet = item.heightFeet.Value,
                            afterHeightFeet = TryGetRowHeight(data, rowNumber)
                        });
                    }
                    catch (Exception ex)
                    {
                        results.Add(new { section = sectionName, rowNumber, status = "Failed", beforeHeightFeet = before, heightFeet = item.heightFeet.Value, reason = ex.Message });
                    }
                }
            }
        }

        private static bool TryApplyScheduleBodyHeight(ViewSchedule schedule, double heightFeet, string sectionName, List<object> results)
        {
            var scheduleType = schedule.GetType();
            var overrideProperty = scheduleType.GetProperty("RowHeightOverride");
            var heightProperty = scheduleType.GetProperty("RowHeight");
            if (overrideProperty == null || heightProperty == null ||
                !overrideProperty.CanRead || !overrideProperty.CanWrite ||
                !heightProperty.CanRead || !heightProperty.CanWrite)
            {
                return false;
            }

            try
            {
                var beforeOverride = overrideProperty.GetValue(schedule);
                double? before = null;
                if (!string.Equals(beforeOverride?.ToString(), "None", StringComparison.OrdinalIgnoreCase) &&
                    heightProperty.GetValue(schedule) is double currentHeight)
                {
                    before = currentHeight;
                }

                var allRows = Enum.Parse(overrideProperty.PropertyType, "All", ignoreCase: true);
                overrideProperty.SetValue(schedule, allRows);
                heightProperty.SetValue(schedule, heightFeet);
                var after = heightProperty.GetValue(schedule) is double appliedHeight ? appliedHeight : (double?)null;
                results.Add(new
                {
                    section = sectionName,
                    rowNumber = (int?)null,
                    status = "Applied",
                    beforeOverride = beforeOverride?.ToString(),
                    beforeHeightFeet = before,
                    heightFeet,
                    afterHeightFeet = after,
                    appliedTo = "schedule_body"
                });
            }
            catch (Exception ex)
            {
                results.Add(new { section = sectionName, rowNumber = (int?)null, status = "Failed", heightFeet, reason = ex.Message });
            }

            return true;
        }

        private static void ApplyCalculatedFields(ViewSchedule schedule, List<CalculatedFieldSpec> calculatedFields, List<object> results)
        {
            foreach (var item in calculatedFields)
            {
                var name = (item.name ?? "").Trim();
                var formula = (item.formula ?? "").Trim();
                var valueType = (item.valueType ?? "number").Trim();

                if (name.Length == 0)
                {
                    results.Add(new { name, status = "Skipped", reason = "name is required" });
                    continue;
                }

                if (formula.Length == 0)
                {
                    results.Add(new { name, status = "Skipped", reason = "formula is required" });
                    continue;
                }

                if (TryFindFieldByName(schedule, name, out _))
                {
                    results.Add(new { name, status = "AlreadyPresent" });
                    continue;
                }

                if (!TryAddCalculatedField(schedule.Definition, name, formula, valueType, out var reason))
                {
                    results.Add(new { name, status = "Failed", reason });
                    continue;
                }

                results.Add(new { name, status = "Added", valueType });
            }
        }

        private static void ApplyFieldFormats(Document doc, ViewSchedule schedule, List<FieldFormatSpec> fieldFormats, List<object> results)
        {
            foreach (var item in fieldFormats)
            {
                var fieldName = (item.field ?? "").Trim();
                if (fieldName.Length == 0)
                {
                    results.Add(new { field = fieldName, status = "Skipped", reason = "field is required" });
                    continue;
                }

                var field = ScheduleSelectionHelper.FindFieldByName(schedule, doc, fieldName);
                if (field == null)
                {
                    results.Add(new { field = fieldName, status = "NotFound" });
                    continue;
                }

                var changed = false;
                changed |= TrySetStringProperty(field, new[] { "ColumnHeading", "Heading" }, item.heading);
                changed |= TrySetEnumProperty(field, "HeadingOrientation", item.headingOrientation);
                changed |= TrySetEnumProperty(field, "HorizontalAlignment", item.horizontalAlignment);

                if (item.hidden.HasValue)
                {
                    changed |= TrySetBoolProperty(field, new[] { "IsHidden", "Hidden" }, item.hidden.Value);
                }

                if (item.widthFeet.HasValue && item.widthFeet.Value > 0 && item.widthFeet.Value <= 100)
                {
                    changed |= TrySetDoubleProperty(field, "GridColumnWidth", item.widthFeet.Value);
                    changed |= TrySetDoubleProperty(field, "SheetColumnWidth", item.widthFeet.Value);
                }

                var styleChanged = TryApplyFieldStyle(field, item.textColorRgb, item.backgroundColorRgb, out var styleReason);
                changed |= styleChanged;

                results.Add(new
                {
                    field = fieldName,
                    status = changed ? "Applied" : "Skipped",
                    reason = changed ? null : styleReason
                });
            }
        }

        private static void ApplyConditionalFormats(Document doc, ViewSchedule schedule, List<ConditionalFormatSpec> conditionalFormats, List<object> results)
        {
            foreach (var item in conditionalFormats)
            {
                var fieldName = (item.field ?? "").Trim();
                if (fieldName.Length == 0)
                {
                    results.Add(new { field = fieldName, status = "Skipped", reason = "field is required" });
                    continue;
                }

                var field = ScheduleSelectionHelper.FindFieldByName(schedule, doc, fieldName);
                if (field == null)
                {
                    results.Add(new { field = fieldName, status = "NotFound" });
                    continue;
                }

                var op = NormalizeFilterOp(item.op);
                if (!TryApplyConditionalFormat(schedule.Definition, field.FieldId, op, item.value, item.textColorRgb, item.backgroundColorRgb, out var reason))
                {
                    results.Add(new { field = fieldName, op, status = "Failed", reason });
                    continue;
                }

                results.Add(new { field = fieldName, op, status = "Applied" });
            }
        }

        private static void ApplyAppearance(ViewSchedule schedule, AppearanceSpec appearance, List<object> results)
        {
            var changed = false;

            if (appearance.showTitle.HasValue)
            {
                var applied = TrySetScheduleBoolProperty(
                    schedule,
                    new[] { "ShowTitle", "IsTitleVisible", "ShowScheduleTitle" },
                    appearance.showTitle.Value,
                    out var readback);
                changed |= applied;
                results.Add(new { setting = "showTitle", status = applied ? "Applied" : "Skipped", value = appearance.showTitle.Value, readback });
            }

            if (appearance.showHeaders.HasValue)
            {
                var applied = TrySetScheduleBoolProperty(
                    schedule,
                    new[] { "ShowHeaders", "IsHeaderVisible", "ShowColumnHeaders", "ShowHeadersOnSheet" },
                    appearance.showHeaders.Value,
                    out var readback);
                changed |= applied;
                results.Add(new { setting = "showHeaders", status = applied ? "Applied" : "Skipped", value = appearance.showHeaders.Value, readback });
            }

            if (appearance.stripedRows.HasValue)
            {
                var applied = TrySetBoolProperty(
                    schedule,
                    new[] { "ShowStripeRows", "ShowStripedRows", "UseStripedRowsOnSheets", "UseStripedRows" },
                    appearance.stripedRows.Value);
                changed |= applied;
                results.Add(new { setting = "stripedRows", status = applied ? "Applied" : "Skipped", value = appearance.stripedRows.Value });
            }

            if (appearance.freezeHeaders.HasValue)
            {
                var applied = TrySetBoolProperty(
                    schedule,
                    new[] { "FreezeHeaders", "FreezeColumnHeaders", "FreezeGridHeaders" },
                    appearance.freezeHeaders.Value);
                changed |= applied;
                results.Add(new { setting = "freezeHeaders", status = applied ? "Applied" : "Skipped", value = appearance.freezeHeaders.Value });
            }

            if (!changed && results.Count == 0)
            {
                results.Add(new { status = "Skipped", reason = "no appearance settings supplied" });
            }
        }

        private static void ApplyFilterBySheet(ViewSchedule schedule, bool enabled, List<object> results)
        {
            var applied = TrySetBoolProperty(schedule.Definition, new[] { "IsFilteredBySheet", "FilterBySheet", "FilteredBySheet" }, enabled);
            results.Add(new
            {
                setting = "filterBySheet",
                value = enabled,
                status = applied ? "Applied" : "Skipped"
            });
        }

        private static SchedulableField? FindSchedulableFieldByName(ViewSchedule schedule, Document doc, string fieldName)
        {
            var target = (fieldName ?? "").Trim();
            if (target.Length == 0) return null;

            try
            {
                return schedule.Definition.GetSchedulableFields()
                    .FirstOrDefault(sf =>
                    {
                        try
                        {
                            var n = (sf.GetName(doc) ?? "").Trim();
                            return n.Equals(target, StringComparison.OrdinalIgnoreCase);
                        }
                        catch
                        {
                            return false;
                        }
                    });
            }
            catch
            {
                return null;
            }
        }

        private static bool TryAddField(ScheduleDefinition definition, SchedulableField schedulableField, out string? reason)
        {
            try
            {
                var addBySchedulable = definition.GetType().GetMethod("AddField", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(SchedulableField) }, null);
                if (addBySchedulable != null)
                {
                    addBySchedulable.Invoke(definition, new object[] { schedulableField });
                    reason = null;
                    return true;
                }

                var fieldType = ScheduleFieldType.Instance;
                var fieldTypeProp = schedulableField.GetType().GetProperty("FieldType", BindingFlags.Instance | BindingFlags.Public);
                if (fieldTypeProp?.GetValue(schedulableField, null) is ScheduleFieldType resolved)
                {
                    fieldType = resolved;
                }

                definition.AddField(fieldType, schedulableField.ParameterId);
                reason = null;
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        private static string NormalizeFilterOp(string? op)
        {
            var key = (op ?? "equals").Trim().ToLowerInvariant().Replace("-", "_").Replace(" ", "_");
            return key;
        }

        private static bool TryParseFilterType(string? op, out ScheduleFilterType filterType, out string normalizedOp, out bool valueRequired, out string? reason)
        {
            normalizedOp = NormalizeFilterOp(op);
            valueRequired = true;
            reason = null;

            var enumName = normalizedOp switch
            {
                "equals" => "Equal",
                "not_equals" => "NotEqual",
                "contains" => "Contains",
                "not_contains" => "NotContains",
                "begins_with" => "BeginsWith",
                "ends_with" => "EndsWith",
                "has_value" => "HasValue",
                "has_no_value" => "HasNoValue",
                _ => ""
            };

            if (enumName.Length == 0)
            {
                filterType = default;
                reason = "Unsupported filter op. Use equals, not_equals, contains, not_contains, begins_with, ends_with, has_value, or has_no_value.";
                return false;
            }

            if (!Enum.TryParse(enumName, true, out filterType))
            {
                reason = $"Filter op '{normalizedOp}' is not supported by this Revit API version.";
                return false;
            }

            valueRequired = !(normalizedOp == "has_value" || normalizedOp == "has_no_value");
            return true;
        }

        private static bool TryAddFilter(ScheduleDefinition definition, ScheduleFieldId fieldId, ScheduleFilterType filterType, string value, bool valueRequired, out string? reason)
        {
            reason = null;
            try
            {
                ScheduleFilter filter;
                if (!valueRequired)
                {
                    var noValueCtor = typeof(ScheduleFilter).GetConstructor(new[] { typeof(ScheduleFieldId), typeof(ScheduleFilterType) });
                    if (noValueCtor == null)
                    {
                        reason = "Revit API does not expose no-value schedule filters in this version.";
                        return false;
                    }

                    filter = (ScheduleFilter)noValueCtor.Invoke(new object[] { fieldId, filterType });
                }
                else
                {
                    var withStringCtor = typeof(ScheduleFilter).GetConstructor(new[] { typeof(ScheduleFieldId), typeof(ScheduleFilterType), typeof(string) });
                    if (withStringCtor != null)
                    {
                        filter = (ScheduleFilter)withStringCtor.Invoke(new object[] { fieldId, filterType, value });
                    }
                    else
                    {
                        filter = new ScheduleFilter(fieldId, filterType, value);
                    }
                }

                definition.AddFilter(filter);
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        private static void TryClearFilters(ScheduleDefinition definition)
        {
            try
            {
                var clear = definition.GetType().GetMethod("ClearFilters", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                if (clear != null)
                {
                    clear.Invoke(definition, null);
                    return;
                }

                var getCount = definition.GetType().GetMethod("GetFilterCount", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                var remove = definition.GetType().GetMethod("RemoveFilter", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(int) }, null);
                if (getCount != null && remove != null)
                {
                    var count = (int)(getCount.Invoke(definition, null) ?? 0);
                    for (var i = count - 1; i >= 0; i--)
                    {
                        remove.Invoke(definition, new object[] { i });
                    }
                }
            }
            catch
            {
                // ignore best-effort clear
            }
        }

        private static void TryClearSortGroup(ScheduleDefinition definition)
        {
            try
            {
                var clear = definition.GetType().GetMethod("ClearSortGroupFields", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                if (clear != null)
                {
                    clear.Invoke(definition, null);
                    return;
                }

                var getCount = definition.GetType().GetMethod("GetSortGroupFieldCount", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                var remove = definition.GetType().GetMethod("RemoveSortGroupField", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(int) }, null);
                if (getCount != null && remove != null)
                {
                    var count = (int)(getCount.Invoke(definition, null) ?? 0);
                    for (var i = count - 1; i >= 0; i--)
                    {
                        remove.Invoke(definition, new object[] { i });
                    }
                }
            }
            catch
            {
                // ignore best-effort clear
            }
        }

        private static bool TryAddSortGroup(ScheduleDefinition definition, ScheduleSortGroupField item, out string? reason)
        {
            reason = null;
            try
            {
                var add = definition.GetType().GetMethod("AddSortGroupField", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(ScheduleSortGroupField) }, null);
                if (add == null)
                {
                    reason = "Revit API does not expose AddSortGroupField in this version.";
                    return false;
                }

                add.Invoke(definition, new object[] { item });
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        private static void TrySetSortOrder(ScheduleSortGroupField field, bool ascending)
        {
            try
            {
                var p = field.GetType().GetProperty("SortOrder", BindingFlags.Instance | BindingFlags.Public);
                if (p == null || !p.CanWrite || !p.PropertyType.IsEnum) return;
                var enumName = ascending ? "Ascending" : "Descending";
                var parsed = Enum.Parse(p.PropertyType, enumName, true);
                p.SetValue(field, parsed, null);
            }
            catch
            {
                // ignore
            }
        }

        private static void TrySetOptionalBoolProperty(object target, string propName, bool? value)
        {
            if (!value.HasValue) return;
            TrySetBoolProperty(target, new[] { propName }, value.Value);
        }

        private static bool TrySetBoolProperty(object target, IEnumerable<string> candidateNames, bool value)
        {
            foreach (var name in candidateNames)
            {
                try
                {
                    var p = target.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
                    if (p == null || !p.CanWrite || p.PropertyType != typeof(bool)) continue;
                    p.SetValue(target, value, null);
                    return true;
                }
                catch
                {
                    // try next
                }
            }

            return false;
        }

        private static bool TrySetScheduleBoolProperty(ViewSchedule schedule, IEnumerable<string> candidateNames, bool value, out bool? readback)
        {
            var names = candidateNames.ToArray();
            var applied = TrySetBoolProperty(schedule, names, value);
            if (!applied)
            {
                try
                {
                    applied = TrySetBoolProperty(schedule.Definition, names, value);
                }
                catch
                {
                    applied = false;
                }
            }

            readback = TryGetBoolProperty(schedule, names);
            if (!readback.HasValue)
            {
                try
                {
                    readback = TryGetBoolProperty(schedule.Definition, names);
                }
                catch
                {
                    readback = null;
                }
            }

            return applied || readback == value;
        }

        private static bool TrySetStringProperty(object target, IEnumerable<string> candidateNames, string? value)
        {
            if (value == null) return false;
            var trimmed = value.Trim();

            foreach (var name in candidateNames)
            {
                try
                {
                    var p = target.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
                    if (p == null || !p.CanWrite || p.PropertyType != typeof(string)) continue;
                    p.SetValue(target, trimmed, null);
                    return true;
                }
                catch
                {
                    // try next
                }
            }

            return false;
        }

        private static bool? TryGetBoolProperty(object target, IEnumerable<string> candidateNames)
        {
            foreach (var name in candidateNames)
            {
                try
                {
                    var p = target.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
                    var raw = p?.GetValue(target, null);
                    if (raw is bool value) return value;
                }
                catch
                {
                    // try next
                }
            }

            return null;
        }

        private static bool TryParseEnumObject(Type enumType, string raw, out object? parsed)
        {
            parsed = null;
            if (enumType == null || !enumType.IsEnum) return false;

            var normalized = (raw ?? "").Trim();
            if (normalized.Length == 0) return false;

            foreach (var name in Enum.GetNames(enumType))
            {
                if (string.Equals(name, normalized, StringComparison.OrdinalIgnoreCase))
                {
                    parsed = Enum.Parse(enumType, name);
                    return true;
                }

                var simplified = name.Replace("_", "").Replace("-", "");
                var target = normalized.Replace("_", "").Replace("-", "");
                if (string.Equals(simplified, target, StringComparison.OrdinalIgnoreCase))
                {
                    parsed = Enum.Parse(enumType, name);
                    return true;
                }
            }

            return false;
        }

        private static bool TrySetEnumProperty(object target, string propertyName, string? value)
        {
            var raw = (value ?? "").Trim();
            if (raw.Length == 0) return false;

            try
            {
                var p = target.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
                if (p == null || !p.CanWrite || !p.PropertyType.IsEnum) return false;

                var normalized = raw.Replace("-", "_").Replace(" ", "_");
                if (TryParseEnumObject(p.PropertyType, normalized, out var parsed))
                {
                    p.SetValue(target, parsed, null);
                    return true;
                }

                return false;
            }
            catch
            {
                return false;
            }
        }

        private static bool TryFindFieldByName(ViewSchedule schedule, string name, out ScheduleField? field)
        {
            field = null;
            var target = (name ?? "").Trim();
            if (target.Length == 0) return false;

            try
            {
                var doc = schedule.Document;
                field = ScheduleSelectionHelper.FindFieldByName(schedule, doc, target);
                return field != null;
            }
            catch
            {
                return false;
            }
        }

        private static bool TryAddCalculatedField(ScheduleDefinition definition, string name, string formula, string valueType, out string? reason)
        {
            reason = null;

            if (TryAddCalculatedFieldViaGenericAddField(definition, name, formula, valueType, out reason))
            {
                return true;
            }

            try
            {
                var methods = definition.GetType()
                    .GetMethods(BindingFlags.Instance | BindingFlags.Public)
                    .Where(m =>
                        m.Name.IndexOf("Calculated", StringComparison.OrdinalIgnoreCase) >= 0 &&
                        m.Name.IndexOf("Field", StringComparison.OrdinalIgnoreCase) >= 0)
                    .ToList();

                foreach (var m in methods)
                {
                    if (TryInvokeCalculatedMethod(definition, m, name, formula, valueType, out reason))
                    {
                        return true;
                    }
                }

                reason = reason ?? "No compatible calculated-field API was found in this Revit version.";
                return false;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        private static bool TryAddCalculatedFieldViaGenericAddField(ScheduleDefinition definition, string name, string formula, string valueType, out string? reason)
        {
            reason = null;
            try
            {
                var addOneArg = definition.GetType()
                    .GetMethods(BindingFlags.Instance | BindingFlags.Public)
                    .FirstOrDefault(m =>
                    {
                        if (!string.Equals(m.Name, "AddField", StringComparison.Ordinal)) return false;
                        var ps = m.GetParameters();
                        return ps.Length == 1 && ps[0].ParameterType.IsEnum;
                    });

                if (addOneArg == null) return false;

                var fieldTypeArg = addOneArg.GetParameters()[0];
                var enumValue = ResolveCalculatedFieldEnumValue(fieldTypeArg.ParameterType, valueType);
                if (enumValue == null)
                {
                    reason = $"No calculated/formula enum value found for type '{fieldTypeArg.ParameterType.Name}'.";
                    return false;
                }

                var created = addOneArg.Invoke(definition, new[] { enumValue });
                if (created == null)
                {
                    reason = "Calculated field creation returned null.";
                    return false;
                }

                var named = TrySetStringProperty(created, new[] { "ColumnHeading", "Heading", "Name" }, name);
                var formulaSet = TrySetStringProperty(created, new[] { "Formula" }, formula) ||
                                 TryInvokeStringMethod(created, new[] { "SetFormula", "SetCalculationFormula" }, formula);

                if (!formulaSet)
                {
                    reason = "Calculated field was created but formula assignment is not supported by this API.";
                    return false;
                }

                reason = named ? null : "Calculated field created/formula set, but heading rename was not supported.";
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        private static object? ResolveCalculatedFieldEnumValue(Type enumType, string valueType)
        {
            var wanted = new List<string>
            {
                "Formula",
                "CalculatedValue",
                "Calculated",
                "Percentage",
                "Number",
                (valueType ?? "").Trim()
            };

            foreach (var candidate in wanted)
            {
                if (candidate.Length == 0) continue;
                if (TryParseEnumObject(enumType, candidate, out var parsed))
                {
                    return parsed;
                }
            }

            return null;
        }

        private static bool TryInvokeCalculatedMethod(ScheduleDefinition definition, MethodInfo method, string name, string formula, string valueType, out string? reason)
        {
            reason = null;
            try
            {
                var ps = method.GetParameters();
                var args = new object?[ps.Length];
                var nameAssigned = false;
                var formulaAssigned = false;

                for (var i = 0; i < ps.Length; i++)
                {
                    var p = ps[i];
                    if (p.ParameterType == typeof(string))
                    {
                        if (!nameAssigned)
                        {
                            args[i] = name;
                            nameAssigned = true;
                        }
                        else if (!formulaAssigned)
                        {
                            args[i] = formula;
                            formulaAssigned = true;
                        }
                        else
                        {
                            args[i] = "";
                        }
                        continue;
                    }

                    if (p.ParameterType.IsEnum)
                    {
                        var enumValue = ResolveCalculatedFieldEnumValue(p.ParameterType, valueType);
                        if (enumValue == null)
                        {
                            reason = $"Could not resolve enum value for '{p.ParameterType.Name}'.";
                            return false;
                        }
                        args[i] = enumValue;
                        continue;
                    }

                    if (p.HasDefaultValue)
                    {
                        args[i] = p.DefaultValue;
                        continue;
                    }

                    if (!p.ParameterType.IsValueType)
                    {
                        args[i] = null;
                        continue;
                    }

                    args[i] = Activator.CreateInstance(p.ParameterType);
                }

                method.Invoke(definition, args!);
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        private static bool TryInvokeStringMethod(object target, IEnumerable<string> methodNames, string arg)
        {
            foreach (var name in methodNames)
            {
                try
                {
                    var m = target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(string) }, null);
                    if (m == null) continue;
                    m.Invoke(target, new object[] { arg });
                    return true;
                }
                catch
                {
                    // try next
                }
            }

            return false;
        }

        private static bool TryApplyFieldStyle(ScheduleField field, int[]? textColorRgb, int[]? backgroundColorRgb, out string? reason)
        {
            reason = null;
            try
            {
                var styleType = field.GetType().Assembly.GetType("Autodesk.Revit.DB.TableCellStyle");
                if (styleType == null)
                {
                    reason = "TableCellStyle API unavailable.";
                    return false;
                }

                var style = Activator.CreateInstance(styleType);
                if (style == null)
                {
                    reason = "Could not create TableCellStyle.";
                    return false;
                }

                var changed = false;
                if (TryParseColor(textColorRgb, out var textColor))
                {
                    changed |= TrySetObjectProperty(style, new[] { "TextColor", "FontColor" }, textColor);
                }

                if (TryParseColor(backgroundColorRgb, out var bgColor))
                {
                    changed |= TrySetObjectProperty(style, new[] { "BackgroundColor", "CellBackgroundColor" }, bgColor);
                }

                if (!changed)
                {
                    reason = "No style color values provided.";
                    return false;
                }

                var setStyle = field.GetType().GetMethod("SetStyle", BindingFlags.Instance | BindingFlags.Public, null, new[] { styleType }, null);
                if (setStyle == null)
                {
                    reason = "SetStyle API unavailable.";
                    return false;
                }

                setStyle.Invoke(field, new[] { style });
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        private static bool TryApplyConditionalFormat(ScheduleDefinition definition, ScheduleFieldId fieldId, string op, string? value, int[]? textColorRgb, int[]? backgroundColorRgb, out string? reason)
        {
            reason = null;
            try
            {
                var asm = definition.GetType().Assembly;
                var cfType = asm.GetType("Autodesk.Revit.DB.ScheduleConditionalFormat") ??
                             asm.GetType("Autodesk.Revit.DB.ConditionalFormat");
                if (cfType == null)
                {
                    reason = "Conditional-format API unavailable.";
                    return false;
                }

                object? cf = null;
                var ctorWithField = cfType.GetConstructor(new[] { typeof(ScheduleFieldId) });
                if (ctorWithField != null)
                {
                    cf = ctorWithField.Invoke(new object[] { fieldId });
                }
                else
                {
                    var ctorDefault = cfType.GetConstructor(Type.EmptyTypes);
                    if (ctorDefault != null)
                    {
                        cf = ctorDefault.Invoke(Array.Empty<object>());
                    }
                }

                if (cf == null)
                {
                    reason = "Could not create conditional format object.";
                    return false;
                }

                var changed = false;
                changed |= TrySetObjectProperty(cf, new[] { "FieldId", "ScheduleFieldId" }, fieldId);
                changed |= TrySetEnumProperty(cf, "Condition", op) || TrySetEnumProperty(cf, "FilterType", op);

                var valueRequired = !(op == "has_value" || op == "has_no_value");
                if (valueRequired)
                {
                    var rawValue = (value ?? "").Trim();
                    if (rawValue.Length == 0)
                    {
                        reason = "value is required for this conditional-format operator.";
                        return false;
                    }

                    changed |= TrySetStringProperty(cf, new[] { "Value", "StringValue" }, rawValue) ||
                               TrySetDoubleLikeProperty(cf, new[] { "Value", "NumberValue" }, rawValue);
                }

                if (TryParseColor(textColorRgb, out var textColor))
                {
                    changed |= TrySetObjectProperty(cf, new[] { "TextColor", "FontColor" }, textColor);
                }
                if (TryParseColor(backgroundColorRgb, out var bgColor))
                {
                    changed |= TrySetObjectProperty(cf, new[] { "BackgroundColor", "CellBackgroundColor" }, bgColor);
                }

                if (!changed)
                {
                    reason = "No conditional-format settings were applied.";
                    return false;
                }

                var add = definition.GetType().GetMethod("AddConditionalFormat", BindingFlags.Instance | BindingFlags.Public, null, new[] { cfType }, null);
                if (add == null)
                {
                    reason = "AddConditionalFormat API unavailable.";
                    return false;
                }

                add.Invoke(definition, new[] { cf });
                return true;
            }
            catch (Exception ex)
            {
                reason = ex.Message;
                return false;
            }
        }

        private static bool TrySetObjectProperty(object target, IEnumerable<string> candidateNames, object value)
        {
            foreach (var name in candidateNames)
            {
                try
                {
                    var p = target.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
                    if (p == null || !p.CanWrite) continue;
                    if (!p.PropertyType.IsAssignableFrom(value.GetType())) continue;
                    p.SetValue(target, value, null);
                    return true;
                }
                catch
                {
                    // try next
                }
            }
            return false;
        }

        private static bool TrySetDoubleLikeProperty(object target, IEnumerable<string> candidateNames, string rawValue)
        {
            if (!double.TryParse(rawValue, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var parsed))
            {
                return false;
            }

            foreach (var name in candidateNames)
            {
                try
                {
                    var p = target.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
                    if (p == null || !p.CanWrite) continue;

                    if (p.PropertyType == typeof(double))
                    {
                        p.SetValue(target, parsed, null);
                        return true;
                    }

                    if (p.PropertyType == typeof(float))
                    {
                        p.SetValue(target, (float)parsed, null);
                        return true;
                    }

                    if (p.PropertyType == typeof(int))
                    {
                        p.SetValue(target, (int)Math.Round(parsed), null);
                        return true;
                    }
                }
                catch
                {
                    // try next
                }
            }

            return false;
        }

        private static string NormalizeSectionName(string? raw)
        {
            var value = (raw ?? "body").Trim().ToLowerInvariant();
            if (value.Length == 0) return "body";
            return value;
        }

        private static bool TryParseSectionType(string sectionName, out SectionType sectionType)
        {
            switch (NormalizeSectionName(sectionName))
            {
                case "header":
                    sectionType = SectionType.Header;
                    return true;
                case "body":
                    sectionType = SectionType.Body;
                    return true;
                case "summary":
                    sectionType = SectionType.Summary;
                    return true;
                case "footer":
                    sectionType = SectionType.Footer;
                    return true;
                default:
                    sectionType = SectionType.None;
                    return false;
            }
        }

        private static List<int> TargetRowNumbers(TableSectionData data, int? requestedRowNumber, out string reason)
        {
            reason = "";
            var rows = new List<int>();

            if (requestedRowNumber.HasValue)
            {
                var row = requestedRowNumber.Value;
                if (data.IsValidRowNumber(row))
                {
                    rows.Add(row);
                }
                else
                {
                    reason = "rowNumber is not valid for this schedule section";
                }
                return rows;
            }

            for (var row = data.FirstRowNumber; row <= data.LastRowNumber; row++)
            {
                if (data.IsValidRowNumber(row))
                {
                    rows.Add(row);
                }
            }

            if (rows.Count == 0)
            {
                reason = "schedule section has no valid rows";
            }

            return rows;
        }

        private static double? TryGetRowHeight(TableSectionData data, int rowNumber)
        {
            try
            {
                return data.GetRowHeight(rowNumber);
            }
            catch
            {
                return null;
            }
        }

        private static bool TryParseColor(int[]? rgb, out Color color)
        {
            color = null!;
            if (rgb == null || rgb.Length != 3) return false;

            var r = Math.Max(0, Math.Min(255, rgb[0]));
            var g = Math.Max(0, Math.Min(255, rgb[1]));
            var b = Math.Max(0, Math.Min(255, rgb[2]));

            try
            {
                color = new Color((byte)r, (byte)g, (byte)b);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool TrySetDoubleProperty(object target, string propName, double value)
        {
            try
            {
                var p = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                if (p == null || !p.CanWrite) return false;
                if (p.PropertyType == typeof(double))
                {
                    p.SetValue(target, value, null);
                    return true;
                }
            }
            catch
            {
                // ignore
            }

            return false;
        }
    }
}

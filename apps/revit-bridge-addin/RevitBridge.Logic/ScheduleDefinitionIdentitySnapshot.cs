using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    // Current native state, shared by creation readback and independent detail.
    // Never infer these properties from the requested schedule kind or name.
    public static class ScheduleDefinitionIdentitySnapshot
    {
        public static object Read(ViewSchedule schedule)
        {
            try
            {
                var definition = schedule.Definition;
                var category = definition.CategoryId;
                var categoryId = ElementIdCompat.GetValue(category);
                var kind = definition.IsMaterialTakeoff ? "material_takeoff"
                    : definition.IsKeySchedule ? "key"
                    : categoryId == (long)BuiltInCategory.OST_Sheets ? "sheet_list"
                    : categoryId == (long)BuiltInCategory.OST_Views ? "view_list"
                    : categoryId == (long)BuiltInCategory.OST_KeynoteTags ? "keynote_legend"
                    : categoryId == -1 ? "multi_category" : "regular";
                bool? includeLinkedFiles = null;
                try { includeLinkedFiles = definition.IncludeLinkedFiles; } catch { }
                return new
                {
                    schema = "operator.schedule_definition_identity.v1",
                    complete = true,
                    id = ElementIdCompat.GetValue(schedule.Id),
                    uniqueId = schedule.UniqueId,
                    name = schedule.Name,
                    kind,
                    categoryId,
                    isTemplate = schedule.IsTemplate,
                    includeLinkedFiles
                };
            }
            catch
            {
                return new { schema = "operator.schedule_definition_identity.v1", complete = false };
            }
        }

        public static object CaptureDefinition(ViewSchedule schedule)
        {
            try
            {
                var definition = schedule.Definition;
                if (definition.HasEmbeddedSchedule || definition.GetFieldCount() > 200)
                    throw new InvalidOperationException("unsupported_embedded_or_large_definition");
                var fields = new List<object>();
                var indices = new Dictionary<int, int>();
                for (var index = 0; index < definition.GetFieldCount(); index++)
                {
                    var field = definition.GetField(index);
                    indices.Add(field.FieldId.IntegerValue, index);
                    // Revit exposes combined constituents, but not the full
                    // calculated-field expression through this reader.
                    if (field.IsCalculatedField)
                        throw new InvalidOperationException("unsupported_calculated_field");
                    fields.Add(new
                    {
                        index,
                        parameterId = ElementIdCompat.GetValue(field.ParameterId),
                        name = field.GetName(),
                        fieldType = field.FieldType.ToString(),
                        heading = field.ColumnHeading,
                        hidden = field.IsHidden,
                        gridWidth = field.GridColumnWidth,
                        sheetWidth = field.SheetColumnWidth,
                        horizontalAlignment = field.HorizontalAlignment.ToString(),
                        headingOrientation = field.HeadingOrientation.ToString(),
                        combined = field.IsCombinedParameterField ? field.GetCombinedParameters().Select(part => new
                        {
                            parameterId = ElementIdCompat.GetValue(part.ParamId),
                            categoryId = ElementIdCompat.GetValue(part.CategoryId),
                            part.Prefix, part.Separator, part.Suffix, part.SampleValue
                        }).ToArray() : null,
                        format = CaptureFormat(field.GetFormatOptions())
                    });
                }
                var filters = definition.GetFilters().Select(filter => new
                {
                    fieldIndex = indices[filter.FieldId.IntegerValue],
                    op = filter.FilterType.ToString(),
                    value = FilterValue(filter)
                }).ToArray();
                var sort = definition.GetSortGroupFields().Select(field => new
                {
                    fieldIndex = indices[field.FieldId.IntegerValue],
                    order = field.SortOrder.ToString(),
                    field.ShowHeader, field.ShowFooter, field.ShowFooterTitle,
                    field.ShowFooterCount, field.ShowBlankLine
                }).ToArray();
                var table = CaptureTable(schedule, out var tableStyles);
                return new
                {
                    schema = "operator.schedule_definition_snapshot.v1",
                    complete = true,
                    scope = "flat_definition_without_calculated_fields",
                    identity = Read(schedule),
                    definition = new
                    {
                        fields, filters, sort,
                        table, tableStyles,
                        definition.IsItemized,
                        phaseId = ElementParameterId(schedule, BuiltInParameter.VIEW_PHASE),
                        phaseFilterId = ElementParameterId(schedule, BuiltInParameter.VIEW_PHASE_FILTER),
                        templateId = ElementIdCompat.GetValue(schedule.ViewTemplateId),
                        appearance = new Dictionary<string, object?>
                        {
                            ["showTitle"] = Property(definition, "ShowTitle"),
                            ["showHeaders"] = Property(definition, "ShowHeaders"),
                            ["showGrandTotal"] = Property(definition, "ShowGrandTotal"),
                            ["showGrandTotalTitle"] = Property(definition, "ShowGrandTotalTitle"),
                            ["showGrandTotalCount"] = Property(definition, "ShowGrandTotalCount"),
                            ["grandTotalTitle"] = Property(definition, "GrandTotalTitle"),
                            ["filterBySheet"] = Property(definition, "IsFilteredBySheet"),
                            ["includeLinkedFiles"] = Property(definition, "IncludeLinkedFiles"),
                            ["titleTextTypeId"] = Property(schedule, "TitleTextTypeId"),
                            ["headerTextTypeId"] = Property(schedule, "HeaderTextTypeId"),
                            ["bodyTextTypeId"] = Property(schedule, "BodyTextTypeId")
                        }
                    }
                };
            }
            catch (Exception error)
            {
                return new { schema = "operator.schedule_definition_snapshot.v1", complete = false, reason = error.Message };
            }
        }

        private static long? ElementParameterId(ViewSchedule schedule, BuiltInParameter parameter)
        {
            var value = schedule.get_Parameter(parameter);
            return value == null ? (long?)null : ElementIdCompat.GetValue(value.AsElementId());
        }

        private static object[] CaptureTable(ViewSchedule schedule, out object[] tableStyles)
        {
            var table = schedule.GetTableData();
            var sections = new List<object>();
            var styles = new List<object>();
            var styleIndices = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var type in new[] { SectionType.Header, SectionType.Body })
            {
                var section = table.GetSectionData(type);
                if ((long)section.NumberOfRows * section.NumberOfColumns > 16384)
                    throw new InvalidOperationException("table_scope_exceeded");
                var rows = new List<object>();
                for (var row = section.FirstRowNumber; row <= section.LastRowNumber; row++)
                {
                    var cells = new List<object>();
                    for (var column = section.FirstColumnNumber; column <= section.LastColumnNumber; column++)
                    {
                        int styleIndex;
                        using (var style = section.GetTableCellStyle(row, column))
                        {
                            var observed = new { values = StyleProperties(style), overrides = StyleProperties(style.GetCellStyleOverrideOptions()) };
                            var key = JsonSerializer.Serialize(observed);
                            if (!styleIndices.TryGetValue(key, out styleIndex))
                            {
                                if (styles.Count >= 256) throw new InvalidOperationException("cell_style_scope_exceeded");
                                styleIndex = styles.Count; styleIndices.Add(key, styleIndex); styles.Add(observed);
                            }
                        }
                        var merged = section.GetMergedCell(row, column);
                        var text = schedule.GetCellText(type, row, column);
                        if (type == SectionType.Header && schedule.Definition.ShowTitle
                            && row == section.FirstRowNumber && text == schedule.Name)
                            text = "$native-schedule-title$";
                        cells.Add(new { column, text, styleIndex, merged.Top, merged.Left, merged.Bottom, merged.Right });
                    }
                    rows.Add(new { row, heightFeet = section.GetRowHeight(row), cells });
                }
                sections.Add(new { section = type.ToString(), section.NumberOfRows, section.NumberOfColumns, rows });
            }
            tableStyles = styles.ToArray();
            return sections.ToArray();
        }

        private static Dictionary<string, object?> StyleProperties(object target)
        {
            var values = new Dictionary<string, object?>();
            foreach (var property in target.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).OrderBy(p => p.Name, StringComparer.Ordinal))
            {
                if (!property.CanRead || property.GetIndexParameters().Length != 0 || property.Name == "IsValidObject") continue;
                var value = property.GetValue(target);
                if (value == null || value is string || value is bool || value is int || value is long || value is byte)
                    values.Add(property.Name, value);
                else if (value is double number && !double.IsNaN(number) && !double.IsInfinity(number)) values.Add(property.Name, number);
                else if (value is Enum) values.Add(property.Name, value.ToString());
                else if (value is ElementId id) values.Add(property.Name, ElementIdCompat.GetValue(id));
                else if (value is Color color) values.Add(property.Name, color.IsValid
                    ? new { valid = true, red = (int?)color.Red, green = (int?)color.Green, blue = (int?)color.Blue }
                    : new { valid = false, red = (int?)null, green = (int?)null, blue = (int?)null });
                else throw new InvalidOperationException("unsupported_cell_style_property:" + property.Name);
            }
            if (values.Count == 0) throw new InvalidOperationException("cell_style_observation_empty");
            return values;
        }

        private static object? Property(object target, string name)
        {
            var property = target.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
            if (property == null || !property.CanRead) return null;
            var value = property.GetValue(target);
            return value is ElementId id ? (object)ElementIdCompat.GetValue(id) : value;
        }

        private static object CaptureFormat(FormatOptions format)
        {
            if (format.UseDefault) return new { useDefault = true };
            return new
            {
                useDefault = false,
                unit = format.GetUnitTypeId().TypeId,
                symbol = format.GetSymbolTypeId().TypeId,
                format.Accuracy, format.UseDigitGrouping,
                format.SuppressLeadingZeros, format.SuppressTrailingZeros,
                format.SuppressSpaces, format.UsePlusPrefix
            };
        }

        private static object? FilterValue(ScheduleFilter filter)
        {
            if (filter.IsStringValue) return filter.GetStringValue();
            if (filter.IsIntegerValue) return filter.GetIntegerValue();
            if (filter.IsDoubleValue) return filter.GetDoubleValue();
            if (filter.IsElementIdValue) return ElementIdCompat.GetValue(filter.GetElementIdValue());
            if (filter.IsNullValue) return null;
            throw new InvalidOperationException("Unreadable filter value.");
        }
    }
}

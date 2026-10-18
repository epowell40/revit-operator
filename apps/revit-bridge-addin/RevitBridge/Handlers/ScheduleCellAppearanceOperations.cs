using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    /// <summary>Edits copied cell appearance only. Never regenerates from a template or writes cell text.</summary>
    internal static class ScheduleCellAppearanceOperations
    {
        private static readonly SectionType[] Sections = { SectionType.Header, SectionType.Body, SectionType.Summary, SectionType.Footer };
        private static readonly string[] PreservedProperties = {
            "FontVerticalAlignment", "FontHorizontalAlignment", "IsFontUnderline", "IsFontItalic", "IsFontBold",
            "BorderRightLineStyle", "BorderLeftLineStyle", "BorderBottomLineStyle", "BorderTopLineStyle",
            "TextOrientation", "TextColor", "TextSize", "FontName", "IsReadOnly", "IsEnabled"
        };

        private static TableView Resolve(Document doc, long id)
        {
            var view = doc.GetElement(ElementIdCompat.Create(id)) as TableView;
            if (view == null || view.IsTemplate || !(view is ViewSchedule || view is PanelScheduleView)
                || view is PanelScheduleView panel && panel.IsPanelScheduleTemplate())
                throw new ArgumentException("Target must be one host-owned schedule instance, not a shared template.");
            return view;
        }

        private static TableSectionData Section(TableView view, SectionType section)
            => view is PanelScheduleView panel ? panel.GetSectionData(section) : ((ViewSchedule)view).GetTableData().GetSectionData(section);

        private static int[]? Rgb(Color color) => color.IsValid ? new[] { (int)color.Red, (int)color.Green, (int)color.Blue } : null;
        private static string Hash(object value)
        {
            using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value)))).Replace("-", "").ToLowerInvariant();
        }
        private static object? Scalar(object? value)
            => value is Color color ? (object)Rgb(color) : value is ElementId id ? ElementIdCompat.GetValue(id)
                : value is Enum enumeration ? enumeration.ToString() : value;

        internal static Dictionary<string, object?> Style(TableCellStyle style, bool includePreservedProperties = false)
        {
            var preserved = new SortedDictionary<string, object?>(StringComparer.Ordinal);
            foreach (var property in PreservedProperties)
            {
                var info = typeof(TableCellStyle).GetProperty(property);
                if (info == null || !info.CanRead) throw new InvalidOperationException("Unobservable style property: " + property);
                preserved[property] = Scalar(info.GetValue(style));
            }
            // Keep every pre-existing override flag apart from the intentional background override.
            var flags = style.GetCellStyleOverrideOptions();
            foreach (var property in flags.GetType().GetProperties().Where(p => p.PropertyType == typeof(bool) && p.CanRead && p.Name != "IsValidObject" && p.Name != "BackgroundColor").OrderBy(p => p.Name))
                preserved["override:" + property.Name] = property.GetValue(flags);
            var result = new Dictionary<string, object?> {
                ["gridBackgroundColorRgb"] = Rgb(style.BackgroundColor), ["sheetBackgroundColorRgb"] = Rgb(style.SheetBackgroundColor),
                ["inactivePhaseShading"] = style.IsInactivePhaseload, ["isOverridden"] = style.IsOverridden,
                ["backgroundOverride"] = flags.BackgroundColor, ["preservedStyleHash"] = Hash(preserved)
            };
            if (includePreservedProperties)
            {
                result["preservedPropertiesSchema"] = "operator.table_cell_style_preserved_properties.v1";
                result["preservedProperties"] = preserved;
            }
            return result;
        }

        private static Dictionary<string, object?> Cell(TableView view, ScheduleCellLocator cell)
        {
            var sectionType = (SectionType)Enum.Parse(typeof(SectionType), ScheduleCellAppearanceContract.NormalizeSection(cell.section));
            using (var section = Section(view, sectionType))
            {
                var r = cell.row!.Value; var c = cell.column!.Value;
                if (r < section.FirstRowNumber || r > section.LastRowNumber || c < section.FirstColumnNumber || c > section.LastColumnNumber)
                    throw new ArgumentException("Cell is outside native section bounds: " + ScheduleCellAppearanceContract.Key(cell));
                var merged = section.GetMergedCell(r, c);
                if (r != merged.Top || c != merged.Left) throw new ArgumentException("Use the native top-left locator of a merged cell.");
                using (var style = section.GetTableCellStyle(r, c))
                {
                    var result = Style(style);
                    result["section"] = sectionType.ToString(); result["row"] = r; result["column"] = c;
                    result["text"] = view.GetCellText(sectionType, r, c);
                    result["allowOverride"] = section.AllowOverrideCellStyle(r, c);
                    result["mergedRange"] = new[] { merged.Top, merged.Left, merged.Bottom, merged.Right };
                    return result;
                }
            }
        }

        internal static object ReadAllCellsForPreservation(TableView view) => Preservation(view, Array.Empty<ScheduleCellLocator>());

        private static object Preservation(TableView view, IReadOnlyList<ScheduleCellLocator> targets)
        {
            var selected = targets.Select(c => Cell(view, c)).ToArray();
            var texts = new List<object>(); var otherStyles = new List<object>(); var timer = Stopwatch.StartNew(); var count = 0;
            foreach (var sectionType in Sections)
            {
                if (!view.IsValidSectionType(sectionType)) continue;
                using (var section = Section(view, sectionType))
                {
                    if (section.NumberOfRows == 0 || section.NumberOfColumns == 0) continue;
                    for (var r = section.FirstRowNumber; r <= section.LastRowNumber; r++)
                    for (var c = section.FirstColumnNumber; c <= section.LastColumnNumber; c++)
                    {
                        if (++count > 10000 || timer.ElapsedMilliseconds > 10000)
                            throw new InvalidOperationException("Complete table preservation audit exceeded its 10000-cell/10-second bound; no unproven edit is permitted.");
                        texts.Add(new { section = sectionType.ToString(), row = r, column = c, text = view.GetCellText(sectionType, r, c) });
                        var covered = selected.Any(t => (string)t["section"]! == sectionType.ToString()
                            && r >= ((int[])t["mergedRange"]!)[0] && r <= ((int[])t["mergedRange"]!)[2]
                            && c >= ((int[])t["mergedRange"]!)[1] && c <= ((int[])t["mergedRange"]!)[3]);
                        if (!covered) using (var style = section.GetTableCellStyle(r, c))
                            otherStyles.Add(new { section = sectionType.ToString(), row = r, column = c, style = Style(style) });
                    }
                }
            }
            return new { complete = true, totalCells = count, textHash = Hash(texts), unrequestedStyleHash = Hash(otherStyles) };
        }

        internal static object Read(Document doc, long scheduleId, IReadOnlyList<ScheduleCellLocator> cells)
        {
            var view = Resolve(doc, scheduleId);
            return new { schema = "operator.schedule_cell_appearance.v1", status = "Ok", action = "cell_styles", read_only = true,
                scheduleId, uniqueId = view.UniqueId, scheduleKind = view.ViewType.ToString(), complete = true,
                cells = cells.Select(c => Cell(view, c)).ToArray(), preservation = Preservation(view, cells) };
        }

        internal static Dictionary<string, object?> Edit(UIApplication app, Document doc, long scheduleId,
            IReadOnlyList<ScheduleCellBackgroundChange> changes, bool dryRun)
        {
            TableView view; Dictionary<string, object?>[] before; object preserved;
            try
            {
                view = Resolve(doc, scheduleId);
                before = changes.Select(c => Cell(view, c)).ToArray();
                for (var i = 0; i < changes.Count; i++)
                    if (before[i]["allowOverride"] is not true || !string.Equals((string?)before[i]["text"], changes[i].expectedText, StringComparison.Ordinal))
                        throw new ArgumentException("Cell is not overridable or expectedText is stale: " + ScheduleCellAppearanceContract.Key(changes[i]));
                preserved = Preservation(view, changes.Cast<ScheduleCellLocator>().ToArray());
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object?> { ["status"] = "Blocked", ["scheduleId"] = scheduleId,
                    ["error"] = ex.Message, ["applied"] = false, ["transaction"] = OperatorNativeTransactionReceipt.NotStarted() };
            }
            if (dryRun) return new Dictionary<string, object?> { ["status"] = "Dry Run", ["dryRun"] = true,
                ["previewExecuted"] = false, ["scheduleId"] = scheduleId, ["cells"] = before,
                ["transaction"] = OperatorNativeTransactionReceipt.NotStarted() };

            var result = RevitBridge.Logic.Handlers.NativeSingleTransaction.Execute(app, doc, "Set schedule cell backgrounds", created =>
            {
                foreach (var change in changes)
                {
                    var sectionType = (SectionType)Enum.Parse(typeof(SectionType), ScheduleCellAppearanceContract.NormalizeSection(change.section));
                    using (var section = Section(view, sectionType))
                    using (var old = section.GetTableCellStyle(change.row!.Value, change.column!.Value))
                    using (var style = new TableCellStyle(old))
                    {
                        var rgb = change.backgroundColorRgb!; var color = new Color((byte)rgb[0], (byte)rgb[1], (byte)rgb[2]);
                        var flags = style.GetCellStyleOverrideOptions(); flags.BackgroundColor = true;
                        // SheetBackgroundColor is an SDK-derived read-only value.
                        // Change only the writable background and check BOTH computed
                        // representations after regeneration; never synthesize a sheet color.
                        style.BackgroundColor = color;
                        style.SetCellStyleOverrideOptions(flags);
                        section.SetCellStyle(change.row.Value, change.column.Value, style);
                    }
                }
                doc.Regenerate();
                var after = changes.Select(c => Cell(view, c)).ToArray();
                var preservedAfter = Preservation(view, changes.Cast<ScheduleCellLocator>().ToArray());
                if (Hash(preserved) != Hash(preservedAfter)) throw new InvalidOperationException("Table text or unrequested cell styles changed; roll back.");
                for (var i = 0; i < changes.Count; i++)
                    if (!(after[i]["gridBackgroundColorRgb"] is int[] grid && grid.SequenceEqual(changes[i].backgroundColorRgb!))
                        || !(after[i]["sheetBackgroundColorRgb"] is int[] sheet && sheet.SequenceEqual(changes[i].backgroundColorRgb!))
                        || !Equals(before[i]["preservedStyleHash"], after[i]["preservedStyleHash"]))
                        throw new InvalidOperationException("Requested background or preserved cell style did not read back; roll back.");
                return new Dictionary<string, object?> { ["schema"] = "operator.schedule_cell_background_edit.v1",
                    ["scheduleId"] = scheduleId, ["uniqueId"] = view.UniqueId, ["scheduleKind"] = view.ViewType.ToString(),
                    ["preservationBefore"] = preserved, ["preservationAfter"] = preservedAfter,
                    ["cells"] = changes.Select((c, i) => new { section = ScheduleCellAppearanceContract.NormalizeSection(c.section), row = c.row, column = c.column, before = before[i], after = after[i] }).ToArray() };
            }, nativeModifiedElements: () => new[] { scheduleId });
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Success"); result["dryRun"] = false;
            return result;
        }
    }
}

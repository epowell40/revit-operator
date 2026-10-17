using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    /// <summary>Bounded visible panel cells and native circuit mapping. No writes,
    /// inferred wiring, design approval, or substitution of parameters for pixels.</summary>
    internal static class PanelScheduleDetail
    {
        internal static object Read(Document doc, PanelScheduleView view, SchedulesHandler.Params p)
        {
            if (view.IsPanelScheduleTemplate())
                return new { status = "InvalidRequest", action = "detail", message = "Use a panel schedule instance, not its shared template." };
            if (p.includeDefinitionSnapshot == true)
                return new { status = "InvalidRequest", action = "detail", message = "Definition snapshots apply to regular ViewSchedule definitions, not panel schedule instances." };
            if (p.includeSchedulableFields == true)
                return new { status = "InvalidRequest", action = "detail", message = "Panel schedules use native template cell bindings, not ViewSchedule schedulable fields. Omit includeSchedulableFields and request includeData." };
            if (!PanelScheduleReadWindow.TryCreate(p.rowOffset, p.columnOffset, p.maxRows, p.maxColumns, out var window, out var error))
                return new { status = "InvalidRequest", action = "detail", message = error };
            var circuits = new Dictionary<long, object>();
            var sections = new List<object>();
            if (p.includeData == true)
            {
                foreach (var kind in new[] { SectionType.Header, SectionType.Body, SectionType.Summary, SectionType.Footer })
                {
                    if (!view.IsValidSectionType(kind)) { sections.Add(new { section = kind.ToString(), supported = false }); continue; }
                    using var section = view.GetSectionData(kind);
                    var totalRows = PanelScheduleReadWindow.Extent(section.FirstRowNumber, section.LastRowNumber);
                    var totalColumns = PanelScheduleReadWindow.Extent(section.FirstColumnNumber, section.LastColumnNumber);
                    var rows = new List<object>();
                    var rowCount = Math.Max(0, Math.Min(window!.MaxRows, totalRows - window.RowOffset));
                    var columnCount = Math.Max(0, Math.Min(window.MaxColumns, totalColumns - window.ColumnOffset));
                    for (int r = 0; r < rowCount; r++)
                    {
                        var row = section.FirstRowNumber + window.RowOffset + r;
                        var cells = new List<object>();
                        for (int c = 0; c < columnCount; c++)
                        {
                            var column = section.FirstColumnNumber + window.ColumnOffset + c;
                            // Native failures propagate; unreadable cells are never empty success.
                            var text = view.GetCellText(kind, row, column);
                            var parameterId = ElementIdCompat.GetValue(section.GetCellParamId(row, column));
                            var circuitId = kind == SectionType.Body ? ElementIdCompat.GetValue(view.GetCircuitIdByCell(row, column)) : -1;
                            if (circuitId > 0 && !circuits.ContainsKey(circuitId))
                            {
                                var circuit = doc.GetElement(ElementIdCompat.Create(circuitId)) as ElectricalSystem;
                                if (circuit == null) throw new InvalidOperationException("Panel cell circuit did not resolve to an ElectricalSystem.");
                                circuits.Add(circuitId, new { elementId = circuitId, uniqueId = circuit.UniqueId,
                                    circuitNumber = circuit.CircuitNumber,
                                    panelElementId = circuit.BaseEquipment == null ? (long?)null : ElementIdCompat.GetValue(circuit.BaseEquipment.Id),
                                    loadName = Parameter(circuit, "Load Name"),
                                    scheduleCircuitNotes = Parameter(circuit, "Schedule Circuit Notes"),
                                    wireSize = Parameter(circuit, "Wire Size"),
                                    rating = Parameter(circuit, "Rating"),
                                    voltage = Parameter(circuit, "Voltage"),
                                    numberOfPoles = Parameter(circuit, "Number of Poles") });
                            }
                            cells.Add(new { column, text, parameterId,
                                circuitElementId = circuitId > 0 ? (long?)circuitId : null });
                        }
                        rows.Add(new { rowIndex = row, heightInternalFeet = section.GetRowHeight(row), cells });
                    }
                    sections.Add(new { section = kind.ToString(), supported = true, totalRows, totalColumns,
                        firstRowNumber = section.FirstRowNumber, lastRowNumber = section.LastRowNumber,
                        firstColumnNumber = section.FirstColumnNumber, lastColumnNumber = section.LastColumnNumber,
                        nativeReportedRows = section.NumberOfRows, nativeReportedColumns = section.NumberOfColumns,
                        rowOffset = window!.RowOffset, columnOffset = window.ColumnOffset,
                        returnedRows = rowCount, returnedColumns = columnCount,
                        hasMoreRows = window.RowOffset + rowCount < totalRows,
                        nextRowOffset = window.RowOffset + rowCount < totalRows ? (int?)(window.RowOffset + rowCount) : null,
                        hasMoreColumns = window.ColumnOffset + columnCount < totalColumns,
                        nextColumnOffset = window.ColumnOffset + columnCount < totalColumns ? (int?)(window.ColumnOffset + columnCount) : null,
                        rows });
                }
            }
            return new { schema = "operator.panel_schedule_detail.v1", status = "Ok", action = "detail", read_only = true,
                schedule = new { id = ElementIdCompat.GetValue(view.Id), uniqueId = view.UniqueId, name = view.Name,
                    kind = "panel_schedule", viewType = view.ViewType.ToString(),
                    panelElementId = ElementIdCompat.GetValue(view.GetPanel()), templateElementId = ElementIdCompat.GetValue(view.GetTemplate()) },
                table = new { sections }, circuits = new List<object>(circuits.Values),
                coverage = "Circuit summaries cover only returned native body cells. Follow each section's row/column continuation; this is stored visible text, not a rendered legibility or engineering check." };
        }

        private static object? Parameter(Element element, string name)
        {
            var matches = element.GetParameters(name);
            if (matches.Count == 0) return null;
            if (matches.Count != 1) throw new InvalidOperationException("Ambiguous circuit parameter: " + name);
            var p = matches[0];
            return new { name, parameterId = ElementIdCompat.GetValue(p.Id), isReadOnly = p.IsReadOnly,
                storageType = p.StorageType.ToString(), value = p.StorageType == StorageType.String ? p.AsString() : p.AsValueString() };
        }
    }
}

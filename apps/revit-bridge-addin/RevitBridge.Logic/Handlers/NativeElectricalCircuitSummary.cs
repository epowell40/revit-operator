using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>Fresh bounded factual relationships, never circuit labels or engineering approval.</summary>
    internal static class NativeElectricalCircuitSummary
    {
        internal static object Read(Document doc, Element element, int? slotNumber, IDictionary<long, object> circuits)
        {
            if (slotNumber.HasValue && slotNumber.Value <= 0) throw new ArgumentException("electricalPanelSlotNumber must be positive.");
            if (element is FamilyInstance instance)
            {
                var systems = (instance.MEPModel?.GetElectricalSystems() ?? new HashSet<ElectricalSystem>())
                    .Where(system => system.SystemType == ElectricalSystemType.PowerCircuit)
                    .OrderBy(system => ElementIdCompat.GetValue(system.Id)).ToList();
                foreach (var system in systems)
                {
                    var id = ElementIdCompat.GetValue(system.Id);
                    if (!circuits.ContainsKey(id)) circuits.Add(id, ReadSystem(doc, system, slotNumber));
                }
                return new { schema = "operator.electrical_membership_summary.v1", complete = true,
                    kind = "family_instance", powerSystemIds = systems.Select(system => ElementIdCompat.GetValue(system.Id)).ToList() };
            }
            if (element is ElectricalSystem circuit)
            {
                var id = ElementIdCompat.GetValue(circuit.Id);
                if (!circuits.ContainsKey(id)) circuits.Add(id, ReadSystem(doc, circuit, slotNumber));
                return new { schema = "operator.electrical_membership_summary.v1", complete = true,
                    kind = "electrical_system", powerSystemIds = new[] { id } };
            }
            return new { schema = "operator.electrical_membership_summary.v1", complete = false, kind = "unsupported_element" };
        }

        private static object ReadSystem(Document doc, ElectricalSystem system, int? slotNumber)
        {
            if (system.SystemType != ElectricalSystemType.PowerCircuit)
                throw new InvalidOperationException("electrical_membership_summary_requires_power_circuit");
            var members = system.Elements.Cast<Element>().OrderBy(member => ElementIdCompat.GetValue(member.Id)).ToList();
            if (members.Count > 1000) throw new InvalidOperationException("electrical_membership_summary_exceeds_1000_members");
            var panel = system.BaseEquipment;
            var systemId = ElementIdCompat.GetValue(system.Id);
            var slots = new List<object>();
            if (slotNumber.HasValue && panel != null)
            {
                foreach (var schedule in new FilteredElementCollector(doc).OfClass(typeof(PanelScheduleView)).Cast<PanelScheduleView>())
                {
                    if (schedule.IsPanelScheduleTemplate() || ElementIdCompat.GetValue(schedule.GetPanel()) != ElementIdCompat.GetValue(panel.Id)) continue;
                    IList<int> rows; IList<int> columns;
                    schedule.GetCellsBySlotNumber(slotNumber.Value, out rows, out columns);
                    if (rows == null || columns == null || rows.Count != columns.Count)
                        throw new InvalidOperationException("electrical_membership_summary_invalid_panel_slot_cells");
                    var cells = new List<object>();
                    for (var index = 0; index < rows.Count; index++)
                    {
                        var id = schedule.GetCircuitIdByCell(rows[index], columns[index]);
                        cells.Add(new { row = rows[index], column = columns[index], electricalSystemId = ElementIdCompat.GetValue(id) });
                    }
                    slots.Add(new { scheduleElementId = ElementIdCompat.GetValue(schedule.Id), scheduleUniqueId = schedule.UniqueId,
                        panelElementId = ElementIdCompat.GetValue(panel.Id), slotNumber = slotNumber.Value, cells });
                }
            }
            return new { systemElementId = systemId, systemUniqueId = system.UniqueId, systemType = system.SystemType.ToString(),
                memberElementIds = members.Select(member => ElementIdCompat.GetValue(member.Id)).ToList(),
                memberIdentities = members.Select(member => new { elementId = ElementIdCompat.GetValue(member.Id), uniqueId = member.UniqueId }).ToList(),
                panelElementId = panel == null ? (long?)null : ElementIdCompat.GetValue(panel.Id),
                panelUniqueId = panel?.UniqueId, circuitNumber = system.CircuitNumber,
                trueLoadInternal = system.TrueLoad, apparentLoadInternal = system.ApparentLoad,
                inspectedPanelSlotNumber = slotNumber, panelSlots = slots, complete = true };
        }
    }
}

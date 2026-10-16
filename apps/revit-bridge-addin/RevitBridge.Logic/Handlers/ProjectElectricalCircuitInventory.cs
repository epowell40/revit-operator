using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>Compact discovery of actual model inputs; no engineering verdicts.</summary>
    public static class ProjectElectricalCircuitInventory
    {
        public static object Read(Document doc, int offset, int? maximum, long? scheduleId = null)
        {
            if (!ScheduleInventoryWindow.TryCreate("panel", offset, maximum, out var page, out var error)
                || page!.Max > 500) throw new ArgumentException(error.Length > 0 ? error : "Circuit inventory max must be 1..500.");
            long? panelId = null;
            if (scheduleId.HasValue)
            {
                var schedule = doc.GetElement(ElementIdCompat.Create(scheduleId.Value)) as PanelScheduleView;
                if (schedule == null || schedule.IsPanelScheduleTemplate()) throw new ArgumentException("Use the native ID of a panel schedule instance.");
                panelId = ElementIdCompat.GetValue(schedule.GetPanel());
            }
            var systems = new FilteredElementCollector(doc).OfClass(typeof(ElectricalSystem)).Cast<ElectricalSystem>()
                .Where(s => s.SystemType == ElectricalSystemType.PowerCircuit)
                .Where(s => !panelId.HasValue || s.BaseEquipment != null && ElementIdCompat.GetValue(s.BaseEquipment.Id) == panelId.Value)
                .OrderBy(s => ElementIdCompat.GetValue(s.Id)).ToList();
            var rows = new List<object>(); var profiles = new Dictionary<long, object>();
            var incomplete = 0; var incompleteProfiles = 0;
            foreach (var circuit in systems.Skip(page.Offset).Take(page.Max))
            {
                var errors = new List<object>();
                object? ReadValue(string field, Func<object?> getter)
                {
                    try { return getter(); }
                    catch (Exception ex) { errors.Add(new { field, errorType = ex.GetType().FullName, message = ex.Message }); return null; }
                }
                string? Text(BuiltInParameter id)
                {
                    var parameter = circuit.get_Parameter(id);
                    if (parameter == null) throw new InvalidOperationException("Native circuit parameter missing: " + id);
                    return parameter.StorageType == StorageType.String ? parameter.AsString() : parameter.AsValueString();
                }
                object? Editable(BuiltInParameter id) => circuit.get_Parameter(id) == null ? (bool?)null : !circuit.get_Parameter(id).IsReadOnly;
                var owner = circuit.BaseEquipment;
                var circuitType = circuit.CircuitType.ToString();
                var loadName = ReadValue("loadName", () => Text(BuiltInParameter.RBS_ELEC_CIRCUIT_NAME));
                var notes = ReadValue("scheduleCircuitNotes", () => Text(BuiltInParameter.RBS_ELEC_CIRCUIT_NOTES_PARAM));
                var wire = ReadValue("wireSize", () => Text(BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_SIZE_PARAM));
                var rating = ReadValue("ratingAmps", () => Units(circuit.Rating, UnitTypeId.Amperes));
                var voltage = ReadValue("voltageVolts", () => Units(circuit.Voltage, UnitTypeId.Volts));
                var poles = ReadValue("poles", () => circuit.PolesNumber);
                var apparentLoad = ReadValue("apparentLoadVa", () => Units(circuit.ApparentLoad, UnitTypeId.VoltAmperes));
                var apparentCurrent = ReadValue("apparentCurrentAmps", () => Units(circuit.ApparentCurrent, UnitTypeId.Amperes));
                var phaseCurrent = new {
                    a = ReadValue("phaseAAmps", () => Units(circuit.ApparentCurrentPhaseA, UnitTypeId.Amperes)),
                    b = ReadValue("phaseBAmps", () => Units(circuit.ApparentCurrentPhaseB, UnitTypeId.Amperes)),
                    c = ReadValue("phaseCAmps", () => Units(circuit.ApparentCurrentPhaseC, UnitTypeId.Amperes)) };
                var counts = new {
                    hot = ReadValue("hotConductors", () => circuit.HotConductorsNumber),
                    neutral = ReadValue("neutralConductors", () => circuit.NeutralConductorsNumber),
                    ground = ReadValue("groundConductors", () => circuit.GroundConductorsNumber),
                    runs = ReadValue("runs", () => circuit.RunsNumber) };
                var members = ReadValue("memberElementIds", () => circuit.Elements.Cast<Element>()
                    .Select(e => ElementIdCompat.GetValue(e.Id)).Distinct().OrderBy(id => id).ToArray());
                var classifications = ReadValue("loadClassifications", () => circuit.LoadClassifications);
                object? wireTypeId = null;
#if !NET10_0_OR_GREATER
                var wireType = ReadValue("wireType", () => circuit.WireType) as WireType;
                if (wireType != null)
                {
                    var id = ElementIdCompat.GetValue(wireType.Id); wireTypeId = id;
                    if (!profiles.ContainsKey(id))
                    {
                        profiles.Add(id, WireProfile(doc, wireType, out var profileComplete));
                        if (!profileComplete) incompleteProfiles++;
                    }
                }
#else
                errors.Add(new { field = "wireType", errorType = "LegacyWireTypeUnavailable", message = "Revit2027 removed ElectricalSystem.WireType. Cable data requires separate inspection; no legacy type is invented." });
#endif
                if (errors.Count > 0) incomplete++;
                rows.Add(new {
                    id = ElementIdCompat.GetValue(circuit.Id), uniqueId = circuit.UniqueId, circuitType,
                    panelElementId = owner == null ? (long?)null : ElementIdCompat.GetValue(owner.Id),
                    panelUniqueId = owner?.UniqueId, panelName = circuit.PanelName, circuitNumber = circuit.CircuitNumber,
                    loadName, scheduleCircuitNotes = notes, wireSize = wire, ratingAmps = rating, voltageVolts = voltage,
                    poles, apparentLoadVa = apparentLoad, apparentCurrentAmps = apparentCurrent, phaseCurrentAmps = phaseCurrent,
                    conductors = counts, wireTypeId, memberElementIds = members, loadClassifications = classifications,
                    editable = new { loadName = Editable(BuiltInParameter.RBS_ELEC_CIRCUIT_NAME),
                        scheduleCircuitNotes = Editable(BuiltInParameter.RBS_ELEC_CIRCUIT_NOTES_PARAM),
                        rating = Editable(BuiltInParameter.RBS_ELEC_CIRCUIT_RATING_PARAM) },
                    dataComplete = errors.Count == 0, fieldErrors = errors });
            }
            return new {
                schema = "operator.electrical_circuit_inventory.v1", status = "Ok", read_only = true,
                scope = panelId.HasValue ? "panel_power_circuits" : "project_power_circuits", panelElementId = panelId,
                document = new { title = doc.Title, path = doc.PathName },
                offset = page.Offset, max = page.Max, matched = systems.Count, returned = rows.Count,
                complete = page.Complete(systems.Count), hasMore = page.HasMore(systems.Count), nextOffset = page.NextOffset(systems.Count),
                dataComplete = incomplete == 0 && incompleteProfiles == 0, incompleteItems = incomplete,
                incompleteWireTypes = incompleteProfiles, items = rows, wireTypes = profiles.Values.ToArray(),
                parameterIds = new { loadName = (long)BuiltInParameter.RBS_ELEC_CIRCUIT_NAME,
                    scheduleCircuitNotes = (long)BuiltInParameter.RBS_ELEC_CIRCUIT_NOTES_PARAM,
                    rating = (long)BuiltInParameter.RBS_ELEC_CIRCUIT_RATING_PARAM },
                limits = "Complete means enumerated source circuits, including native Spare/Space records, not electrical suitability or verified work. Field errors remain explicit. Both note fields may contain wiring; native schedule detail is required to establish actual cell bindings and visible text. Load classifications are not continuous-duty determinations. Wire types are model calculation profiles, not installed wire/termination/raceway evidence. Route voltage drop and equipment limits require separate inspection." };
        }
        private static double Units(double value, ForgeTypeId unit)
        {
            var converted = UnitUtils.ConvertFromInternalUnits(value, unit);
            if (double.IsNaN(converted) || double.IsInfinity(converted)) throw new InvalidOperationException("Native circuit value is not finite.");
            return converted;
        }
#if !NET10_0_OR_GREATER
        private static object WireProfile(Document doc, WireType type, out bool complete)
        {
            var errors = new List<object>();
            object? Read(string field, Func<object?> getter)
            { try { return getter(); } catch (Exception ex) { errors.Add(new { field, errorType = ex.GetType().FullName, message = ex.Message }); return null; } }
            var material = Read("material", () => Describe(doc, type.WireMaterial));
            var temperature = Read("temperature", () => Describe(doc, type.TemperatureRating));
            var insulation = Read("insulation", () => Describe(doc, type.Insulation));
            var neutralRequired = Read("neutralRequired", () => type.NeutralRequired);
            var neutralMultiplier = Read("neutralMultiplier", () => type.NeutralMultiplier);
            var neutralSize = Read("neutralSize", () => type.NeutralSize.ToString());
            complete = errors.Count == 0;
            return new { id = ElementIdCompat.GetValue(type.Id), uniqueId = type.UniqueId, name = ((Element)type).Name,
                material, temperature, insulation, neutralRequired, neutralMultiplier, neutralSize,
                dataComplete = errors.Count == 0, fieldErrors = errors };
        }
        // Revit 2026 returns IDs for these properties; earlier APIs return elements.
        // Resolve in the same document and let Read retain any unresolved-reference error.
        private static object? Describe(Document doc, ElementId? id) => id == null || id == ElementId.InvalidElementId
            ? null : Describe(doc, doc.GetElement(id) ?? throw new InvalidOperationException("Wire profile reference did not resolve: " + ElementIdCompat.GetValue(id)));
        private static object? Describe(Document doc, Element? element) => element == null ? null : new {
            id = ElementIdCompat.GetValue(element.Id), uniqueId = element.UniqueId, name = element.Name };
#endif
    }
}

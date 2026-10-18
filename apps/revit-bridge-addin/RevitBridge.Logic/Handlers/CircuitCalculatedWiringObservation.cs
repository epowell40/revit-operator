using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>Native dependent values, not an electrical design or installation verdict.</summary>
    public static class CircuitCalculatedWiringObservation
    {
        public sealed class Snapshot
        {
            public long elementId { get; set; }
            public string? uniqueId { get; set; }
            public string? wireSize { get; set; }
            public bool? wireSizeParameterReadOnly { get; set; }
            public long? wireTypeId { get; set; }
            public int? hot { get; set; }
            public int? neutral { get; set; }
            public int? ground { get; set; }
            public int? runs { get; set; }
            public bool dataComplete => fieldErrors.Count == 0;
            public List<object> fieldErrors { get; } = new List<object>();
        }

        public static bool IsSizingParameter(Parameter parameter)
        {
            var id = ElementIdCompat.GetValue(parameter.Id);
            return id == (long)BuiltInParameter.RBS_ELEC_CIRCUIT_RATING_PARAM
                || id == (long)BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_TYPE_PARAM
                || id == (long)BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_NUM_RUNS_PARAM
                || id == (long)BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_NUM_HOTS_PARAM
                || id == (long)BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_NUM_NEUTRALS_PARAM
                || id == (long)BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_NUM_GROUNDS_PARAM;
        }

        public static Snapshot Read(Document doc, long id)
        {
            var result = new Snapshot { elementId = id };
            T? ReadValue<T>(string field, Func<T> getter) where T : struct
            {
                try { return getter(); }
                catch (Exception ex) { result.fieldErrors.Add(new { field, errorType = ex.GetType().FullName, message = ex.Message }); return null; }
            }
            ElectricalSystem? circuit;
            try { circuit = doc.GetElement(ElementIdCompat.Create(id)) as ElectricalSystem; }
            catch (Exception ex) { result.fieldErrors.Add(new { field = "target", errorType = ex.GetType().FullName, message = ex.Message }); return result; }
            if (circuit == null)
            {
                result.fieldErrors.Add(new { field = "target", errorType = "MissingElectricalSystem", message = "The native circuit could not be re-resolved." });
                return result;
            }
            try { result.uniqueId = circuit.UniqueId; }
            catch (Exception ex) { result.fieldErrors.Add(new { field = "uniqueId", errorType = ex.GetType().FullName, message = ex.Message }); }
            try
            {
                var parameter = circuit.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_SIZE_PARAM);
                if (parameter == null) throw new InvalidOperationException("Native wire-size parameter is unavailable in this circuit/version.");
                result.wireSize = parameter.StorageType == StorageType.String ? parameter.AsString() : parameter.AsValueString();
                result.wireSizeParameterReadOnly = parameter.IsReadOnly;
                if (string.IsNullOrWhiteSpace(result.wireSize)) throw new InvalidOperationException("Native wire-size value is empty.");
            }
            catch (Exception ex) { result.fieldErrors.Add(new { field = "wireSize", errorType = ex.GetType().FullName, message = ex.Message }); }
            result.wireTypeId = ReadValue("wireTypeId", () => {
                var parameter = circuit.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_WIRE_TYPE_PARAM);
                if (parameter == null || parameter.StorageType != StorageType.ElementId) throw new InvalidOperationException("Native wire-type parameter is unavailable in this circuit/version.");
                var value = ElementIdCompat.GetValue(parameter.AsElementId());
                if (value <= 0) throw new InvalidOperationException("Native wire type is not a positive element identity.");
                return value;
            });
            result.hot = ReadValue("hot", () => circuit.HotConductorsNumber);
            result.neutral = ReadValue("neutral", () => circuit.NeutralConductorsNumber);
            result.ground = ReadValue("ground", () => circuit.GroundConductorsNumber);
            result.runs = ReadValue("runs", () => circuit.RunsNumber);
            return result;
        }

        public static object? Describe(Document doc, IReadOnlyDictionary<long, Snapshot> before,
            IReadOnlyDictionary<long, Snapshot> preview, string settlement)
        {
            if (before.Count == 0) return null;
            string? year = null;
            object? versionError = null;
            try { year = doc.Application.VersionNumber; }
            catch (Exception ex) { versionError = new { errorType = ex.GetType().FullName, message = ex.Message }; }
            var legacyCalculation = int.TryParse(year, out var number) && number <= 2025;
            return new {
                schema = "operator.dependent_circuit_wiring.v1", revitVersion = year, versionError,
                basis = legacyCalculation ? "native_automatic_calculation" : "native_reported_wire_values",
                settlement,
                items = before.OrderBy(pair => pair.Key).Select(pair => {
                    var after = Read(doc, pair.Key);
                    var comparable = pair.Value.dataComplete && after.dataComplete
                        && string.Equals(pair.Value.uniqueId, after.uniqueId, StringComparison.Ordinal);
                    return new { elementId = pair.Key, uniqueId = pair.Value.uniqueId, before = pair.Value,
                        preview = preview.TryGetValue(pair.Key, out var attempted) ? attempted : null,
                        afterSettlement = after,
                        nativeWireSizeChanged = comparable ? (bool?)!string.Equals(pair.Value.wireSize, after.wireSize, StringComparison.Ordinal) : null };
                }).ToArray(),
                limits = "Dependent native values, not physical installed conductors or an electrical design pass. Rating/wire-type changes can recalculate other wiring; inspect before/after and preserve approved larger design conductors and grounds. A readonly calculated value is not a writable design override. Explicit compact design notation in the actual bound circuit row can carry a justified design selection, but must remain distinguished from the native calculated profile. Do not change shared sizing tables to hide a local mismatch. Preview values are not committed effects; afterSettlement is the actual re-resolved state."
            };
        }
    }
}

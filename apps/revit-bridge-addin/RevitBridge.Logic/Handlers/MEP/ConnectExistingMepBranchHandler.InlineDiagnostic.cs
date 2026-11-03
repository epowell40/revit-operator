using System;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public sealed partial class ConnectExistingMepBranchHandler
    {
        // Bounded observations only. In particular, a null category, dependency
        // relationship or empty parameter projection never proves preservation.
        // Capture exceptions do not replace the existing strict write guards.
        private static object InlineDiagnosticRead(Func<object> read)
        {
            try { return read(); }
            catch (Exception e) { return new { complete = false, error = e.GetType().Name }; }
        }

        private static object ReadInlineDiagnosticSystem(MEPSystem? system) => InlineDiagnosticRead(() =>
        {
            if (system == null) return new { complete = false, reason = "system_unavailable" };
            var members = system.Elements.Cast<Element>().Select(e => ElementIdCompat.GetValue(e.Id)).Take(5001).ToArray();
            var network = system is MechanicalSystem mechanical
                ? mechanical.DuctNetwork.Cast<Element>().Select(e => ElementIdCompat.GetValue(e.Id)).Take(5001).ToArray()
                : Array.Empty<long>();
            return new { complete = members.Length <= 5000 && network.Length <= 5000,
                elementId = ElementIdCompat.GetValue(system.Id), uniqueId = system.UniqueId,
                typeId = ElementIdCompat.GetValue(system.GetTypeId()),
                members = members.Take(5000).OrderBy(x => x).ToArray(), network = network.Take(5000).OrderBy(x => x).ToArray(),
                writableParameters = InlineWritableParameters(system) };
        });

        private static object CaptureInlineDiagnostic(Document doc, long[] changedIds, long[] physicalIds,
            long[] scheduleIds, long symbolId, object beforeSystem, MEPSystem? afterSystem) => InlineDiagnosticRead(() =>
        {
            var ids = changedIds.Distinct().OrderBy(x => x).ToArray();
            var owners = ids.Take(64).Select(id => InlineDiagnosticRead(() =>
            {
                var e = doc.GetElement(ElementIdCompat.Create(id));
                if (e == null) return new { elementId = id, present = false };
                var dependencies = InlineDiagnosticRead(() =>
                {
                    var values = e.GetDependentElements(null).Select(ElementIdCompat.GetValue).Take(513).ToArray();
                    return new { complete = values.Length <= 512, elementIds = values.Take(512).OrderBy(x => x).ToArray() };
                });
                var parameters = InlineDiagnosticRead(() =>
                {
                    var values = e.Parameters.Cast<Parameter>().Take(129).ToArray();
                    return new { complete = values.Length <= 128, items = values.Take(128).Select(p => new {
                        id = ElementIdCompat.GetValue(p.Id), storage = p.StorageType.ToString(), readOnly = p.IsReadOnly,
                        value = p.StorageType == StorageType.Double ? p.AsDouble().ToString("R", CultureInfo.InvariantCulture)
                            : p.StorageType == StorageType.Integer ? p.AsInteger().ToString(CultureInfo.InvariantCulture)
                            : p.StorageType == StorageType.ElementId ? ElementIdCompat.GetValue(p.AsElementId()).ToString(CultureInfo.InvariantCulture)
                            : p.StorageType == StorageType.String ? p.AsString() : null
                    }).OrderBy(p => p.id).ToArray() };
                });
                return new { elementId = id, present = true, uniqueId = e.UniqueId, className = e.GetType().FullName,
                    categoryId = e.Category == null ? (long?)null : ElementIdCompat.GetValue(e.Category.Id),
                    category = e.Category?.Name, typeId = ElementIdCompat.GetValue(e.GetTypeId()), dependencies, parameters };
            })).ToArray();
            var physical = physicalIds.Distinct().ToArray();
            var connections = physical.Take(5).Select(id => InlineDiagnosticRead(() =>
            {
                var edges = CapturePhysicalConnections(doc.GetElement(ElementIdCompat.Create(id)));
                return new { elementId = id, complete = edges.Count <= 128,
                    edges = edges.Take(128).Select(DescribePhysicalConnection).ToArray() };
            })).ToArray();
            var result = new { diagnosticOnly = true, scope = "provisional_child_commit_before_outer_settlement",
                changedIds = ids.Take(64).ToArray(), changedIdsTruncated = ids.Length > 64, owners,
                physical = InlineAccessoryObservation.Read(doc, physical, scheduleIds, new[] { symbolId }), connections,
                beforeSystem, afterSystem = ReadInlineDiagnosticSystem(afterSystem),
                limitations = "Not preservation, authoritative readback or final settlement. Unknown effects remain guarded." };
            // Preserve no live Element/Parameter objects past rollback. Bound the
            // entire envelope too, including exceptional long parameter strings.
            var serialized = JsonSerializer.Serialize(result);
            if (serialized.Length > 1048576) return new { diagnosticOnly = true, complete = false, reason = "diagnostic_size_bound" };
            return JsonSerializer.Deserialize<JsonElement>(serialized);
        });
    }
}

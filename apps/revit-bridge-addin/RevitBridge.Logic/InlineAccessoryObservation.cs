using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.MEP;

namespace RevitBridge.Logic
{
    /// <summary>Bounded native observations collected in the same callback as the connector graph.
    /// These facts do not certify an insertion or expand mutation authority.</summary>
    public static class InlineAccessoryObservation
    {
        public static object Read(Document doc, IReadOnlyList<long> ids, IReadOnlyList<long> schedules,
            IReadOnlyList<long>? additionalTypes = null)
        {
            var stage = "request";
            try
            {
                if (ids.Count < 1 || ids.Count > 5 || ids.Any(id => id <= 0) || ids.Distinct().Count() != ids.Count
                    || schedules.Count > 32 || schedules.Any(id => id <= 0) || schedules.Distinct().Count() != schedules.Count
                    || ids.Intersect(schedules).Any() || (additionalTypes?.Count ?? 0) > 1)
                    throw new ArgumentException("Inline observation requires 1-5 physical owners and at most32 exact schedules.");
                stage = "owners";
                var owners = ids.OrderBy(id => id).Select(id => doc.GetElement(ElementIdCompat.Create(id))
                    ?? throw new InvalidOperationException("A requested native owner is missing.")).ToArray();
                stage = "types";
                var types = owners.Select(e => ElementIdCompat.GetValue(e.GetTypeId())).Concat(additionalTypes ?? Array.Empty<long>())
                    .Distinct().OrderBy(id => id).Select(id => doc.GetElement(ElementIdCompat.Create(id)) as ElementType
                        ?? throw new InvalidOperationException("A requested native type is missing.")).ToArray();
                stage = "schedules";
                var scheduleRead = AnnotationSchedulePreservation.Read(doc, schedules);
                using (var json = JsonDocument.Parse(JsonSerializer.Serialize(scheduleRead)))
                    if (!json.RootElement.GetProperty("complete").GetBoolean()) throw new InvalidOperationException("Schedule observation incomplete.");
                stage = "owner_state";
                var ownerRows = owners.Select(e => new { elementId = ElementIdCompat.GetValue(e.Id), uniqueId = e.UniqueId,
                    typeId = ElementIdCompat.GetValue(e.GetTypeId()), state = State(e) }).ToArray();
                stage = "type_parameters";
                var typeRows = types.Select(t => new { elementId = ElementIdCompat.GetValue(t.Id), uniqueId = t.UniqueId,
                    parameters = WritableParameters(t) }).ToArray();
                var bookkeeping = InlineAccessoryBookkeepingObservation.Read(doc, owners, value => stage = value);
                return new { schema = "operator.inline_accessory_state.v1", complete = true,
                    requestedElementIds = ids.OrderBy(id => id).ToArray(), owners = ownerRows,
                    types = typeRows, schedulePreservation = scheduleRead, bookkeeping };
            }
            catch (Exception error)
            {
                return InlineAccessoryObservationDiagnostic.Failure(error, stage);
            }
        }

        public static string WritableParameters(Element owner)
            => JsonSerializer.Serialize(owner.Parameters.Cast<Parameter>().Where(p => !p.IsReadOnly)
                .OrderBy(p => ElementIdCompat.GetValue(p.Id)).Select(p => new { id = ElementIdCompat.GetValue(p.Id),
                    storage = p.StorageType.ToString(), value = p.StorageType switch {
                        StorageType.Double => p.AsDouble().ToString("R", CultureInfo.InvariantCulture),
                        StorageType.Integer => p.AsInteger().ToString(CultureInfo.InvariantCulture),
                        StorageType.ElementId => ElementIdCompat.GetValue(p.AsElementId()).ToString(CultureInfo.InvariantCulture),
                        StorageType.String => p.AsString(), _ => null } }).ToArray());

        public static object State(Element owner)
        {
            if (owner == null) throw new InvalidOperationException("Missing owner.");
            var curve = owner as MEPCurve;
            double[] Point(XYZ p) => new[] { p.X, p.Y, p.Z };
            var line = (owner.Location as LocationCurve)?.Curve as Line;
            var points = owner is FlexDuct flex ? flex.Points.Select(Point).ToArray()
                : line != null ? new[] { Point(line.GetEndPoint(0)), Point(line.GetEndPoint(1)) }
                : owner.Location is LocationPoint location ? new[] { Point(location.Point), new[] { location.Rotation, 0d, 0d } }
                : throw new InvalidOperationException("Owner geometry is unsupported.");
            var manager = curve?.ConnectorManager ?? (owner as FamilyInstance)?.MEPModel?.ConnectorManager
                ?? throw new InvalidOperationException("Native connector manager unavailable.");
            var connectors = manager.Connectors.Cast<Connector>().Where(c => c.ConnectorType != ConnectorType.Logical).ToArray();
            if (connectors.Length < 1 || connectors.Length > 512) throw new InvalidOperationException("Connector inventory exceeds the bound.");
            return new { owner.UniqueId, metadata = new { type = ElementIdCompat.GetValue(owner.GetTypeId()),
                phase = ElementIdCompat.GetValue(owner.CreatedPhaseId), demolished = ElementIdCompat.GetValue(owner.DemolishedPhaseId),
                workset = ElementIdCompat.GetValue(owner.WorksetId),
                systemType = curve?.MEPSystem == null ? (long?)null : ElementIdCompat.GetValue(curve.MEPSystem.GetTypeId()),
                level = curve?.ReferenceLevel != null ? (long?)ElementIdCompat.GetValue(curve.ReferenceLevel.Id)
                    : owner is FamilyInstance instance ? ElementIdCompat.GetValue(instance.LevelId) : (long?)null,
                diameter = owner.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM)?.AsDouble() },
                parameters = WritableParameters(owner), geometryKind = owner is FlexDuct ? "FlexDuct" : line != null ? "Line" : "Point",
                points, ports = connectors.Select(c => new {
                    id = MepSystemUtil.TryGetNativeConnectorId(c, out var id) ? id : throw new InvalidOperationException("Native connector ID unavailable."),
                    origin = Point(c.Origin), direction = Point(c.CoordinateSystem.BasisZ), shape = c.Shape.ToString() }).OrderBy(c => c.id).ToArray() };
        }
    }
}

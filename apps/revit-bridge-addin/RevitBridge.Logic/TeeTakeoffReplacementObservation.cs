using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    /// <summary>One callback's bounded active-document observations. Does not
    /// assert successful replacement or authorize deletion. The caller must
    /// independently compare actual absence, physical topology and preservation.</summary>
    public static class TeeTakeoffReplacementObservation
    {
        public const string Schema = "operator.tee_takeoff_replacement_state.v1";
        public static JsonElement Read(Document doc, IReadOnlyList<long> physicalIds,
            IReadOnlyList<long> removedIds, IReadOnlyList<long> schedules, IReadOnlyList<long> additionalTypes)
        {
            void Ids(IReadOnlyList<long> ids, int min, int max)
            { if (ids.Count < min || ids.Count > max || ids.Any(x => x <= 0) || ids.Distinct().Count() != ids.Count)
                throw new ArgumentException("Invalid bounded replacement observation scope."); }
            Ids(physicalIds, 1, 8); Ids(removedIds, 0, 12); Ids(schedules, 0, 32); Ids(additionalTypes, 0, 16);
            var scopes = physicalIds.Concat(removedIds).Concat(schedules).Concat(additionalTypes).ToArray();
            if (doc.IsFamilyDocument || scopes.Distinct().Count() != scopes.Length)
                throw new ArgumentException("Replacement observation scopes must be disjoint in an active project.");
            var physical = physicalIds.OrderBy(x => x).Select(id => doc.GetElement(ElementIdCompat.Create(id))
                ?? throw new InvalidOperationException("A requested surviving physical owner is missing.")).ToArray();
            if (physical.Any(e => !(e is Duct) && !(e is FlexDuct) && !(e is FamilyInstance f && f.MEPModel is MechanicalFitting)))
                throw new InvalidOperationException("Only duct, flex duct and mechanical fitting owners are supported.");
            var types = physical.Select(e => ElementIdCompat.GetValue(e.GetTypeId())).Concat(additionalTypes).Distinct().OrderBy(x => x)
                .Select(id => doc.GetElement(ElementIdCompat.Create(id)) as ElementType
                    ?? throw new InvalidOperationException("A required type is missing.")).ToArray();
            if (types.Length > 16) throw new InvalidOperationException("Replacement type scope exceeds bound.");
            var scheduleState = JsonSerializer.SerializeToElement(AnnotationSchedulePreservation.Read(doc, schedules));
            if (!scheduleState.GetProperty("complete").GetBoolean()) throw new InvalidOperationException("Schedule observation is incomplete.");
            var state = JsonSerializer.SerializeToElement(new {
                schema = Schema, complete = true, scope = "active_document_public_semantic_projection",
                requestedElementIds = physicalIds.OrderBy(x => x).ToArray(),
                requestedRemovedIds = removedIds.OrderBy(x => x).ToArray(),
                requestedAdditionalTypeIds = additionalTypes.OrderBy(x => x).ToArray(),
                owners = physical.Select(e => new {elementId = ElementIdCompat.GetValue(e.Id), uniqueId = e.UniqueId,
                    typeId = ElementIdCompat.GetValue(e.GetTypeId()), state = InlineAccessoryObservation.State(e)}).ToArray(),
                types = types.Select(e => new {elementId = ElementIdCompat.GetValue(e.Id), uniqueId = e.UniqueId,
                    familyName = (e as FamilySymbol)?.FamilyName, typeName = e.Name,
                    parameters = InlineAccessoryObservation.WritableParameters(e)}).ToArray(),
                removed = removedIds.OrderBy(x => x).Select(id => {
                    var element = doc.GetElement(ElementIdCompat.Create(id));
                    return new {elementId=id, exists=element!=null, uniqueId=element?.UniqueId};
                }).ToArray(),
                centerlines = InlineAccessoryBookkeepingObservation.ReadCenterlines(doc, physical),
                system = InlineAccessoryBookkeepingObservation.ReadSystem(doc, physical),
                schedulePreservation = scheduleState,
                collateral = TeeCollateralObservation.Read(doc, physical)
            });
            if (state.GetRawText().Length > 2000000) throw new InvalidOperationException("Replacement observation exceeds bound.");
            return state;
        }
    }
}

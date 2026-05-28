using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class ReplaceDoorHandler : IRequestHandler
    {
        public class Params
        {
            public long elementId { get; set; }
            public long newTypeId { get; set; }
            public bool copyCommonParams { get; set; } = true;
            public bool deleteOld { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");
            if (p.elementId == 0) throw new ArgumentException("Missing required parameter: elementId");
            if (p.newTypeId == 0) throw new ArgumentException("Missing required parameter: newTypeId");

            var doc = app.ActiveUIDocument.Document;
            var warnings = new List<string>();

            var oldElem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.elementId));
            if (!(oldElem is FamilyInstance oldDoor))
                throw new ArgumentException($"Element {p.elementId} is not a FamilyInstance.");

            var catId = oldDoor.Category?.Id?.IntegerValue ?? 0;
            if (catId != (int)BuiltInCategory.OST_Doors)
                throw new ArgumentException($"Element {p.elementId} is not in category OST_Doors.");

            var newSym = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.newTypeId)) as FamilySymbol;
            if (newSym == null)
                throw new ArgumentException($"newTypeId {p.newTypeId} not found or is not a FamilySymbol.");

            var newCatId = newSym.Category?.Id?.IntegerValue ?? 0;
            if (newCatId != (int)BuiltInCategory.OST_Doors)
                warnings.Add("New type is not categorized as OST_Doors; placement may fail.");

            if (!(oldDoor.Location is LocationPoint lp))
                throw new ArgumentException("Door location is not a point; cannot replace.");

            var host = oldDoor.Host;
            if (host == null)
                throw new ArgumentException("Door has no host; cannot replace.");

            var level = doc.GetElement(oldDoor.LevelId) as Level;
            if (level == null)
                throw new ArgumentException("Door level not found; cannot replace.");

            long newElementId;
            object newDoorAssoc = null;
            object phaseInfo = null;
            using (var t = new Transaction(doc, "Replace Door"))
            {
                t.Start();

                if (!newSym.IsActive)
                {
                    newSym.Activate();
                    doc.Regenerate();
                }

                FamilyInstance newDoor;
                try
                {
                    newDoor = doc.Create.NewFamilyInstance(lp.Point, newSym, host, level, StructuralType.NonStructural);
                }
                catch (Exception ex)
                {
                    throw new InvalidOperationException($"Failed to place new door instance: {ex.Message}");
                }

                // Preserve phase info to avoid From/To Room association breaking due to phase mismatch.
                // NewFamilyInstance tends to use the active view's phase; we want to match the original door.
                CopyElementIdParam(oldDoor, newDoor, BuiltInParameter.PHASE_CREATED, warnings, "Phase Created");
                CopyElementIdParam(oldDoor, newDoor, BuiltInParameter.PHASE_DEMOLISHED, warnings, "Phase Demolished");

                // Best-effort association check (phase-aware) to aid verification/debugging.
                try
                {
                    var phaseId = oldDoor.get_Parameter(BuiltInParameter.PHASE_CREATED)?.AsElementId() ?? ElementId.InvalidElementId;
                    var phase = phaseId != ElementId.InvalidElementId ? doc.GetElement(phaseId) as Phase : null;

                    Room toRoom = null;
                    Room fromRoom = null;
                    if (phase != null)
                    {
                        toRoom = newDoor.get_ToRoom(phase);
                        fromRoom = newDoor.get_FromRoom(phase);
                    }

                    newDoorAssoc = new
                    {
                        phaseId = RevitBridge.Common.ElementIdCompat.GetValue(phase?.Id),
                        phaseName = phase?.Name,
                        toRoom = toRoom == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(toRoom.Id), number = toRoom.Number, name = toRoom.Name },
                        fromRoom = fromRoom == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(fromRoom.Id), number = fromRoom.Number, name = fromRoom.Name }
                    };

                    var oldPhaseId = oldDoor.get_Parameter(BuiltInParameter.PHASE_CREATED)?.AsElementId() ?? ElementId.InvalidElementId;
                    var newPhaseId = newDoor.get_Parameter(BuiltInParameter.PHASE_CREATED)?.AsElementId() ?? ElementId.InvalidElementId;
                    phaseInfo = new
                    {
                        oldPhaseCreatedId = oldPhaseId == ElementId.InvalidElementId ? -1 : RevitBridge.Common.ElementIdCompat.GetValue(oldPhaseId),
                        oldPhaseCreatedName = oldPhaseId == ElementId.InvalidElementId ? null : (doc.GetElement(oldPhaseId) as Phase)?.Name,
                        newPhaseCreatedId = newPhaseId == ElementId.InvalidElementId ? -1 : RevitBridge.Common.ElementIdCompat.GetValue(newPhaseId),
                        newPhaseCreatedName = newPhaseId == ElementId.InvalidElementId ? null : (doc.GetElement(newPhaseId) as Phase)?.Name
                    };
                }
                catch
                {
                    // Ignore.
                }

                try
                {
                    if (newDoor.HandFlipped != oldDoor.HandFlipped) newDoor.flipHand();
                }
                catch { warnings.Add("Failed to match hand flip state."); }

                try
                {
                    if (newDoor.FacingFlipped != oldDoor.FacingFlipped) newDoor.flipFacing();
                }
                catch { warnings.Add("Failed to match facing flip state."); }

                if (p.copyCommonParams)
                {
                    CopyStringParam(oldDoor, newDoor, BuiltInParameter.ALL_MODEL_MARK);
                    CopyStringParam(oldDoor, newDoor, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
                    CopyStringParam(oldDoor, newDoor, BuiltInParameter.DOOR_NUMBER);
                }

                newElementId = RevitBridge.Common.ElementIdCompat.GetValue(newDoor.Id);

                if (p.deleteOld)
                {
                    try { doc.Delete(oldDoor.Id); } catch { warnings.Add("Failed to delete old door."); }
                }

                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                ok = true,
                oldElementId = p.elementId,
                newElementId,
                newTypeId = p.newTypeId,
                phase = phaseInfo,
                association = newDoorAssoc,
                warnings
            });
        }

        private static void CopyStringParam(Element from, Element to, BuiltInParameter bip)
        {
            try
            {
                var pFrom = from.get_Parameter(bip);
                var pTo = to.get_Parameter(bip);
                if (pFrom == null || pTo == null) return;
                if (pTo.IsReadOnly) return;
                if (pFrom.StorageType != StorageType.String || pTo.StorageType != StorageType.String) return;
                pTo.Set(pFrom.AsString() ?? "");
            }
            catch
            {
                // Ignore.
            }
        }

        private static void CopyElementIdParam(Element from, Element to, BuiltInParameter bip, List<string> warnings, string label)
        {
            try
            {
                var pFrom = from.get_Parameter(bip);
                var pTo = to.get_Parameter(bip);
                if (pFrom == null || pTo == null) return;
                if (pTo.IsReadOnly) return;
                if (pFrom.StorageType != StorageType.ElementId || pTo.StorageType != StorageType.ElementId) return;
                pTo.Set(pFrom.AsElementId());
            }
            catch (Exception ex)
            {
                warnings.Add($"Failed to copy {label}: {ex.Message}");
            }
        }
    }
}

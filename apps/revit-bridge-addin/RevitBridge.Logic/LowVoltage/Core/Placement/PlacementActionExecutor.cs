using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;
using RevitBridge.Common.LowVoltage.Core.Placement;

namespace RevitBridge.Logic.LowVoltage.Core.Placement
{
    public static class PlacementActionExecutor
    {
        public static List<long> Execute(Document doc, IEnumerable<PlacementAction> actions, string? runId = null)
        {
            var created = new List<long>();
            var defaultLevel = (doc.ActiveView as ViewPlan)?.GenLevel
                ?? new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault();

            foreach (var action in actions)
            {
                if (!action.Approved || action.FamilyTypeId == null || !string.Equals(action.ActionType, "place_family_instance", StringComparison.OrdinalIgnoreCase)) continue;
                var symbol = doc.GetElement(new ElementId((int)action.FamilyTypeId.Value)) as FamilySymbol;
                if (symbol == null) continue;
                if (!symbol.IsActive) symbol.Activate();

                var p = new XYZ(action.Candidate.Location.X, action.Candidate.Location.Y, action.Candidate.Location.Z);
                var hostId = action.HostElementId ?? action.Candidate.HostElementId;
                var host = hostId.HasValue ? doc.GetElement(new ElementId((int)hostId.Value)) : null;
                FamilyInstance? instance = null;

                if (host != null)
                {
                    try
                    {
                        instance = doc.Create.NewFamilyInstance(p, symbol, host, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                    }
                    catch
                    {
                        instance = null;
                    }
                }

                if (instance == null && defaultLevel != null)
                {
                    try
                    {
                        instance = doc.Create.NewFamilyInstance(p, symbol, defaultLevel, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                    }
                    catch
                    {
                        instance = null;
                    }
                }

                if (instance == null)
                {
                    try
                    {
                        instance = doc.Create.NewFamilyInstance(p, symbol, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                    }
                    catch
                    {
                        instance = null;
                    }
                }

                if (instance == null) continue;
                TagElement(instance, action, runId);
                created.Add(ElementIdCompat.GetValue(instance.Id));
            }

            return created;
        }

        private static void TagElement(Element element, PlacementAction action, string? runId)
        {
            var prefix = action.Meta.TryGetValue("tag_prefix", out var configuredPrefix) ? configuredPrefix : string.Equals(action.Discipline, "fire_alarm", StringComparison.OrdinalIgnoreCase) ? "RO_FA" : "RO_LV";
            var parts = new List<string> { prefix };
            if (!string.IsNullOrWhiteSpace(runId)) parts.Add("runId=" + runId);
            if (action.Meta.TryGetValue("run_module", out var module) && !string.IsNullOrWhiteSpace(module)) parts.Add("module=" + module);
            if (action.Meta.TryGetValue("layer", out var layer) && !string.IsNullOrWhiteSpace(layer)) parts.Add("layer=" + layer);
            if (action.Meta.TryGetValue("device_kind", out var kind) && !string.IsNullOrWhiteSpace(kind)) parts.Add("kind=" + kind);
            if (action.RoomId.HasValue) parts.Add("roomId=" + action.RoomId.Value);
            if (!string.IsNullOrWhiteSpace(action.GroupId)) parts.Add("groupId=" + action.GroupId);
            var tag = string.Join(";", parts);

            TrySetStringParam(element, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS, tag);
            TrySetStringParam(element, "Comments", tag);
            TrySetStringParam(element, "BIMTools_RunId", runId ?? string.Empty);
            TrySetStringParam(element, "BIMTools_Module", module ?? action.Discipline);
            TrySetStringParam(element, "BIMTools_FA_DeviceKind", kind ?? action.DeviceCategory);
        }

        private static void TrySetStringParam(Element element, BuiltInParameter parameter, string value)
        {
            try
            {
                var target = element.get_Parameter(parameter);
                if (target == null || target.IsReadOnly || target.StorageType != StorageType.String) return;
                target.Set(value ?? string.Empty);
            }
            catch
            {
            }
        }

        private static void TrySetStringParam(Element element, string parameterName, string value)
        {
            try
            {
                var target = element.LookupParameter(parameterName);
                if (target == null || target.IsReadOnly || target.StorageType != StorageType.String) return;
                target.Set(value ?? string.Empty);
            }
            catch
            {
            }
        }
    }
}

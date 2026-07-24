using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>
    /// Audits or assigns a native electrical distribution system on existing equipment.
    /// This intentionally uses ElectricalEquipment.IsValidDistributionSystem instead of
    /// writing the derived "Distribution System" parameter, which can raise an unhandled
    /// Revit modal when the requested system is incompatible.
    /// </summary>
    public sealed class AssignElectricalDistributionSystemHandler : IRequestHandler
    {
        public sealed class Params
        {
            public List<long> elementIds { get; set; } = new List<long>();
            public long? distributionSystemId { get; set; }
            public string distributionSystemName { get; set; } = string.Empty;
            public bool dryRun { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var ids = (request.elementIds ?? new List<long>())
                .Where(id => id > 0)
                .Distinct()
                .OrderBy(id => id)
                .ToList();
            if (ids.Count == 0) throw new ArgumentException("elementIds is required.");
            if (ids.Count > 100) throw new ArgumentException("elementIds exceeds 100.");

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var available = new FilteredElementCollector(doc)
                .OfClass(typeof(DistributionSysType))
                .Cast<DistributionSysType>()
                .OrderBy(system => system.Name, StringComparer.OrdinalIgnoreCase)
                .ThenBy(system => ElementIdCompat.GetValue(system.Id))
                .ToList();
            var requestedName = (request.distributionSystemName ?? string.Empty).Trim();
            var target = ResolveTarget(available, request.distributionSystemId, requestedName);
            var targetRequested = request.distributionSystemId.HasValue || requestedName.Length > 0;

            var equipment = new List<(long id, FamilyInstance instance, ElectricalEquipment model)>();
            var results = new List<object>();
            var blocked = false;
            foreach (var id in ids)
            {
                var instance = doc.GetElement(ElementIdCompat.Create(id)) as FamilyInstance;
                var model = instance?.MEPModel as ElectricalEquipment;
                if (instance == null || model == null)
                {
                    blocked = true;
                    results.Add(new
                    {
                        elementId = id,
                        ok = false,
                        error = instance == null
                            ? "Element is not a family instance."
                            : "Family instance does not expose an ElectricalEquipment MEP model."
                    });
                    continue;
                }

                equipment.Add((id, instance, model));
                var validSystems = available
                    .Where(system => IsValid(model, system))
                    .Select(ToSystemWire)
                    .ToList();
                var current = SafeCurrent(model);
                var targetValid = target == null || IsValid(model, target);
                if (targetRequested && (target == null || !targetValid)) blocked = true;
                results.Add(new
                {
                    elementId = id,
                    ok = !targetRequested || (target != null && targetValid),
                    currentDistributionSystem = current == null ? null : ToSystemWire(current),
                    requestedDistributionSystem = target == null ? null : ToSystemWire(target),
                    requestedDistributionSystemValid = target == null ? (bool?)null : targetValid,
                    validDistributionSystems = validSystems
                });
            }

            if (!targetRequested)
            {
                return Task.FromResult<object>(new
                {
                    schema = "operator.assign_electrical_distribution_system.v1",
                    status = "Audit",
                    applied = false,
                    dryRun = true,
                    results
                });
            }
            if (target == null)
            {
                return Task.FromResult<object>(new
                {
                    schema = "operator.assign_electrical_distribution_system.v1",
                    status = "Blocked",
                    applied = false,
                    dryRun = request.dryRun,
                    error = "Requested distribution system was not found uniquely.",
                    results
                });
            }
            if (blocked)
            {
                return Task.FromResult<object>(new
                {
                    schema = "operator.assign_electrical_distribution_system.v1",
                    status = "Blocked",
                    applied = false,
                    dryRun = request.dryRun,
                    error = "Requested distribution system is not valid for every target element.",
                    results
                });
            }

            var beforeIds = equipment.ToDictionary(
                item => item.id,
                item => SafeCurrent(item.model) == null ? (long?)null : ElementIdCompat.GetValue(SafeCurrent(item.model)!.Id));
            var after = new List<object>();
            using (var transaction = new Transaction(doc, request.dryRun
                ? "Dry Run Assign Electrical Distribution System"
                : "Assign Electrical Distribution System"))
            {
                if (transaction.Start() != TransactionStatus.Started)
                    throw new InvalidOperationException("distribution_system_transaction_not_started");
                foreach (var item in equipment)
                {
                    item.model.DistributionSystem = target;
                }
                doc.Regenerate();
                foreach (var item in equipment)
                {
                    var current = SafeCurrent(item.model);
                    var verified = current != null && current.Id == target.Id;
                    after.Add(new
                    {
                        elementId = item.id,
                        ok = verified,
                        beforeDistributionSystemId = beforeIds[item.id],
                        afterDistributionSystem = current == null ? null : ToSystemWire(current)
                    });
                    if (!verified)
                    {
                        transaction.RollBack();
                        throw new InvalidOperationException($"distribution_system_assignment_verification_failed:{item.id}");
                    }
                }

                var status = request.dryRun ? transaction.RollBack() : transaction.Commit();
                var expected = request.dryRun ? TransactionStatus.RolledBack : TransactionStatus.Committed;
                if (status != expected)
                    throw new InvalidOperationException($"distribution_system_transaction_unexpected_status:{status}");
            }

            var rollbackVerified = true;
            if (request.dryRun)
            {
                rollbackVerified = equipment.All(item =>
                {
                    var restored = SafeCurrent(item.model);
                    var restoredId = restored == null ? (long?)null : ElementIdCompat.GetValue(restored.Id);
                    return restoredId == beforeIds[item.id];
                });
                if (!rollbackVerified)
                    throw new InvalidOperationException("distribution_system_dry_run_rollback_verification_failed");
            }

            return Task.FromResult<object>(new
            {
                schema = "operator.assign_electrical_distribution_system.v1",
                status = request.dryRun ? "Planned" : "Applied",
                applied = !request.dryRun,
                dryRun = request.dryRun,
                rollbackVerified,
                distributionSystem = ToSystemWire(target),
                results = after
            });
        }

        private static DistributionSysType? ResolveTarget(
            IReadOnlyCollection<DistributionSysType> available,
            long? id,
            string name)
        {
            var byId = id.HasValue
                ? available.Where(system => ElementIdCompat.GetValue(system.Id) == id.Value).ToList()
                : new List<DistributionSysType>();
            var byName = name.Length > 0
                ? available.Where(system => string.Equals(system.Name, name, StringComparison.OrdinalIgnoreCase)).ToList()
                : new List<DistributionSysType>();
            if (id.HasValue && byId.Count != 1) return null;
            if (name.Length > 0 && byName.Count != 1) return null;
            if (id.HasValue && name.Length > 0 && byId[0].Id != byName[0].Id) return null;
            if (id.HasValue) return byId[0];
            if (name.Length > 0) return byName[0];
            return null;
        }

        private static bool IsValid(ElectricalEquipment equipment, DistributionSysType system)
        {
            try { return equipment.IsValidDistributionSystem(system); }
            catch { return false; }
        }

        private static DistributionSysType? SafeCurrent(ElectricalEquipment equipment)
        {
            try { return equipment.DistributionSystem; }
            catch { return null; }
        }

        private static object ToSystemWire(DistributionSysType system) => new
        {
            id = ElementIdCompat.GetValue(system.Id),
            name = system.Name,
            electricalPhase = system.ElectricalPhase.ToString(),
            numWires = system.NumWires
        };
    }
}

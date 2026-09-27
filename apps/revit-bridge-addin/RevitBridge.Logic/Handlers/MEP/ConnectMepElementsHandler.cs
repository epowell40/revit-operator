using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    /// <summary>
    /// Fail-closed connector join for an already placed MEP family/equipment
    /// instance and explicit nearby duct/pipe/family targets. This composes with
    /// the existing hosted and unhosted placement tools, which keeps hosting and
    /// physical MEP attachment independently auditable.
    /// </summary>
    public sealed class ConnectMepElementsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long sourceElementId { get; set; }
            public List<long>? targetElementIds { get; set; }
            public double toleranceFt { get; set; } = 0.125;
            public double sizeToleranceFt { get; set; } = 0.01;
            public int? requiredConnectionCount { get; set; }
            public bool dryRun { get; set; } = true;
            public bool verify { get; set; } = true;
        }

        private sealed class Pair
        {
            public Connector Source { get; set; } = null!;
            public Connector Target { get; set; } = null!;
            public Element TargetOwner { get; set; } = null!;
            public double DistanceFt { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope =>
                HandleCore(app, jsonData, enterNativeScope).GetAwaiter().GetResult()));

        private Task<object> HandleCore(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            if (p.sourceElementId <= 0) throw new InvalidOperationException("sourceElementId must be a positive element id.");
            var targetIds = (p.targetElementIds ?? new List<long>()).Where(id => id > 0 && id != p.sourceElementId).Distinct().ToList();
            if (targetIds.Count == 0) throw new InvalidOperationException("targetElementIds must contain at least one explicit target.");
            if (targetIds.Count > 16) throw new InvalidOperationException("At most 16 target elements may be connected in one request.");
            if (p.toleranceFt <= 0 || p.toleranceFt > 2.0) throw new InvalidOperationException("toleranceFt must be greater than 0 and no more than 2 feet.");
            if (p.sizeToleranceFt < 0 || p.sizeToleranceFt > 0.25) throw new InvalidOperationException("sizeToleranceFt must be between 0 and 0.25 feet.");

            var required = p.requiredConnectionCount ?? targetIds.Count;
            if (required < 1 || required > targetIds.Count) throw new InvalidOperationException("requiredConnectionCount must be from 1 through the number of target elements.");
            var source = doc.GetElement(ElementIdCompat.Create(p.sourceElementId)) ?? throw new InvalidOperationException($"Source element {p.sourceElementId} was not found.");
            var targets = targetIds.Select(id => doc.GetElement(ElementIdCompat.Create(id)) ?? throw new InvalidOperationException($"Target element {id} was not found.")).ToList();
            var sourceConnectors = OpenPhysicalConnectors(source);
            var targetConnectorCounts = targets.ToDictionary(e => ElementIdCompat.GetValue(e.Id), e => OpenPhysicalConnectors(e).Count);
            var pairs = PlanPairs(sourceConnectors, targets, p.toleranceFt, p.sizeToleranceFt)
                .Take(required)
                .ToList();
            var feasible = pairs.Count >= required;
            // Materialize before mutation: Connector wrappers may be invalid
            // after regeneration, commit, or rollback.
            var connectionPlan = pairs.Select(DescribePair).ToList();

            if (p.dryRun || !feasible)
            {
                return Task.FromResult<object>(new
                {
                    status = feasible ? "Ready" : "Blocked",
                    success = feasible,
                    dryRun = p.dryRun,
                    previewExecuted = false,
                    applied = false,
                    verified = false,
                    transaction = OperatorNativeTransactionReceipt.NotStarted(),
                    sourceElementId = p.sourceElementId,
                    targetElementIds = targetIds,
                    requiredConnectionCount = required,
                    plannedConnectionCount = pairs.Count,
                    toleranceFt = p.toleranceFt,
                    sizeToleranceFt = p.sizeToleranceFt,
                    sourceOpenConnectorCount = sourceConnectors.Count,
                    targetOpenConnectorCounts = targetConnectorCounts,
                    sourceOpenConnectors = sourceConnectors.Select(DescribeConnector).ToList(),
                    targetOpenConnectors = targets.SelectMany(target => OpenPhysicalConnectors(target).Select(DescribeConnector)).ToList(),
                    connectionPlan,
                    blockReason = feasible ? null : "Not enough compatible open connector pairs were found within tolerance."
                });
            }

            var fittingsBefore = FittingIds(doc);
            var connectedOwners = new HashSet<long> { p.sourceElementId };
            enterNativeScope();
            var response = NativeSingleTransaction.Execute(app, doc, "Connect MEP elements", nativeCreated =>
                {
                    foreach (var pair in pairs)
                    {
                        pair.Source.ConnectTo(pair.Target);
                        connectedOwners.Add(ElementIdCompat.GetValue(pair.TargetOwner.Id));
                    }
                    doc.Regenerate();
                    // ConnectTo can insert fittings. Native collector identity
                    // differences supplement the commit event inventory and
                    // provide the bounded intermediate owners for readback.
                    foreach (var id in FittingIds(doc).Except(fittingsBefore)) nativeCreated.Add(id);
                    var verifiedTargets = ConnectedTargetOwnerIds(doc, p.sourceElementId, targetIds, nativeCreated);
                    if (p.verify && verifiedTargets.Count < required)
                        throw new InvalidOperationException($"Native connector verification found {verifiedTargets.Count} required target connections; expected at least {required}.");
                    return new Dictionary<string, object?>();
                }, nativeModifiedElements: () => connectedOwners);

            var receipt = (OperatorNativeTransactionReceipt)response["transaction"]!;
            if (receipt.CommittedValue == true)
            {
                OperatorNativeTransactionExecution.ReadCommitted(response, () =>
                {
                    // Reacquire persisted owners/connectors after commit; the
                    // transient ConnectTo result is not physical readback.
                    var persisted = ConnectedTargetOwnerIds(doc, p.sourceElementId, targetIds, receipt.AddedElementIds);
                    if (persisted.Count < required)
                        throw new InvalidOperationException($"Post-commit physical readback found {persisted.Count} required target connections; expected at least {required}.");
                    return new Dictionary<string, object?>
                    {
                        ["verifiedTargetElementIds"] = persisted,
                        ["verifiedConnectionCount"] = persisted.Count
                    };
                });
            }
            var succeeded = response["success"] is bool passed && passed;
            response["status"] = receipt.CommittedValue == true ? (succeeded ? "Applied" : "Committed With Errors")
                : receipt.Status == "rolled_back" || receipt.Status == "not_started" ? "Blocked" : "Unknown";
            response["dryRun"] = false;
            response["sourceElementId"] = p.sourceElementId;
            response["targetElementIds"] = targetIds;
            response["requiredConnectionCount"] = required;
            response["plannedConnectionCount"] = pairs.Count;
            response["connectionPlan"] = connectionPlan;
            response["physicalVerificationScope"] = "target_owner_reachability";
            response["applied"] = receipt.CommittedValue;
            response["rolledBack"] = receipt.Status == "rolled_back" ? (bool?)true : receipt.CommittedValue == true ? false : (bool?)null;
            if (!response.ContainsKey("verified")) response["verified"] = false;
            if (!response.ContainsKey("verifiedTargetElementIds")) response["verifiedTargetElementIds"] = Array.Empty<long>();
            if (!response.ContainsKey("verifiedConnectionCount")) response["verifiedConnectionCount"] = 0;
            return Task.FromResult<object>(response);
        }

        private static List<Pair> PlanPairs(List<Connector> sourceConnectors, List<Element> targets, double toleranceFt, double sizeToleranceFt)
        {
            var candidates = new List<Pair>();
            foreach (var source in sourceConnectors)
            {
                foreach (var target in targets)
                {
                    foreach (var targetConnector in OpenPhysicalConnectors(target))
                    {
                        if (!Compatible(source, targetConnector, sizeToleranceFt)) continue;
                        var distance = source.Origin.DistanceTo(targetConnector.Origin);
                        if (distance > toleranceFt) continue;
                        candidates.Add(new Pair { Source = source, Target = targetConnector, TargetOwner = target, DistanceFt = distance });
                    }
                }
            }

            var selected = new List<Pair>();
            var usedSources = new HashSet<Connector>();
            var usedTargets = new HashSet<Connector>();
            var usedOwners = new HashSet<long>();
            foreach (var candidate in candidates.OrderBy(pair => pair.DistanceFt))
            {
                var ownerId = ElementIdCompat.GetValue(candidate.TargetOwner.Id);
                if (usedSources.Contains(candidate.Source) || usedTargets.Contains(candidate.Target) || usedOwners.Contains(ownerId)) continue;
                selected.Add(candidate);
                usedSources.Add(candidate.Source);
                usedTargets.Add(candidate.Target);
                usedOwners.Add(ownerId);
            }
            return selected;
        }

        private static List<Connector> OpenPhysicalConnectors(Element element)
        {
            return MepRoutingUtil.GetConnectors(element)
                .Where(connector => connector.ConnectorType != ConnectorType.Logical && !connector.IsConnected)
                .ToList();
        }

        private static bool Compatible(Connector a, Connector b, double sizeToleranceFt)
        {
            if (a.Domain != b.Domain || a.Shape != b.Shape) return false;
            try
            {
                if (a.Shape == ConnectorProfileType.Round)
                    return Math.Abs(a.Radius - b.Radius) <= sizeToleranceFt * 0.5;
                if (a.Shape == ConnectorProfileType.Rectangular || a.Shape == ConnectorProfileType.Oval)
                {
                    var aSize = new[] { a.Width, a.Height }.OrderBy(value => value).ToArray();
                    var bSize = new[] { b.Width, b.Height }.OrderBy(value => value).ToArray();
                    return Math.Abs(aSize[0] - bSize[0]) <= sizeToleranceFt && Math.Abs(aSize[1] - bSize[1]) <= sizeToleranceFt;
                }
            }
            catch
            {
                return false;
            }
            return true;
        }

        private static HashSet<long> FittingIds(Document doc)
            => new HashSet<long>(new FilteredElementCollector(doc)
                .WherePasses(new ElementMulticategoryFilter(new[] { BuiltInCategory.OST_DuctFitting, BuiltInCategory.OST_PipeFitting }))
                .WhereElementIsNotElementType().ToElementIds().Select(ElementIdCompat.GetValue));

        private static List<long> ConnectedTargetOwnerIds(Document doc, long sourceId, List<long> targetIds, IEnumerable<long> createdIds)
        {
            var targetSet = new HashSet<long>(targetIds);
            var intermediates = new HashSet<long>(createdIds.Intersect(FittingIds(doc)));
            var found = new HashSet<long>();
            var visited = new HashSet<long>();
            var pending = new Queue<long>();
            pending.Enqueue(sourceId);
            while (pending.Count > 0)
            {
                var ownerId = pending.Dequeue();
                if (!visited.Add(ownerId)) continue;
                var owner = doc.GetElement(ElementIdCompat.Create(ownerId));
                if (owner == null || !owner.IsValidObject)
                    throw new InvalidOperationException($"Connection readback owner {ownerId} is unavailable.");
                foreach (var connector in MepRoutingUtil.GetConnectors(owner))
                {
                    if (connector.ConnectorType == ConnectorType.Logical) continue;
                    foreach (Connector reference in connector.AllRefs)
                    {
                        if (reference == null || reference.ConnectorType == ConnectorType.Logical || reference.Owner == null
                            || reference.Owner is MEPSystem || reference.Owner.Id == owner.Id) continue;
                        if (!connector.IsConnectedTo(reference) || !reference.IsConnectedTo(connector)) continue;
                        var id = ElementIdCompat.GetValue(reference.Owner.Id);
                        if (targetSet.Contains(id)) found.Add(id);
                        else if (intermediates.Contains(id)) pending.Enqueue(id);
                    }
                }
            }
            return found.OrderBy(id => id).ToList();
        }

        private static object DescribePair(Pair pair)
        {
            return new
            {
                targetElementId = ElementIdCompat.GetValue(pair.TargetOwner.Id),
                distanceFt = pair.DistanceFt,
                domain = pair.Source.Domain.ToString(),
                shape = pair.Source.Shape.ToString(),
                sourceOrigin = Point(pair.Source.Origin),
                targetOrigin = Point(pair.Target.Origin)
            };
        }

        private static object DescribeConnector(Connector connector)
        {
            double? diameterFt = null;
            double? widthFt = null;
            double? heightFt = null;
            try
            {
                if (connector.Shape == ConnectorProfileType.Round)
                    diameterFt = connector.Radius * 2.0;
                else if (connector.Shape == ConnectorProfileType.Rectangular || connector.Shape == ConnectorProfileType.Oval)
                {
                    widthFt = connector.Width;
                    heightFt = connector.Height;
                }
            }
            catch { }

            return new
            {
                ownerElementId = connector.Owner == null ? 0 : ElementIdCompat.GetValue(connector.Owner.Id),
                domain = connector.Domain.ToString(),
                shape = connector.Shape.ToString(),
                origin = Point(connector.Origin),
                diameterFt,
                widthFt,
                heightFt
            };
        }

        private static object Point(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };
    }
}

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

            if (p.dryRun || !feasible)
            {
                return Task.FromResult<object>(new
                {
                    status = feasible ? "Ready" : "Blocked",
                    dryRun = p.dryRun,
                    sourceElementId = p.sourceElementId,
                    targetElementIds = targetIds,
                    requiredConnectionCount = required,
                    plannedConnectionCount = pairs.Count,
                    sourceOpenConnectorCount = sourceConnectors.Count,
                    targetOpenConnectorCounts = targetConnectorCounts,
                    connectionPlan = pairs.Select(DescribePair).ToList(),
                    blockReason = feasible ? null : "Not enough compatible open connector pairs were found within tolerance."
                });
            }

            var verifiedTargetIds = new List<long>();
            var rolledBack = false;
            Transaction? tx = null;
            try
            {
                using (tx = new Transaction(doc, "Connect MEP elements"))
                {
                    tx.Start();
                    foreach (var pair in pairs)
                    {
                        pair.Source.ConnectTo(pair.Target);
                    }
                    doc.Regenerate();
                    verifiedTargetIds = ConnectedTargetOwnerIds(source, targetIds);
                    if (p.verify && verifiedTargetIds.Count < required)
                    {
                        throw new InvalidOperationException($"Native connector verification found {verifiedTargetIds.Count} required target connections; expected at least {required}.");
                    }
                    tx.Commit();
                }
            }
            catch (Exception ex)
            {
                try
                {
                    if (tx != null && tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                }
                catch { }
                rolledBack = true;
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    dryRun = false,
                    sourceElementId = p.sourceElementId,
                    targetElementIds = targetIds,
                    requiredConnectionCount = required,
                    plannedConnectionCount = pairs.Count,
                    connectionPlan = pairs.Select(DescribePair).ToList(),
                    verifiedTargetElementIds = new List<long>(),
                    rolledBack,
                    error = ex.Message
                });
            }

            return Task.FromResult<object>(new
            {
                status = "Applied",
                dryRun = false,
                sourceElementId = p.sourceElementId,
                targetElementIds = targetIds,
                requiredConnectionCount = required,
                plannedConnectionCount = pairs.Count,
                connectionPlan = pairs.Select(DescribePair).ToList(),
                verifiedTargetElementIds = verifiedTargetIds,
                verifiedConnectionCount = verifiedTargetIds.Count,
                rolledBack
            });
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

        private static List<long> ConnectedTargetOwnerIds(Element source, List<long> targetIds)
        {
            var targetSet = new HashSet<long>(targetIds);
            var found = new HashSet<long>();
            foreach (var connector in MepRoutingUtil.GetConnectors(source))
            {
                ConnectorSet? references = null;
                try { references = connector.AllRefs; } catch { }
                if (references == null) continue;
                foreach (Connector reference in references)
                {
                    if (reference == null || reference.ConnectorType == ConnectorType.Logical || reference.Owner == null) continue;
                    var id = ElementIdCompat.GetValue(reference.Owner.Id);
                    if (targetSet.Contains(id)) found.Add(id);
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

        private static object Point(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };
    }
}

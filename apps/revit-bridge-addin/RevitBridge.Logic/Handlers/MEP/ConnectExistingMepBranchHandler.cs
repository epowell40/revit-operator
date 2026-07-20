using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    /// <summary>
    /// Connects one existing open MEP-curve connector to the interior of an
    /// existing main curve with Revit's native takeoff fitting. Unlike
    /// ConnectMepBranchHandler, this operation creates no replacement branch
    /// route and therefore preserves an already accepted branch element.
    /// </summary>
    public sealed class ConnectExistingMepBranchHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? expectedModelPath { get; set; }
            public string kind { get; set; } = "duct";
            public long mainElementId { get; set; }
            public long branchElementId { get; set; }
            public long? branchConnectorId { get; set; }
            public double[]? expectedBranchOriginXyz { get; set; }
            public double originToleranceFt { get; set; } = 0.001;
            public long? expectedTakeoffTypeId { get; set; }
            public string? expectedTakeoffFamilyName { get; set; }
            public string? expectedTakeoffTypeName { get; set; }
            public bool dryRun { get; set; } = true;
            public bool verify { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var uidoc = app.ActiveUIDocument;
            var doc = uidoc?.Document ?? throw new InvalidOperationException("No active Revit document.");
            GuardExpectedModelPath(doc, p.expectedModelPath);

            if (p.mainElementId <= 0 || p.branchElementId <= 0)
                throw new ArgumentException("mainElementId and branchElementId are required.");
            if (p.mainElementId == p.branchElementId)
                throw new ArgumentException("mainElementId and branchElementId must be different.");
            if (p.originToleranceFt <= 0 || double.IsNaN(p.originToleranceFt) || double.IsInfinity(p.originToleranceFt))
                throw new ArgumentException("originToleranceFt must be a positive finite number.");

            var kind = MepRoutingUtil.NormalizeKind(p.kind);
            var main = doc.GetElement(ElementIdCompat.Create(p.mainElementId)) as MEPCurve;
            var branch = doc.GetElement(ElementIdCompat.Create(p.branchElementId));
            if (main == null)
                throw new ArgumentException($"mainElementId {p.mainElementId} is not an MEP curve.");
            if (branch == null)
                throw new ArgumentException($"branchElementId {p.branchElementId} was not found.");
            GuardCurveKind(main, kind, "mainElementId");
            GuardCurveKind(branch, kind, "branchElementId");

            var branchConnector = ResolveOpenBranchConnector(branch, p);
            var branchOrigin = branchConnector.Origin;
            var mainCurve = (main.Location as LocationCurve)?.Curve;
            if (mainCurve == null || !mainCurve.IsBound)
                throw new InvalidOperationException("The main MEP curve must expose a bounded LocationCurve.");
            var projection = mainCurve.Project(branchOrigin)
                ?? throw new InvalidOperationException("Could not project the branch connector onto the main curve.");
            var projectedPoint = projection.XYZPoint;
            var mainStart = mainCurve.GetEndPoint(0);
            var mainEnd = mainCurve.GetEndPoint(1);
            var distanceToStart = projectedPoint.DistanceTo(mainStart);
            var distanceToEnd = projectedPoint.DistanceTo(mainEnd);
            if (distanceToStart <= 0.01 || distanceToEnd <= 0.01)
                throw new InvalidOperationException("The projected branch point must lie in the interior of the main curve; use a direct connector repair at an open main endpoint.");

            if (p.expectedTakeoffTypeId.HasValue &&
                doc.GetElement(ElementIdCompat.Create(p.expectedTakeoffTypeId.Value)) is not ElementType)
            {
                throw new ArgumentException($"expectedTakeoffTypeId {p.expectedTakeoffTypeId.Value} was not found.");
            }

            var beforeBranch = DescribeConnector(branchConnector);
            var createdFittingId = (long?)null;
            var createdTypeId = (long?)null;
            var createdFamilyName = (string?)null;
            var createdTypeName = (string?)null;
            var connectedDuringTransaction = false;
            var rolledBack = false;
            var rollbackVerified = false;
            var nativeFailures = new List<string>();

            using (var group = new TransactionGroup(doc, "Connect Existing MEP Branch"))
            {
                group.Start();
                try
                {
                    using (var tx = new Transaction(doc, "Create Existing-Branch Takeoff"))
                    {
                        tx.Start();
                        var fitting = doc.Create.NewTakeoffFitting(branchConnector, main)
                            ?? throw new InvalidOperationException("Revit did not create a takeoff fitting.");
                        createdFittingId = ElementIdCompat.GetValue(fitting.Id);
                        if (p.expectedTakeoffTypeId.HasValue &&
                            ElementIdCompat.GetValue(fitting.GetTypeId()) != p.expectedTakeoffTypeId.Value)
                        {
                            fitting.ChangeTypeId(ElementIdCompat.Create(p.expectedTakeoffTypeId.Value));
                        }
                        doc.Regenerate();

                        createdTypeId = ElementIdCompat.GetValue(fitting.GetTypeId());
                        ReadFamilyType(fitting, out createdFamilyName, out createdTypeName);
                        GuardExpectedTakeoffIdentity(p, createdTypeId.Value, createdFamilyName, createdTypeName);

                        var refreshedBranchConnector = ResolveConnectorByIdentityOrOrigin(
                            branch,
                            p.branchConnectorId,
                            branchOrigin,
                            Math.Max(p.originToleranceFt, 0.01));
                        connectedDuringTransaction = PhysicalConnectedOwnerIds(refreshedBranchConnector)
                            .Contains(createdFittingId.Value);
                        if (p.verify && !connectedDuringTransaction)
                            throw new InvalidOperationException("The created takeoff did not physically connect to the requested existing branch connector.");

                        tx.Commit();
                    }

                    if (p.dryRun)
                    {
                        group.RollBack();
                        rolledBack = true;
                        var restoredBranchConnector = ResolveConnectorByIdentityOrOrigin(
                            branch,
                            p.branchConnectorId,
                            branchOrigin,
                            Math.Max(p.originToleranceFt, 0.01));
                        rollbackVerified =
                            doc.GetElement(ElementIdCompat.Create(createdFittingId!.Value)) == null &&
                            !IsPhysicallyConnected(restoredBranchConnector);
                        if (!rollbackVerified)
                            nativeFailures.Add("Dry-run rollback did not restore the original open branch connector exactly.");
                    }
                    else
                    {
                        group.Assimilate();
                        rollbackVerified = true;
                    }
                }
                catch (Exception ex)
                {
                    nativeFailures.Add(ex.Message);
                    try
                    {
                        group.RollBack();
                        rolledBack = true;
                        rollbackVerified = createdFittingId == null ||
                            doc.GetElement(ElementIdCompat.Create(createdFittingId.Value)) == null;
                    }
                    catch (Exception rollbackError)
                    {
                        nativeFailures.Add($"Rollback failed: {rollbackError.Message}");
                    }
                }
            }

            var ok = nativeFailures.Count == 0 && rollbackVerified;
            return Task.FromResult<object>(new
            {
                status = ok
                    ? (p.dryRun ? "DryRunReady" : "Connected")
                    : "Blocked",
                dryRun = p.dryRun,
                mainElementId = p.mainElementId,
                branchElementId = p.branchElementId,
                branchConnector = beforeBranch,
                projectedPoint = ToPoint(projectedPoint),
                branchToMainDistanceFt = branchOrigin.DistanceTo(projectedPoint),
                distanceToMainStartFt = distanceToStart,
                distanceToMainEndFt = distanceToEnd,
                expectedTakeoffTypeId = p.expectedTakeoffTypeId,
                createdFittingId = ok && !p.dryRun ? createdFittingId : null,
                previewFittingId = p.dryRun ? createdFittingId : null,
                createdTypeId,
                createdFamilyName,
                createdTypeName,
                connectedDuringTransaction,
                transactionGroupRolledBack = rolledBack,
                rollbackVerified,
                nativeFailures,
                nextAction = ok && p.dryRun
                    ? "Apply this exact existing-branch takeoff only if the guarded connector, projected main point, fitting type, and rollback proof are accepted."
                    : null
            });
        }

        private static Connector ResolveOpenBranchConnector(Element branch, Params p)
        {
            var connectors = MepRoutingUtil.GetConnectors(branch);
            if (connectors.Count == 0)
                throw new InvalidOperationException("The branch element exposes no MEP connectors.");

            Connector? resolved = null;
            if (p.branchConnectorId.HasValue)
            {
                resolved = connectors.FirstOrDefault(connector =>
                    MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId) &&
                    nativeId == p.branchConnectorId.Value);
                if (resolved == null)
                    throw new InvalidOperationException($"Native branch connector {p.branchConnectorId.Value} was not found on element {p.branchElementId}.");
            }
            else if (HasPoint(p.expectedBranchOriginXyz))
            {
                var expected = ToXyz(p.expectedBranchOriginXyz!);
                resolved = connectors.OrderBy(connector => connector.Origin.DistanceTo(expected)).First();
            }
            else
            {
                var open = connectors.Where(connector => !IsPhysicallyConnected(connector)).ToList();
                if (open.Count != 1)
                    throw new InvalidOperationException("branchConnectorId or expectedBranchOriginXyz is required unless the branch exposes exactly one physically open connector.");
                resolved = open[0];
            }

            if (HasPoint(p.expectedBranchOriginXyz))
            {
                var expected = ToXyz(p.expectedBranchOriginXyz!);
                var delta = resolved.Origin.DistanceTo(expected);
                if (delta > p.originToleranceFt)
                    throw new InvalidOperationException($"Branch connector origin guard failed by {delta:F6} ft (tolerance {p.originToleranceFt:F6} ft).");
            }
            if (IsPhysicallyConnected(resolved))
                throw new InvalidOperationException("The requested branch connector is already physically connected.");
            return resolved;
        }

        private static Connector ResolveConnectorByIdentityOrOrigin(
            Element owner,
            long? connectorId,
            XYZ origin,
            double toleranceFt)
        {
            var connectors = MepRoutingUtil.GetConnectors(owner);
            if (connectorId.HasValue)
            {
                var byId = connectors.FirstOrDefault(connector =>
                    MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId) &&
                    nativeId == connectorId.Value);
                if (byId != null) return byId;
            }
            var nearest = connectors.OrderBy(connector => connector.Origin.DistanceTo(origin)).FirstOrDefault()
                ?? throw new InvalidOperationException("The branch connector could not be re-resolved.");
            if (nearest.Origin.DistanceTo(origin) > toleranceFt)
                throw new InvalidOperationException("The branch connector moved beyond the allowed identity/origin guard.");
            return nearest;
        }

        private static void GuardCurveKind(Element element, string kind, string parameterName)
        {
            var categoryId = element.Category == null
                ? long.MinValue
                : ElementIdCompat.GetValue(element.Category.Id);
            var expected = kind == "pipe"
                ? (long)BuiltInCategory.OST_PipeCurves
                : (long)BuiltInCategory.OST_DuctCurves;
            if (categoryId != expected)
                throw new ArgumentException($"{parameterName} category '{element.Category?.Name}' is not compatible with kind '{kind}'.");
        }

        private static void GuardExpectedTakeoffIdentity(
            Params p,
            long actualTypeId,
            string? actualFamilyName,
            string? actualTypeName)
        {
            if (p.expectedTakeoffTypeId.HasValue && actualTypeId != p.expectedTakeoffTypeId.Value)
                throw new InvalidOperationException($"Created takeoff type {actualTypeId} does not match expected type {p.expectedTakeoffTypeId.Value}.");
            if (!string.IsNullOrWhiteSpace(p.expectedTakeoffFamilyName) &&
                !string.Equals(actualFamilyName, p.expectedTakeoffFamilyName.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"Created takeoff family '{actualFamilyName}' does not match expected family '{p.expectedTakeoffFamilyName}'.");
            }
            if (!string.IsNullOrWhiteSpace(p.expectedTakeoffTypeName) &&
                !string.Equals(actualTypeName, p.expectedTakeoffTypeName.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"Created takeoff type name '{actualTypeName}' does not match expected type name '{p.expectedTakeoffTypeName}'.");
            }
        }

        private static void ReadFamilyType(Element element, out string? familyName, out string? typeName)
        {
            familyName = null;
            typeName = null;
            if (element is FamilyInstance instance)
            {
                familyName = instance.Symbol?.Family?.Name;
                typeName = instance.Symbol?.Name;
                return;
            }
            var type = element.Document.GetElement(element.GetTypeId()) as ElementType;
            typeName = type?.Name;
            familyName = type?.FamilyName;
        }

        private static object DescribeConnector(Connector connector)
        {
            var connectorId = MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId)
                ? nativeId
                : (long?)null;
            return new
            {
                connectorId,
                connectorIdBasis = connectorId.HasValue ? "revit_native_connector_id" : "origin_guard",
                origin = ToPoint(connector.Origin),
                domain = connector.Domain.ToString(),
                shape = connector.Shape.ToString(),
                size = connector.Shape == ConnectorProfileType.Round
                    ? (object)new { kind = "round", diameterFt = connector.Radius * 2.0 }
                    : new { kind = "rect", widthFt = connector.Width, heightFt = connector.Height },
                physicalConnectedOwnerIds = PhysicalConnectedOwnerIds(connector)
            };
        }

        private static List<long> PhysicalConnectedOwnerIds(Connector connector)
        {
            var result = new HashSet<long>();
            try
            {
                foreach (Connector reference in connector.AllRefs)
                {
                    var owner = reference?.Owner;
                    if (owner == null || owner is MEPSystem || owner.Id == connector.Owner?.Id) continue;
                    result.Add(ElementIdCompat.GetValue(owner.Id));
                }
            }
            catch { }
            return result.OrderBy(id => id).ToList();
        }

        private static bool IsPhysicallyConnected(Connector connector) =>
            PhysicalConnectedOwnerIds(connector).Count > 0;

        private static bool HasPoint(double[]? point) =>
            point != null &&
            point.Length >= 3 &&
            point.Take(3).All(value => !double.IsNaN(value) && !double.IsInfinity(value));

        private static XYZ ToXyz(double[] point) => new XYZ(point[0], point[1], point[2]);
        private static double[] ToPoint(XYZ point) => new[] { point.X, point.Y, point.Z };

        private static void GuardExpectedModelPath(Document doc, string? expectedModelPath)
        {
            if (string.IsNullOrWhiteSpace(expectedModelPath)) return;
            var expected = NormalizePath(expectedModelPath);
            var actual = NormalizePath(doc.PathName);
            if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"active_model_path_mismatch:expected={expected}:actual={actual}");
        }

        private static string NormalizePath(string path)
        {
            try { return Path.GetFullPath(path.Trim()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); }
            catch { return path.Trim(); }
        }
    }
}

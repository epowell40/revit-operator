using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    /// <summary>
    /// Connects one existing open rigid/flex MEP-curve connector to the
    /// interior of an existing rigid main curve with Revit's native takeoff
    /// fitting. Unlike
    /// ConnectMepBranchHandler, this operation creates no replacement branch
    /// route and therefore preserves an already accepted branch element.
    /// </summary>
    public sealed class ConnectExistingMepBranchHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? expectedModelPath { get; set; }
            public string connectionMode { get; set; } = "takeoff_fitting";
            public string kind { get; set; } = "duct";
            public long mainElementId { get; set; }
            public long branchElementId { get; set; }
            public long? branchConnectorId { get; set; }
            public double[]? expectedBranchOriginXyz { get; set; }
            public double originToleranceFt { get; set; } = 0.001;
            public long? expectedTakeoffTypeId { get; set; }
            public string? expectedTakeoffFamilyName { get; set; }
            public string? expectedTakeoffTypeName { get; set; }
            public long? worksetId { get; set; }
            public string? worksetName { get; set; }
            public bool dryRun { get; set; } = true;
            public bool verify { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope =>
                HandleCore(app, jsonData, enterNativeScope).GetAwaiter().GetResult()));

        private Task<object> HandleCore(UIApplication app, string jsonData, Action enterNativeScope)
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
            var connectionMode = NormalizeConnectionMode(p.connectionMode);
            var main = doc.GetElement(ElementIdCompat.Create(p.mainElementId)) as MEPCurve;
            var branch = doc.GetElement(ElementIdCompat.Create(p.branchElementId));
            if (main == null)
                throw new ArgumentException($"mainElementId {p.mainElementId} is not an MEP curve.");
            if (branch == null)
                throw new ArgumentException($"branchElementId {p.branchElementId} was not found.");
            GuardCurveKind(main, kind, "mainElementId", allowFlex: false);
            if (connectionMode == "air_terminal_on_duct")
            {
                if (kind != "duct")
                    throw new ArgumentException("connectionMode air_terminal_on_duct requires kind duct.");
                GuardAirTerminal(branch, "branchElementId");
                return Task.FromResult<object>(HandleAirTerminalOnDuct(app, doc, main, branch, p, enterNativeScope));
            }
            GuardCurveKind(branch, kind, "branchElementId", allowFlex: true);
            var targetWorkset = ResolveTargetWorkset(doc, branch, p.worksetId, p.worksetName, out var worksetSource);

            var branchConnector = ResolveOpenBranchConnector(branch, p);
            var branchOrigin = branchConnector.Origin;
            // Takeoff insertion can trim the selected endpoint. Preserve the actual
            // native ID even when the caller selected the sole open connector by omission.
            var selectedBranchConnectorId = MepSystemUtil.TryGetNativeConnectorId(branchConnector, out var selectedNativeId)
                ? (long?)selectedNativeId : null;
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
            object? branchConnectorAfterFitting = null;
            object? branchConnectorAfterChildCommit = null;
            double? branchConnectorDisplacementFt = null;
            var preexistingBranchConnections = CapturePhysicalConnections(branch);
            var preexistingMainConnections = CapturePhysicalConnections(main);
            var mainConnectorCountBefore = MepRoutingUtil.GetConnectors(main).Count;
            var preexistingConnectionsPreservedDuringTransaction = false;
            var createdFittingId = (long?)null;
            var createdTypeId = (long?)null;
            var createdFamilyName = (string?)null;
            var createdTypeName = (string?)null;
            var connectedDuringTransaction = false;
            var connectedAfterCommit = false;
            var committedFittingVerified = false;
            var worksetVerified = targetWorkset == null;
            object? fittingWorksetReadback = null;
            var rolledBack = false;
            var rollbackVerified = false;
            var nativeFailures = new List<string>();
            var failureGuard = new OperatorNativeFailureGuard();

            enterNativeScope();
            var execution = NativeAtomicTransactionGroup.Execute(app, doc, "Connect Existing MEP Branch", () =>
            {
                using (var tx = new Transaction(doc, "Create Existing-Branch Takeoff"))
                {
                    if (tx.Start() != TransactionStatus.Started)
                        throw new InvalidOperationException("The native connection transaction did not start.");
                    NativeNonInteractiveFailureHandling.Configure(tx, failureGuard);
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
                    if (targetWorkset != null)
                    {
                        SetAndVerifyWorkset(fitting, targetWorkset);
                        worksetVerified = true;
                        fittingWorksetReadback = DescribeWorkset(targetWorkset, worksetSource);
                    }

                    var refreshedBranchConnector = ReacquireSelectedTakeoffConnector(
                        branch,
                        selectedBranchConnectorId,
                        branchOrigin,
                        Math.Max(p.originToleranceFt, 0.01));
                    branchConnectorAfterFitting = DescribeConnector(refreshedBranchConnector);
                    branchConnectorDisplacementFt = refreshedBranchConnector.Origin.DistanceTo(branchOrigin);
                    connectedDuringTransaction = PhysicalConnectedOwnerIds(refreshedBranchConnector)
                        .Contains(createdFittingId.Value);
                    if (p.verify && !connectedDuringTransaction)
                        throw new InvalidOperationException("The created takeoff did not physically connect to the requested existing branch connector.");

                    var missingDuringTransaction = FindMissingPhysicalConnections(
                        branch,
                        preexistingBranchConnections,
                        Math.Max(p.originToleranceFt, 0.01));
                    preexistingConnectionsPreservedDuringTransaction = missingDuringTransaction.Count == 0;
                    if (p.verify && !preexistingConnectionsPreservedDuringTransaction)
                        throw new InvalidOperationException($"Creating the takeoff disconnected retained branch topology: {string.Join("; ", missingDuringTransaction)}");

                    if (tx.Commit() != TransactionStatus.Committed)
                        throw new InvalidOperationException("The native connection transaction did not commit.");

                    var committedFitting = doc.GetElement(ElementIdCompat.Create(createdFittingId.Value));
                    if (committedFitting == null)
                        throw new InvalidOperationException("The takeoff fitting did not survive transaction commit.");

                    createdTypeId = ElementIdCompat.GetValue(committedFitting.GetTypeId());
                    ReadFamilyType(committedFitting, out createdFamilyName, out createdTypeName);
                    GuardExpectedTakeoffIdentity(p, createdTypeId.Value, createdFamilyName, createdTypeName);
                    if (targetWorkset != null)
                    {
                        VerifyWorkset(committedFitting, targetWorkset);
                        worksetVerified = true;
                        fittingWorksetReadback = DescribeWorkset(targetWorkset, worksetSource);
                    }

                    var committedBranchConnector = ReacquireSelectedTakeoffConnector(
                        branch,
                        selectedBranchConnectorId,
                        branchOrigin,
                        Math.Max(p.originToleranceFt, 0.01));
                    branchConnectorAfterChildCommit = DescribeConnector(committedBranchConnector);
                    branchConnectorDisplacementFt = committedBranchConnector.Origin.DistanceTo(branchOrigin);
                    connectedAfterCommit = PhysicalConnectedOwnerIds(committedBranchConnector)
                        .Contains(createdFittingId.Value);
                    if (!connectedAfterCommit)
                        throw new InvalidOperationException("The takeoff fitting did not remain physically connected to the requested branch after transaction commit.");

                    var committedFittingOwnerIds = MepRoutingUtil.GetConnectors(committedFitting)
                        .SelectMany(PhysicalConnectedOwnerIds)
                        .ToHashSet();
                    if (!committedFittingOwnerIds.Contains(p.branchElementId) ||
                        !committedFittingOwnerIds.Contains(p.mainElementId))
                    {
                        throw new InvalidOperationException("The committed takeoff does not expose physical connections to both the requested branch and main.");
                    }
                    if (!MepRoutingUtil.GetConnectors(main).SelectMany(PhysicalConnectedOwnerIds).Contains(createdFittingId.Value))
                        throw new InvalidOperationException("The requested main does not expose the reciprocal physical connection to the committed takeoff.");

                    var missingAfterCommit = FindMissingPhysicalConnections(
                        branch,
                        preexistingBranchConnections,
                        Math.Max(p.originToleranceFt, 0.01));
                    if (missingAfterCommit.Count > 0)
                        throw new InvalidOperationException($"Transaction commit disconnected retained branch topology: {string.Join("; ", missingAfterCommit)}");
                    var missingMainAfterCommit = FindMissingPhysicalConnections(
                        main, preexistingMainConnections, Math.Max(p.originToleranceFt, 0.01));
                    if (missingMainAfterCommit.Count > 0)
                        throw new InvalidOperationException($"Transaction commit disconnected retained main topology: {string.Join("; ", missingMainAfterCommit)}");

                    committedFittingVerified = true;
                }
                return new Dictionary<string, object?> { ["success"] = true };
            }, () => createdFittingId.HasValue ? new[] { createdFittingId.Value } : Array.Empty<long>(), () => createdFittingId.HasValue ? new[] { p.mainElementId, p.branchElementId } : Array.Empty<long>(),
                p.dryRun ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit);
            var transaction = (OperatorNativeTransactionReceipt)execution["transaction"]!;
            var executionSucceeded = execution["success"] is bool succeeded && succeeded;
            if (execution.TryGetValue("error", out var executionError) && executionError is string error)
                nativeFailures.Add(error);
            nativeFailures.AddRange(failureGuard.Failures.Select(failure => failure.message));
            rolledBack = transaction.Status == "rolled_back";
            if (rolledBack)
            {
                try
                {
                    var restoredBranchConnector = ReacquireSelectedTakeoffConnector(
                        branch, selectedBranchConnectorId, branchOrigin, Math.Max(p.originToleranceFt, 0.01));
                    rollbackVerified =
                        (!createdFittingId.HasValue || doc.GetElement(ElementIdCompat.Create(createdFittingId.Value)) == null) &&
                        !IsPhysicallyConnected(restoredBranchConnector) &&
                        restoredBranchConnector.Origin.DistanceTo(branchOrigin) <= Math.Max(p.originToleranceFt, 0.01) &&
                        FindMissingPhysicalConnections(branch, preexistingBranchConnections,
                            Math.Max(p.originToleranceFt, 0.01)).Count == 0 &&
                        MepRoutingUtil.GetConnectors(main).Count == mainConnectorCountBefore &&
                        FindMissingPhysicalConnections(main, preexistingMainConnections,
                            Math.Max(p.originToleranceFt, 0.01)).Count == 0;
                    if (!rollbackVerified)
                        nativeFailures.Add("Observed native rollback did not restore the original connection topology exactly.");
                }
                catch (Exception rollbackError)
                {
                    nativeFailures.Add("Rollback readback failed: " + rollbackError.Message);
                }
            }
            else if (transaction.CommittedValue == true)
            {
                rollbackVerified = committedFittingVerified && preexistingConnectionsPreservedDuringTransaction;
            }

            var ok = executionSucceeded && nativeFailures.Count == 0 && rollbackVerified;
            return Task.FromResult<object>(new
            {
                status = ok
                    ? (p.dryRun ? "DryRunReady" : "Connected")
                    : "Blocked",
                success = ok,
                dryRun = p.dryRun,
                mainElementId = p.mainElementId,
                branchElementId = p.branchElementId,
                branchConnector = beforeBranch,
                selectedBranchConnectorId,
                branchConnectorAfterFitting,
                branchConnectorAfterChildCommit,
                branchConnectorDisplacementFt,
                mainConnectorCountBefore,
                preexistingBranchPhysicalConnections = preexistingBranchConnections.Select(DescribePhysicalConnection).ToList(),
                preexistingMainPhysicalConnections = preexistingMainConnections.Select(DescribePhysicalConnection).ToList(),
                preexistingConnectionsPreservedDuringTransaction,
                projectedPoint = ToPoint(projectedPoint),
                branchToMainDistanceFt = branchOrigin.DistanceTo(projectedPoint),
                distanceToMainStartFt = distanceToStart,
                distanceToMainEndFt = distanceToEnd,
                expectedTakeoffTypeId = p.expectedTakeoffTypeId,
                createdFittingId = transaction.CommittedValue == true ? createdFittingId : null,
                previewFittingId = p.dryRun ? createdFittingId : null,
                createdTypeId,
                createdFamilyName,
                createdTypeName,
                requestedWorkset = targetWorkset == null ? null : DescribeWorkset(targetWorkset, worksetSource),
                fittingWorkset = fittingWorksetReadback,
                worksetVerified,
                connectedDuringTransaction,
                connectedAfterCommit,
                committedFittingVerified,
                transaction,
                changeTracking = execution["changeTracking"],
                applied = transaction.CommittedValue,
                transactionGroupRolledBack = rolledBack,
                rollbackVerified,
                nativeFailures,
                capturedFailures = failureGuard.Failures,
                failureRollbackRequested = failureGuard.RollbackRequested,
                nextAction = ok && p.dryRun
                    ? "Apply this exact existing-branch takeoff only if the guarded connector, projected main point, fitting type, and rollback proof are accepted."
                    : null
            });
        }

        private static object HandleAirTerminalOnDuct(
            UIApplication app,
            Document doc,
            MEPCurve main,
            Element terminal,
            Params p,
            Action enterNativeScope)
        {
            var terminalConnector = ResolveOpenBranchConnector(terminal, p);
            var terminalOrigin = terminalConnector.Origin;
            var mainCurve = (main.Location as LocationCurve)?.Curve;
            if (mainCurve == null || !mainCurve.IsBound)
                throw new InvalidOperationException("The main duct must expose a bounded LocationCurve.");
            var projection = mainCurve.Project(terminalOrigin)
                ?? throw new InvalidOperationException("Could not project the air-terminal connector onto the main duct.");
            var projectedPoint = projection.XYZPoint;
            var mainStart = mainCurve.GetEndPoint(0);
            var mainEnd = mainCurve.GetEndPoint(1);
            var distanceToStart = projectedPoint.DistanceTo(mainStart);
            var distanceToEnd = projectedPoint.DistanceTo(mainEnd);
            if (distanceToStart <= 0.01 || distanceToEnd <= 0.01)
                throw new InvalidOperationException("The projected air-terminal point must lie in the interior of the main duct.");

            var terminalId = ElementIdCompat.GetValue(terminal.Id);
            var mainId = ElementIdCompat.GetValue(main.Id);
            var beforeTerminal = DescribeConnector(terminalConnector);
            var preexistingTerminalConnections = CapturePhysicalConnections(terminal);
            var preexistingMainConnections = CapturePhysicalConnections(main);
            var mainConnectorCountBefore = MepRoutingUtil.GetConnectors(main).Count;
            var mainConnectorCountDuringTransaction = (int?)null;
            var mainConnectorCountAfterCommit = (int?)null;
            var mainInteriorConnectorAfterCommit = (object?)null;
            var nativeResult = false;
            var connectedDuringTransaction = false;
            var connectedAfterCommit = false;
            var retainedMainConnectionsPreserved = false;
            var postCommitVerified = false;
            var rolledBack = false;
            var rollbackVerified = false;
            var nativeFailures = new List<string>();
            var failureGuard = new OperatorNativeFailureGuard();

            enterNativeScope();
            var execution = NativeAtomicTransactionGroup.Execute(app, doc, "Connect Air Terminal On Duct", () =>
            {
                using (var tx = new Transaction(doc, "Connect Air Terminal On Duct"))
                {
                    if (tx.Start() != TransactionStatus.Started)
                        throw new InvalidOperationException("The native connection transaction did not start.");
                    NativeNonInteractiveFailureHandling.Configure(tx, failureGuard);
                    nativeResult = MechanicalUtils.ConnectAirTerminalOnDuct(doc, terminal.Id, main.Id);
                    if (!nativeResult)
                        throw new InvalidOperationException("Revit did not connect the air terminal to the duct.");
                    doc.Regenerate();

                    var refreshedTerminalConnector = ResolveConnectorByIdentityOrOrigin(
                        terminal,
                        p.branchConnectorId,
                        terminalOrigin,
                        Math.Max(p.originToleranceFt, 0.01));
                    connectedDuringTransaction = PhysicalConnectedOwnerIds(refreshedTerminalConnector).Contains(mainId);
                    if (p.verify && !connectedDuringTransaction)
                        throw new InvalidOperationException("The air terminal did not expose a direct physical edge to the requested duct during the transaction.");

                    var mainInteriorConnector = MepRoutingUtil.GetConnectors(main)
                        .FirstOrDefault(connector => PhysicalConnectedOwnerIds(connector).Contains(terminalId));
                    if (p.verify && mainInteriorConnector == null)
                        throw new InvalidOperationException("The requested duct did not expose an interior connector to the air terminal during the transaction.");

                    mainConnectorCountDuringTransaction = MepRoutingUtil.GetConnectors(main).Count;
                    var missingMainConnections = FindMissingPhysicalConnections(
                        main,
                        preexistingMainConnections,
                        Math.Max(p.originToleranceFt, 0.01));
                    retainedMainConnectionsPreserved = missingMainConnections.Count == 0;
                    if (p.verify && !retainedMainConnectionsPreserved)
                        throw new InvalidOperationException($"Connecting the air terminal disconnected retained main topology: {string.Join("; ", missingMainConnections)}");

                    if (tx.Commit() != TransactionStatus.Committed)
                        throw new InvalidOperationException("The native connection transaction did not commit.");
                }

                var committedTerminal = doc.GetElement(terminal.Id)
                    ?? throw new InvalidOperationException("The air terminal did not survive transaction commit.");
                var committedMain = doc.GetElement(main.Id) as MEPCurve
                    ?? throw new InvalidOperationException("The main duct did not survive transaction commit.");
                var committedTerminalConnector = ResolveConnectorByIdentityOrOrigin(
                    committedTerminal,
                    p.branchConnectorId,
                    terminalOrigin,
                    Math.Max(p.originToleranceFt, 0.01));
                connectedAfterCommit = PhysicalConnectedOwnerIds(committedTerminalConnector).Contains(mainId);
                var committedMainConnector = MepRoutingUtil.GetConnectors(committedMain)
                    .FirstOrDefault(connector => PhysicalConnectedOwnerIds(connector).Contains(terminalId));
                if (!connectedAfterCommit || committedMainConnector == null)
                    throw new InvalidOperationException("The direct air-terminal-to-duct connection did not survive transaction commit.");

                var missingAfterCommit = FindMissingPhysicalConnections(
                    committedMain,
                    preexistingMainConnections,
                    Math.Max(p.originToleranceFt, 0.01));
                if (missingAfterCommit.Count > 0)
                    throw new InvalidOperationException($"Transaction commit disconnected retained main topology: {string.Join("; ", missingAfterCommit)}");
                if (FindMissingPhysicalConnections(
                        committedTerminal,
                        preexistingTerminalConnections,
                        Math.Max(p.originToleranceFt, 0.01)).Count > 0)
                    throw new InvalidOperationException("Transaction commit disconnected retained air-terminal topology.");

                mainConnectorCountAfterCommit = MepRoutingUtil.GetConnectors(committedMain).Count;
                mainInteriorConnectorAfterCommit = DescribeConnector(committedMainConnector);
                retainedMainConnectionsPreserved = true;
                postCommitVerified = true;
                return new Dictionary<string, object?> { ["success"] = true };
            }, () => Array.Empty<long>(), () => nativeResult ? new[] { mainId, terminalId } : Array.Empty<long>(),
                p.dryRun ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit);
            var transaction = (OperatorNativeTransactionReceipt)execution["transaction"]!;
            var executionSucceeded = execution["success"] is bool succeeded && succeeded;
            if (execution.TryGetValue("error", out var executionError) && executionError is string error)
                nativeFailures.Add(error);
            nativeFailures.AddRange(failureGuard.Failures.Select(failure => failure.message));
            rolledBack = transaction.Status == "rolled_back";
            if (rolledBack)
            {
                try
                {
                    var restoredTerminal = doc.GetElement(terminal.Id)
                        ?? throw new InvalidOperationException("Rollback did not restore the air terminal.");
                    var restoredMain = doc.GetElement(main.Id) as MEPCurve
                        ?? throw new InvalidOperationException("Rollback did not restore the main duct.");
                    var restoredTerminalConnector = ResolveConnectorByIdentityOrOrigin(
                        restoredTerminal, p.branchConnectorId, terminalOrigin, Math.Max(p.originToleranceFt, 0.01));
                    rollbackVerified =
                        !PhysicalConnectedOwnerIds(restoredTerminalConnector).Contains(mainId) &&
                        !MepRoutingUtil.GetConnectors(restoredMain).Any(connector => PhysicalConnectedOwnerIds(connector).Contains(terminalId)) &&
                        MepRoutingUtil.GetConnectors(restoredMain).Count == mainConnectorCountBefore &&
                        FindMissingPhysicalConnections(restoredMain, preexistingMainConnections,
                            Math.Max(p.originToleranceFt, 0.01)).Count == 0 &&
                        FindMissingPhysicalConnections(restoredTerminal, preexistingTerminalConnections,
                            Math.Max(p.originToleranceFt, 0.01)).Count == 0;
                    if (!rollbackVerified)
                        nativeFailures.Add("Observed native rollback did not restore the original connection topology exactly.");
                }
                catch (Exception rollbackError)
                {
                    nativeFailures.Add("Rollback readback failed: " + rollbackError.Message);
                }
            }
            else if (transaction.CommittedValue == true)
            {
                rollbackVerified = postCommitVerified && retainedMainConnectionsPreserved;
            }

            var ok = executionSucceeded && nativeFailures.Count == 0 && rollbackVerified;
            return new
            {
                status = ok ? (p.dryRun ? "DryRunReady" : "Connected") : "Blocked",
                success = ok,
                connectionMode = "air_terminal_on_duct",
                dryRun = p.dryRun,
                mainElementId = mainId,
                terminalElementId = terminalId,
                terminalConnector = beforeTerminal,
                projectedPoint = ToPoint(projectedPoint),
                terminalToMainDistanceFt = terminalOrigin.DistanceTo(projectedPoint),
                distanceToMainStartFt = distanceToStart,
                distanceToMainEndFt = distanceToEnd,
                nativeResult,
                connectedDuringTransaction,
                connectedAfterCommit,
                retainedMainConnectionsPreserved,
                postCommitVerified,
                mainConnectorCountBefore,
                mainConnectorCountDuringTransaction,
                mainConnectorCountAfterCommit,
                mainInteriorConnectorAfterCommit,
                preexistingMainPhysicalConnections = preexistingMainConnections.Select(DescribePhysicalConnection).ToList(),
                preexistingTerminalPhysicalConnections = preexistingTerminalConnections.Select(DescribePhysicalConnection).ToList(),
                transaction,
                changeTracking = execution["changeTracking"],
                applied = transaction.CommittedValue,
                transactionGroupRolledBack = rolledBack,
                rollbackVerified,
                nativeFailures,
                capturedFailures = failureGuard.Failures,
                failureRollbackRequested = failureGuard.RollbackRequested,
                nextAction = ok && p.dryRun
                    ? "Apply this exact direct air-terminal-to-duct connection only if the guarded terminal, projected duct point, retained main topology, post-commit proof, and rollback proof are accepted."
                    : null
            };
        }

        private static Connector ResolveOpenBranchConnector(Element branch, Params p)
        {
            var connectors = MepRoutingUtil.GetConnectors(branch)
                .Where(connector => connector.ConnectorType != ConnectorType.Logical).ToList();
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

        private static Connector ReacquireSelectedTakeoffConnector(
            Element owner, long? capturedNativeId, XYZ originalOrigin, double toleranceFt)
            => MepConnectorReacquisition.Resolve(
                MepRoutingUtil.GetConnectors(owner).Where(connector => connector.ConnectorType != ConnectorType.Logical),
                ElementIdCompat.GetValue(owner.Id), capturedNativeId,
                connector => ElementIdCompat.GetValue(connector.Owner.Id),
                connector => MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId) ? (long?)nativeId : null,
                connector => connector.Origin.DistanceTo(originalOrigin), toleranceFt);

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

        private static void GuardCurveKind(
            Element element,
            string kind,
            string parameterName,
            bool allowFlex)
        {
            var categoryId = element.Category == null
                ? long.MinValue
                : ElementIdCompat.GetValue(element.Category.Id);
            var rigidCategoryId = kind == "pipe"
                ? (long)BuiltInCategory.OST_PipeCurves
                : (long)BuiltInCategory.OST_DuctCurves;
            var flexCategoryId = kind == "pipe"
                ? (long)BuiltInCategory.OST_FlexPipeCurves
                : (long)BuiltInCategory.OST_FlexDuctCurves;
            if (categoryId != rigidCategoryId && (!allowFlex || categoryId != flexCategoryId))
                throw new ArgumentException($"{parameterName} category '{element.Category?.Name}' is not compatible with kind '{kind}'.");
        }

        private static void GuardAirTerminal(Element element, string parameterName)
        {
            var categoryId = element.Category == null
                ? long.MinValue
                : ElementIdCompat.GetValue(element.Category.Id);
            if (categoryId != (long)BuiltInCategory.OST_DuctTerminal || element is not FamilyInstance)
                throw new ArgumentException($"{parameterName} category '{element.Category?.Name}' is not an air terminal family instance.");
        }

        private static string NormalizeConnectionMode(string? value)
        {
            var normalized = (value ?? "takeoff_fitting").Trim().ToLowerInvariant();
            return normalized switch
            {
                "takeoff_fitting" => normalized,
                "air_terminal_on_duct" => normalized,
                _ => throw new ArgumentException("connectionMode must be takeoff_fitting or air_terminal_on_duct.")
            };
        }

        private sealed class PhysicalConnectionSnapshot
        {
            public long? ConnectorId { get; set; }
            public XYZ Origin { get; set; } = XYZ.Zero;
            public long ConnectedOwnerId { get; set; }
            public long? ConnectedConnectorId { get; set; }
            public XYZ ConnectedOrigin { get; set; } = XYZ.Zero;
        }

        private static List<PhysicalConnectionSnapshot> CapturePhysicalConnections(Element owner)
        {
            var result = new List<PhysicalConnectionSnapshot>();
            foreach (var connector in MepRoutingUtil.GetConnectors(owner))
            {
                if (connector.ConnectorType == ConnectorType.Logical) continue;
                var connectorId = MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId)
                    ? nativeId
                    : (long?)null;
                foreach (var connected in PhysicalConnectorReferences(connector))
                {
                    result.Add(new PhysicalConnectionSnapshot
                    {
                        ConnectorId = connectorId,
                        Origin = connector.Origin,
                        ConnectedOwnerId = ElementIdCompat.GetValue(connected.Owner.Id),
                        ConnectedConnectorId = MepSystemUtil.TryGetNativeConnectorId(connected, out var connectedId)
                            ? connectedId : (long?)null,
                        ConnectedOrigin = connected.Origin
                    });
                }
            }
            return result;
        }

        private static List<string> FindMissingPhysicalConnections(
            Element owner,
            IEnumerable<PhysicalConnectionSnapshot> expected,
            double originToleranceFt)
        {
            var connectors = MepRoutingUtil.GetConnectors(owner);
            var missing = new List<string>();
            foreach (var edge in expected)
            {
                var connector = edge.ConnectorId.HasValue
                    ? connectors.FirstOrDefault(candidate =>
                        MepSystemUtil.TryGetNativeConnectorId(candidate, out var nativeId) &&
                        nativeId == edge.ConnectorId.Value)
                    : connectors.OrderBy(candidate => candidate.Origin.DistanceTo(edge.Origin)).FirstOrDefault();
                if (connector == null || connector.Origin.DistanceTo(edge.Origin) > originToleranceFt ||
                    !PhysicalConnectorReferences(connector).Any(reference =>
                        ElementIdCompat.GetValue(reference.Owner.Id) == edge.ConnectedOwnerId &&
                        (edge.ConnectedConnectorId.HasValue
                            ? MepSystemUtil.TryGetNativeConnectorId(reference, out var referenceId) && referenceId == edge.ConnectedConnectorId.Value
                            : reference.Origin.DistanceTo(edge.ConnectedOrigin) <= originToleranceFt)))
                {
                    missing.Add($"connector {edge.ConnectorId?.ToString() ?? "origin_guard"} -> owner {edge.ConnectedOwnerId} connector {edge.ConnectedConnectorId?.ToString() ?? "origin_guard"}");
                }
            }
            return missing;
        }

        private static object DescribePhysicalConnection(PhysicalConnectionSnapshot edge) => new
        {
            connectorId = edge.ConnectorId,
            connectorIdBasis = edge.ConnectorId.HasValue ? "revit_native_connector_id" : "origin_guard",
            origin = ToPoint(edge.Origin),
            connectedOwnerId = edge.ConnectedOwnerId,
            connectedConnectorId = edge.ConnectedConnectorId,
            connectedConnectorIdBasis = edge.ConnectedConnectorId.HasValue ? "revit_native_connector_id" : "origin_guard",
            connectedOrigin = ToPoint(edge.ConnectedOrigin)
        };

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

        private static Workset? ResolveTargetWorkset(
            Document doc,
            Element branch,
            long? requestedWorksetId,
            string? requestedWorksetName,
            out string source)
        {
            source = "not_applicable";
            var requestedName = (requestedWorksetName ?? string.Empty).Trim();
            var hasRequestedId = requestedWorksetId.HasValue && requestedWorksetId.Value > 0;
            var hasRequestedName = requestedName.Length > 0;
            if (!doc.IsWorkshared)
            {
                if (hasRequestedId || hasRequestedName)
                    throw new InvalidOperationException("A takeoff workset was requested, but the active model is not workshared.");
                return null;
            }

            var userWorksets = new FilteredWorksetCollector(doc)
                .OfKind(WorksetKind.UserWorkset)
                .Cast<Workset>()
                .ToList();
            if (hasRequestedId || hasRequestedName)
            {
                var byId = hasRequestedId
                    ? userWorksets.FirstOrDefault(workset => RevitBridge.Common.ElementIdCompat.GetValue(workset.Id) == requestedWorksetId!.Value)
                    : null;
                var byName = hasRequestedName
                    ? userWorksets.FirstOrDefault(workset => string.Equals(workset.Name, requestedName, StringComparison.OrdinalIgnoreCase))
                    : null;
                if (hasRequestedId && byId == null)
                    throw new InvalidOperationException($"Takeoff workset id {requestedWorksetId} was not found as a user workset.");
                if (hasRequestedName && byName == null)
                    throw new InvalidOperationException($"Takeoff workset '{requestedName}' was not found as a user workset.");
                if (byId != null && byName != null && RevitBridge.Common.ElementIdCompat.GetValue(byId.Id) != RevitBridge.Common.ElementIdCompat.GetValue(byName.Id))
                    throw new InvalidOperationException($"Takeoff workset id {requestedWorksetId} does not match workset name '{requestedName}'.");
                source = "explicit";
                return byId ?? byName;
            }

            var branchWorksetId = branch.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM)?.AsInteger() ?? -1;
            var inherited = userWorksets.FirstOrDefault(workset => RevitBridge.Common.ElementIdCompat.GetValue(workset.Id) == branchWorksetId);
            if (inherited != null)
            {
                source = "branch_element";
                return inherited;
            }

            source = "unresolved_branch_workset";
            return null;
        }

        private static void SetAndVerifyWorkset(Element fitting, Workset workset)
        {
            var parameter = fitting.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM)
                ?? throw new InvalidOperationException($"Takeoff fitting {ElementIdCompat.GetValue(fitting.Id)} does not expose ELEM_PARTITION_PARAM.");
            if (parameter.IsReadOnly)
                throw new InvalidOperationException($"Takeoff fitting {ElementIdCompat.GetValue(fitting.Id)} has a read-only workset parameter.");
            parameter.Set(RevitBridge.Common.ElementIdCompat.GetValue(workset.Id));
            VerifyWorkset(fitting, workset);
        }

        private static void VerifyWorkset(Element fitting, Workset workset)
        {
            var actual = fitting.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM)?.AsInteger() ?? -1;
            if (actual != RevitBridge.Common.ElementIdCompat.GetValue(workset.Id))
                throw new InvalidOperationException(
                    $"Takeoff fitting {ElementIdCompat.GetValue(fitting.Id)} workset {actual} did not match requested workset {RevitBridge.Common.ElementIdCompat.GetValue(workset.Id)} ({workset.Name}).");
        }

        private static object DescribeWorkset(Workset workset, string source) => new
        {
            id = RevitBridge.Common.ElementIdCompat.GetValue(workset.Id),
            name = workset.Name,
            source
        };

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
            => PhysicalConnectorReferences(connector).Select(reference => ElementIdCompat.GetValue(reference.Owner.Id))
                .Distinct().OrderBy(id => id).ToList();

        private static List<Connector> PhysicalConnectorReferences(Connector connector)
        {
            var result = new List<Connector>();
            if (connector.ConnectorType == ConnectorType.Logical) return result;
            try
            {
                foreach (Connector reference in connector.AllRefs)
                {
                    var owner = reference?.Owner;
                    if (owner == null || owner is MEPSystem || owner.Id == connector.Owner?.Id) continue;
                    if (reference!.ConnectorType == ConnectorType.Logical || !connector.IsConnectedTo(reference)) continue;
                    result.Add(reference);
                }
            }
            catch (Exception ex)
            {
                // An unreadable connection is not proof that the connector is open.
                throw new InvalidOperationException("Native physical connector inspection failed.", ex);
            }
            return result;
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

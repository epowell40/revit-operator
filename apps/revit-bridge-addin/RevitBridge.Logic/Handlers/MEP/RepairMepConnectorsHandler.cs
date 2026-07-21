using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class RepairMepConnectorsHandler : IRequestHandler
    {
        public sealed class ConnectorReference
        {
            public long elementId { get; set; }
            public long connectorId { get; set; }
            public double[]? expectedOriginXyz { get; set; }
            public double[]? afterOriginXyz { get; set; }
        }

        public sealed class ConnectorPair
        {
            public ConnectorReference first { get; set; } = new ConnectorReference();
            public ConnectorReference second { get; set; } = new ConnectorReference();
        }

        public sealed class RepairOperation
        {
            public string kind { get; set; } = "";
            public List<long> elementIds { get; set; } = new List<long>();
            public long elementId { get; set; }
            public double vectorX { get; set; }
            public double vectorY { get; set; }
            public double vectorZ { get; set; }
            public double[]? startXyz { get; set; }
            public double[]? endXyz { get; set; }
            public List<double[]> flexPoints { get; set; } = new List<double[]>();
            public double[]? startTangent { get; set; }
            public double[]? endTangent { get; set; }
        }

        public sealed class MepSystemMergeOperation
        {
            public long sourceSystemId { get; set; }
            public long targetSystemId { get; set; }
            public string expectedSourceSystemName { get; set; } = "";
            public string expectedTargetSystemName { get; set; } = "";
            public string? finalTargetSystemName { get; set; }
            public List<long> expectedSourceElementIds { get; set; } = new List<long>();
            public List<long> expectedSourceNativeMemberElementIds { get; set; } = new List<long>();
            public List<long> expectedCascadeDeleteElementIds { get; set; } = new List<long>();
            public ConnectorReference anchorConnector { get; set; } = new ConnectorReference();
        }

        public sealed class Params
        {
            public string? expectedModelPath { get; set; }
            public List<ConnectorPair> disconnectOnlyPairs { get; set; } = new List<ConnectorPair>();
            public List<ConnectorPair> disconnectPairs { get; set; } = new List<ConnectorPair>();
            public ConnectorPair? connectOpenPair { get; set; }
            public MepSystemMergeOperation? mergeMepSystem { get; set; }
            public string? connectionKind { get; set; }
            public string? fittingWorksetName { get; set; }
            public long? fittingWorksetId { get; set; }
            public double connectionMaxDistanceFt { get; set; } = 3.0;
            public RepairOperation repair { get; set; } = new RepairOperation();
            public bool allowConnectedRepair { get; set; } = false;
            public double maxConnectorDistanceFt { get; set; } = 0.02;
            public double originToleranceFt { get; set; } = 0.005;
            public bool dryRun { get; set; } = true;
            public bool verify { get; set; } = true;
        }

        private sealed class ResolvedConnector
        {
            public Element Owner { get; set; } = null!;
            public Connector Connector { get; set; } = null!;
            public long ConnectorId { get; set; }
            public string ConnectorIdBasis { get; set; } = "";
            public XYZ Origin { get; set; } = XYZ.Zero;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var shouldApply = !p.dryRun;
            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            AssertExpectedModel(doc, p.expectedModelPath);
            if (p.mergeMepSystem != null)
                return Task.FromResult(HandleMepSystemMerge(doc, p, shouldApply));
            if (p.disconnectOnlyPairs != null && p.disconnectOnlyPairs.Count > 0)
                return Task.FromResult(HandleDisconnectOnly(doc, p, shouldApply));
            if (p.connectOpenPair != null)
                return Task.FromResult(HandleOpenConnectorConnection(doc, p, shouldApply));
            if ((p.disconnectPairs == null || p.disconnectPairs.Count == 0) &&
                !string.IsNullOrWhiteSpace(p.repair?.kind))
                return Task.FromResult(HandleStandaloneRepair(doc, p, shouldApply));
            if (p.disconnectPairs == null || p.disconnectPairs.Count == 0)
                throw new ArgumentException("disconnectPairs is required and must contain at least one exact connector pair.");
            if (p.disconnectPairs.Count > 32)
                throw new ArgumentException("disconnectPairs exceeds the maximum of 32.");
            if (p.maxConnectorDistanceFt <= 0 || p.maxConnectorDistanceFt > 0.25)
                throw new ArgumentException("maxConnectorDistanceFt must be greater than zero and no more than 0.25.");
            if (p.originToleranceFt <= 0 || p.originToleranceFt > 0.05)
                throw new ArgumentException("originToleranceFt must be greater than zero and no more than 0.05.");

            var operationKind = NormalizeOperationKind(p.repair?.kind);
            var repairElementIds = ResolveRepairElementIds(doc, p.repair, operationKind);
            var pairElementIds = p.disconnectPairs
                .SelectMany(pair => new[] { pair.first?.elementId ?? 0, pair.second?.elementId ?? 0 })
                .Where(id => id > 0)
                .Distinct()
                .ToList();
            var auditedElementIds = repairElementIds.Concat(pairElementIds).Distinct().OrderBy(id => id).ToList();
            if (auditedElementIds.Count > 100)
                throw new ArgumentException("Connector repair scope exceeds the maximum of 100 elements.");

            var beforePairs = p.disconnectPairs
                .Select((pair, index) => SnapshotPair(doc, pair, index, p.originToleranceFt, false))
                .ToList();
            var disconnectedBefore = beforePairs.Where(pair => !(bool)pair.GetType().GetProperty("connected")!.GetValue(pair)!).ToList();
            if (disconnectedBefore.Count > 0)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    dryRun = !shouldApply,
                    blockCode = "specified_connector_pair_is_not_currently_connected",
                    beforePairs,
                    auditedElementIds
                });
            }
            var beforeTopology = SnapshotTopology(doc, auditedElementIds);
            var beforeConnectorTopology = SnapshotConnectorTopology(doc, auditedElementIds);

            var warnings = new List<string>();
            var nativeFailures = new List<CapturedFailure>();
            var transactionGroupRolledBack = false;
            var repairApplied = false;
            List<object> afterPairs;
            List<string> afterTopology;
            List<string> afterConnectorTopology;

            using (var group = new TransactionGroup(doc, shouldApply
                ? "Repair Exact MEP Connector Pairs"
                : "Dry Run Exact MEP Connector Repair"))
            {
                group.Start();
                try
                {
                    using (var tx = new Transaction(doc, "Disconnect, Repair, and Reconnect MEP"))
                    {
                        tx.Start();
                        tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(
                            tx,
                            nativeFailures,
                            rollbackOnErrors: true,
                            deleteWarnings: false));

                        var resolvedDisconnectPairs = p.disconnectPairs
                            .Select(pair => new
                            {
                                First = ResolveConnector(doc, pair.first, p.originToleranceFt, false),
                                Second = ResolveConnector(doc, pair.second, p.originToleranceFt, false)
                            })
                            .ToList();
                        foreach (var pair in resolvedDisconnectPairs)
                        {
                            AssertCompatible(pair.First.Connector, pair.Second.Connector, "disconnect");
                            if (!AreDirectlyConnected(pair.First.Connector, pair.Second.Connector))
                                throw new InvalidOperationException("specified_connector_pair_changed_before_disconnect");
                        }
                        foreach (var pair in resolvedDisconnectPairs)
                        {
                            pair.First.Connector.DisconnectFrom(pair.Second.Connector);
                        }

                        doc.Regenerate();
                        ApplyRepair(doc, p.repair, operationKind, repairElementIds);
                        repairApplied = true;
                        doc.Regenerate();

                        foreach (var pair in p.disconnectPairs)
                        {
                            var a = ResolveConnectorAfterRepair(
                                doc, pair.first, p.originToleranceFt, p.repair, operationKind, repairElementIds);
                            var b = ResolveConnectorAfterRepair(
                                doc, pair.second, p.originToleranceFt, p.repair, operationKind, repairElementIds);
                            AssertCompatible(a.Connector, b.Connector, "reconnect");
                            var distance = a.Connector.Origin.DistanceTo(b.Connector.Origin);
                            if (distance > p.maxConnectorDistanceFt)
                                throw new InvalidOperationException(
                                    $"connector_reconnect_distance_exceeds_limit:{distance:0.########}:{p.maxConnectorDistanceFt:0.########}");
                            a.Connector.ConnectTo(b.Connector);
                            doc.Regenerate();
                            if (!AreDirectlyConnected(a.Connector, b.Connector))
                                throw new InvalidOperationException("connector_reconnect_native_audit_failed");
                        }

                        var status = tx.Commit();
                        if (status != TransactionStatus.Committed)
                            throw new InvalidOperationException($"connector_repair_transaction_not_committed:{status}");
                    }

                    afterPairs = p.disconnectPairs
                        .Select((pair, index) => SnapshotPairAfterRepair(
                            doc, pair, index, p.originToleranceFt, p.repair, operationKind, repairElementIds))
                        .ToList();
                    afterTopology = SnapshotTopology(doc, auditedElementIds);
                    afterConnectorTopology = SnapshotConnectorTopology(doc, auditedElementIds);
                    if (afterPairs.Any(pair => !(bool)pair.GetType().GetProperty("connected")!.GetValue(pair)!))
                        throw new InvalidOperationException("connector_repair_post_transaction_pair_audit_failed");
                    if (p.verify && (!beforeTopology.SequenceEqual(afterTopology) ||
                        !beforeConnectorTopology.SequenceEqual(afterConnectorTopology)))
                        throw new InvalidOperationException("connector_repair_changed_audited_physical_topology");

                    if (shouldApply)
                    {
                        var groupStatus = group.Assimilate();
                        if (groupStatus != TransactionStatus.Committed)
                            throw new InvalidOperationException($"connector_repair_transaction_group_not_committed:{groupStatus}");
                    }
                    else
                    {
                        group.RollBack();
                        transactionGroupRolledBack = true;
                    }
                }
                catch (Exception ex)
                {
                    try
                    {
                        if (group.GetStatus() == TransactionStatus.Started)
                        {
                            group.RollBack();
                            transactionGroupRolledBack = true;
                        }
                    }
                    catch { }
                    var rollbackPairs = SafeSnapshotPairs(doc, p.disconnectPairs, p.originToleranceFt);
                    var rollbackTopology = SnapshotTopology(doc, auditedElementIds);
                    var rollbackConnectorTopology = SnapshotConnectorTopology(doc, auditedElementIds);
                    return Task.FromResult<object>(new
                    {
                        status = "Blocked",
                        dryRun = !shouldApply,
                        blockCode = "connector_identity_repair_failed",
                        reason = ex.Message,
                        operationKind,
                        repairApplied,
                        transactionGroupRolledBack,
                        rollbackVerified = beforeTopology.SequenceEqual(rollbackTopology) &&
                            beforeConnectorTopology.SequenceEqual(rollbackConnectorTopology) &&
                            rollbackPairs.All(pair => (bool)pair.GetType().GetProperty("connected")!.GetValue(pair)!),
                        beforePairs,
                        rollbackPairs,
                        beforeTopology,
                        rollbackTopology,
                        beforeConnectorTopology,
                        rollbackConnectorTopology,
                        nativeFailures,
                        warnings,
                        auditedElementIds
                    });
                }
            }

            var finalPairs = shouldApply
                ? p.disconnectPairs.Select((pair, index) => SnapshotPairAfterRepair(
                    doc, pair, index, p.originToleranceFt, p.repair, operationKind, repairElementIds)).ToList()
                : SafeSnapshotPairs(doc, p.disconnectPairs, p.originToleranceFt);
            var finalTopology = SnapshotTopology(doc, auditedElementIds);
            var finalConnectorTopology = SnapshotConnectorTopology(doc, auditedElementIds);
            var rollbackVerified = shouldApply || (
                beforeTopology.SequenceEqual(finalTopology) &&
                beforeConnectorTopology.SequenceEqual(finalConnectorTopology) &&
                finalPairs.All(pair => (bool)pair.GetType().GetProperty("connected")!.GetValue(pair)!));
            return Task.FromResult<object>(new
            {
                status = shouldApply ? "Repaired" : "DryRunReady",
                dryRun = !shouldApply,
                operationKind,
                transactionGroupRolledBack,
                rollbackVerified,
                beforePairs,
                afterPairs,
                finalPairs,
                beforeTopology,
                afterTopology,
                finalTopology,
                beforeConnectorTopology,
                afterConnectorTopology,
                finalConnectorTopology,
                topologyExactMatch = beforeTopology.SequenceEqual(afterTopology),
                connectorTopologyExactMatch = beforeConnectorTopology.SequenceEqual(afterConnectorTopology),
                nativeFailures,
                warnings,
                auditedElementIds,
                nextAction = shouldApply
                    ? "Save the accepted repair checkpoint, read back sizes/systems, and capture focused visual evidence."
                    : "Apply this exact connector identity repair only if the dry-run pair, topology, and rollback audits are accepted."
            });
        }

        private sealed class MepSystemState
        {
            public bool exists { get; set; }
            public long systemId { get; set; }
            public string name { get; set; } = "";
            public long typeId { get; set; }
            public bool isEmpty { get; set; }
            public List<long> memberIds { get; set; } = new List<long>();
        }

        private static object HandleMepSystemMerge(Document doc, Params p, bool shouldApply)
        {
            if ((p.disconnectOnlyPairs != null && p.disconnectOnlyPairs.Count > 0) ||
                (p.disconnectPairs != null && p.disconnectPairs.Count > 0) ||
                p.connectOpenPair != null ||
                !string.IsNullOrWhiteSpace(p.repair?.kind))
                throw new ArgumentException(
                    "mergeMepSystem cannot be combined with connector-pair or geometry-repair modes.");

            var request = p.mergeMepSystem ??
                throw new ArgumentException("mergeMepSystem is required.");
            if (request.sourceSystemId <= 0 || request.targetSystemId <= 0)
                throw new ArgumentException("mergeMepSystem sourceSystemId and targetSystemId must be positive.");
            if (request.sourceSystemId == request.targetSystemId)
                throw new ArgumentException("mergeMepSystem source and target systems must be different.");
            if (string.IsNullOrWhiteSpace(request.expectedSourceSystemName) ||
                string.IsNullOrWhiteSpace(request.expectedTargetSystemName))
                throw new ArgumentException(
                    "mergeMepSystem requires expectedSourceSystemName and expectedTargetSystemName.");

            var expectedSourceElementIds = (request.expectedSourceElementIds ?? new List<long>())
                .Where(id => id > 0)
                .Distinct()
                .OrderBy(id => id)
                .ToList();
            if (expectedSourceElementIds.Count == 0 || expectedSourceElementIds.Count > 500)
                throw new ArgumentException(
                    "mergeMepSystem expectedSourceElementIds must contain 1 to 500 unique positive ids.");
            var expectedSourceNativeMemberElementIds =
                (request.expectedSourceNativeMemberElementIds ?? new List<long>())
                .Where(id => id > 0)
                .Distinct()
                .OrderBy(id => id)
                .ToList();
            if (expectedSourceNativeMemberElementIds.Count == 0 ||
                expectedSourceNativeMemberElementIds.Count > 500)
                throw new ArgumentException(
                    "mergeMepSystem expectedSourceNativeMemberElementIds must contain 1 to 500 unique positive ids.");
            if (expectedSourceNativeMemberElementIds.Except(expectedSourceElementIds).Any())
                throw new ArgumentException(
                    "mergeMepSystem expectedSourceNativeMemberElementIds must be a subset of expectedSourceElementIds.");
            var expectedCascadeDeleteElementIds =
                (request.expectedCascadeDeleteElementIds ?? new List<long>())
                .Where(id => id > 0)
                .Distinct()
                .OrderBy(id => id)
                .ToList();
            if (expectedCascadeDeleteElementIds.Count > 32)
                throw new ArgumentException(
                    "mergeMepSystem expectedCascadeDeleteElementIds must contain no more than 32 unique positive ids.");
            if (expectedCascadeDeleteElementIds.Contains(request.sourceSystemId) ||
                expectedCascadeDeleteElementIds.Intersect(expectedSourceElementIds).Any())
                throw new ArgumentException(
                    "mergeMepSystem expectedCascadeDeleteElementIds must not include the source system or source graph elements.");
            foreach (var expectedCascadeDeleteElementId in expectedCascadeDeleteElementIds)
                AssertSafeCascadeDeleteElement(doc, expectedCascadeDeleteElementId);
            if (request.anchorConnector == null || request.anchorConnector.elementId <= 0)
                throw new ArgumentException("mergeMepSystem.anchorConnector is required.");
            if (!expectedSourceElementIds.Contains(request.anchorConnector.elementId))
                throw new ArgumentException(
                    "mergeMepSystem.anchorConnector element must belong to expectedSourceElementIds.");
            if (!expectedSourceNativeMemberElementIds.Contains(request.anchorConnector.elementId))
                throw new ArgumentException(
                    "mergeMepSystem.anchorConnector element must belong to expectedSourceNativeMemberElementIds.");
            if (p.originToleranceFt <= 0 || p.originToleranceFt > 0.05)
                throw new ArgumentException("originToleranceFt must be greater than zero and no more than 0.05.");

            var sourceSystem = ResolveMepSystem(doc, request.sourceSystemId, "source");
            var targetSystem = ResolveMepSystem(doc, request.targetSystemId, "target");
            AssertExpectedSystemName(sourceSystem, request.expectedSourceSystemName, "source");
            AssertExpectedSystemName(targetSystem, request.expectedTargetSystemName, "target");
            if (sourceSystem.GetTypeId() != targetSystem.GetTypeId())
                throw new InvalidOperationException(
                    $"mep_system_type_mismatch:{ElementIdCompat.GetValue(sourceSystem.GetTypeId())}:" +
                    $"{ElementIdCompat.GetValue(targetSystem.GetTypeId())}");
            if (sourceSystem.Category?.Id != targetSystem.Category?.Id)
                throw new InvalidOperationException("mep_system_category_mismatch");

            var beforeSource = SnapshotMepSystem(doc, request.sourceSystemId);
            var beforeTarget = SnapshotMepSystem(doc, request.targetSystemId);
            if (!beforeSource.memberIds.SequenceEqual(expectedSourceNativeMemberElementIds))
                throw new InvalidOperationException(
                    "source_system_native_membership_changed:" +
                    $"expected={string.Join(",", expectedSourceNativeMemberElementIds)}:" +
                    $"actual={string.Join(",", beforeSource.memberIds)}");
            if (beforeTarget.memberIds.Intersect(expectedSourceElementIds).Any())
                throw new InvalidOperationException(
                    "source_and_target_system_memberships_are_not_disjoint");
            AssertElementsAssignedToSystem(
                doc,
                expectedSourceElementIds,
                request.sourceSystemId,
                request.targetSystemId);

            var resolvedAnchorBefore = ResolveConnector(
                doc,
                request.anchorConnector,
                p.originToleranceFt,
                false);
            var anchorBefore = SnapshotResolvedConnector(resolvedAnchorBefore);
            var anchorSystemIdBefore = resolvedAnchorBefore.Connector.MEPSystem == null
                ? 0
                : ElementIdCompat.GetValue(resolvedAnchorBefore.Connector.MEPSystem.Id);
            if (anchorSystemIdBefore != request.sourceSystemId)
                throw new InvalidOperationException(
                    $"anchor_connector_not_owned_by_source_system:{anchorSystemIdBefore}");

            var auditedElementIds = beforeTarget.memberIds
                .Concat(expectedSourceElementIds)
                .Distinct()
                .OrderBy(id => id)
                .ToList();
            var beforeAssignments = SnapshotElementMepSystemAssignments(doc, auditedElementIds);
            var expectedTargetAfterIds = beforeTarget.memberIds
                .Concat(expectedSourceNativeMemberElementIds)
                .Distinct()
                .OrderBy(id => id)
                .ToList();
            var expectedTargetSystemNameAfter =
                string.IsNullOrWhiteSpace(request.finalTargetSystemName)
                    ? beforeTarget.name
                    : request.finalTargetSystemName!.Trim();

            var nativeFailures = new List<CapturedFailure>();
            var transactionGroupRolledBack = false;
            MepSystemState? afterSource = null;
            MepSystemState? afterTarget = null;
            List<string>? afterAssignments = null;
            object? anchorAfterAdd = null;

            using (var group = new TransactionGroup(
                doc,
                shouldApply ? "Merge Exact MEP Systems" : "Dry Run Exact MEP System Merge"))
            {
                group.Start();
                try
                {
                    using (var tx = new Transaction(doc, "Move Exact Network To Retained MEP System"))
                    {
                        tx.Start();
                        tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(
                            tx,
                            nativeFailures,
                            rollbackOnErrors: true,
                            deleteWarnings: false));

                        var deletedIds = doc.Delete(sourceSystem.Id)
                            .Select(ElementIdCompat.GetValue)
                            .OrderBy(id => id)
                            .ToList();
                        var actualCascadeDeletedIds = deletedIds
                            .Where(id => id != request.sourceSystemId)
                            .ToList();
                        if (!actualCascadeDeletedIds.SequenceEqual(
                            expectedCascadeDeleteElementIds))
                            throw new InvalidOperationException(
                                "source_system_cascade_delete_changed:" +
                                $"expected={string.Join(",", expectedCascadeDeleteElementIds)}:" +
                                $"actual={string.Join(",", actualCascadeDeletedIds)}");
                        doc.Regenerate();

                        var missingSourceElementIds = expectedSourceElementIds
                            .Where(id => doc.GetElement(ElementIdCompat.Create(id)) == null)
                            .ToList();
                        if (missingSourceElementIds.Count > 0)
                            throw new InvalidOperationException(
                                "source_system_delete_removed_expected_elements:" +
                                string.Join(",", missingSourceElementIds));

                        var resolvedAnchor = ResolveConnector(
                            doc,
                            request.anchorConnector,
                            p.originToleranceFt,
                            false);
                        var anchorSystemAfterRemove = resolvedAnchor.Connector.MEPSystem == null
                            ? 0
                            : ElementIdCompat.GetValue(resolvedAnchor.Connector.MEPSystem.Id);
                        if (anchorSystemAfterRemove != 0)
                            throw new InvalidOperationException(
                                $"anchor_connector_still_has_system_after_source_delete:{anchorSystemAfterRemove}");
                        var anchorConnectorSet = new ConnectorSet();
                        anchorConnectorSet.Insert(resolvedAnchor.Connector);
                        targetSystem.Add(anchorConnectorSet);
                        doc.Regenerate();

                        foreach (var nativeMemberElementId in expectedSourceNativeMemberElementIds
                            .Where(id => id != request.anchorConnector.elementId))
                        {
                            var nativeMember = doc.GetElement(
                                ElementIdCompat.Create(nativeMemberElementId)) ??
                                throw new InvalidOperationException(
                                    $"source_native_member_missing_after_system_delete:{nativeMemberElementId}");
                            var connectors = MepSystemUtil.GetConnectors(nativeMember)
                                .ToList();
                            if (connectors.Any(connector =>
                                connector.MEPSystem != null &&
                                ElementIdCompat.GetValue(connector.MEPSystem.Id) ==
                                    request.targetSystemId))
                                continue;
                            var nextUnassignedConnector = connectors
                                .Where(connector => connector.MEPSystem == null)
                                .OrderBy(connector => connector.Id)
                                .FirstOrDefault();
                            if (nextUnassignedConnector == null)
                                throw new InvalidOperationException(
                                    $"source_native_member_has_no_unassigned_connector_after_anchor_add:" +
                                    $"{nativeMemberElementId}");
                            var nativeMemberConnectorSet = new ConnectorSet();
                            nativeMemberConnectorSet.Insert(nextUnassignedConnector);
                            targetSystem.Add(nativeMemberConnectorSet);
                            doc.Regenerate();
                        }

                        if (!string.Equals(
                            targetSystem.Name,
                            expectedTargetSystemNameAfter,
                            StringComparison.Ordinal))
                        {
                            targetSystem.Name = expectedTargetSystemNameAfter;
                            doc.Regenerate();
                        }

                        var anchorSystemAfterAdd = resolvedAnchor.Connector.MEPSystem == null
                            ? 0
                            : ElementIdCompat.GetValue(resolvedAnchor.Connector.MEPSystem.Id);
                        if (anchorSystemAfterAdd != request.targetSystemId)
                            throw new InvalidOperationException(
                                $"anchor_connector_target_system_after_add_mismatch:" +
                                $"expected={request.targetSystemId}:actual={anchorSystemAfterAdd}");
                        anchorAfterAdd = new
                        {
                            elementId = ElementIdCompat.GetValue(resolvedAnchor.Owner.Id),
                            connectorId = resolvedAnchor.ConnectorId,
                            connectorIdBasis = resolvedAnchor.ConnectorIdBasis,
                            origin = new[]
                            {
                                resolvedAnchor.Connector.Origin.X,
                                resolvedAnchor.Connector.Origin.Y,
                                resolvedAnchor.Connector.Origin.Z
                            },
                            systemId = anchorSystemAfterAdd
                        };

                        var status = tx.Commit();
                        if (status != TransactionStatus.Committed)
                            throw new InvalidOperationException(
                                $"mep_system_merge_transaction_not_committed:{status}");
                    }

                    afterSource = SnapshotMepSystem(doc, request.sourceSystemId);
                    afterTarget = SnapshotMepSystem(doc, request.targetSystemId);
                    afterAssignments = SnapshotElementMepSystemAssignments(doc, auditedElementIds);
                    if (!string.Equals(
                        afterTarget.name,
                        expectedTargetSystemNameAfter,
                        StringComparison.Ordinal))
                        throw new InvalidOperationException(
                            "target_system_name_after_merge_mismatch:" +
                            $"expected={expectedTargetSystemNameAfter}:actual={afterTarget.name}");
                    if (!afterTarget.memberIds.SequenceEqual(expectedTargetAfterIds))
                        throw new InvalidOperationException(
                            "target_system_membership_after_merge_mismatch:" +
                            $"expected={string.Join(",", expectedTargetAfterIds)}:" +
                            $"actual={string.Join(",", afterTarget.memberIds)}");
                    if (afterSource.exists &&
                        afterSource.memberIds.Intersect(expectedSourceNativeMemberElementIds).Any())
                        throw new InvalidOperationException(
                            "source_system_still_contains_moved_elements");
                    AssertElementsAssignedToSystem(
                        doc,
                        expectedSourceElementIds,
                        request.targetSystemId,
                        request.sourceSystemId);

                    if (shouldApply)
                    {
                        var groupStatus = group.Assimilate();
                        if (groupStatus != TransactionStatus.Committed)
                            throw new InvalidOperationException(
                                $"mep_system_merge_transaction_group_not_committed:{groupStatus}");
                    }
                    else
                    {
                        group.RollBack();
                        transactionGroupRolledBack = true;
                    }
                }
                catch (Exception ex)
                {
                    try
                    {
                        if (group.GetStatus() == TransactionStatus.Started)
                        {
                            group.RollBack();
                            transactionGroupRolledBack = true;
                        }
                    }
                    catch { }
                    var rollbackSource = SnapshotMepSystem(doc, request.sourceSystemId);
                    var rollbackTarget = SnapshotMepSystem(doc, request.targetSystemId);
                    var rollbackAssignments = SnapshotElementMepSystemAssignments(doc, auditedElementIds);
                    return new
                    {
                        status = "Blocked",
                        dryRun = !shouldApply,
                        blockCode = "mep_system_merge_failed",
                        reason = ex.Message,
                        transactionGroupRolledBack,
                        rollbackVerified =
                            MepSystemStatesEqual(beforeSource, rollbackSource) &&
                            MepSystemStatesEqual(beforeTarget, rollbackTarget) &&
                            beforeAssignments.SequenceEqual(rollbackAssignments),
                        beforeSource,
                        beforeTarget,
                        rollbackSource,
                        rollbackTarget,
                        beforeAssignments,
                        afterSource,
                        afterTarget,
                        afterAssignments,
                        rollbackAssignments,
                        anchorBefore,
                        anchorAfterAdd,
                        expectedTargetSystemNameAfter,
                        nativeFailures,
                        auditedElementIds
                    };
                }
            }

            var finalSource = SnapshotMepSystem(doc, request.sourceSystemId);
            var finalTarget = SnapshotMepSystem(doc, request.targetSystemId);
            var finalAssignments = SnapshotElementMepSystemAssignments(doc, auditedElementIds);
            var rollbackVerified = shouldApply || (
                MepSystemStatesEqual(beforeSource, finalSource) &&
                MepSystemStatesEqual(beforeTarget, finalTarget) &&
                beforeAssignments.SequenceEqual(finalAssignments));
            return new
            {
                status = shouldApply ? "Merged" : "DryRunReady",
                dryRun = !shouldApply,
                transactionGroupRolledBack,
                rollbackVerified,
                beforeSource,
                beforeTarget,
                afterSource,
                afterTarget,
                finalSource,
                finalTarget,
                beforeAssignments,
                afterAssignments,
                finalAssignments,
                anchorBefore,
                anchorAfterAdd,
                expectedSourceElementIds,
                expectedSourceNativeMemberElementIds,
                expectedCascadeDeleteElementIds,
                expectedTargetAfterIds,
                expectedTargetSystemNameAfter,
                nativeFailures,
                auditedElementIds,
                nextAction = shouldApply
                    ? "Save the accepted checkpoint and read back every moved element's MEP system id and name."
                    : "Apply this exact system merge only if the dry-run membership and rollback audits are accepted."
            };
        }

        private static MEPSystem ResolveMepSystem(Document doc, long id, string label)
        {
            var system = doc.GetElement(ElementIdCompat.Create(id)) as MEPSystem;
            if (system == null)
                throw new ArgumentException($"{label}_mep_system_not_found:{id}");
            return system;
        }

        private static void AssertSafeCascadeDeleteElement(Document doc, long id)
        {
            var element = doc.GetElement(ElementIdCompat.Create(id));
            if (element == null)
                throw new ArgumentException($"cascade_delete_element_not_found:{id}");

            BoundingBoxXYZ? boundingBox;
            try
            {
                boundingBox = element.get_BoundingBox(null);
            }
            catch
            {
                throw new InvalidOperationException(
                    $"cascade_delete_element_bounding_box_unreadable:{id}");
            }

            if (element.GetType() != typeof(Element) ||
                element.Category != null ||
                !string.IsNullOrWhiteSpace(element.Name) ||
                element.Location != null ||
                boundingBox != null ||
                element.GetTypeId() != ElementId.InvalidElementId)
                throw new InvalidOperationException(
                    $"cascade_delete_element_is_not_verified_internal_bookkeeping:{id}:" +
                    $"class={element.GetType().FullName}:" +
                    $"category={element.Category?.Name ?? ""}:" +
                    $"name={element.Name ?? ""}");
        }

        private static void AssertExpectedSystemName(
            MEPSystem system,
            string expected,
            string label)
        {
            var actual = system.Name ?? "";
            if (!string.Equals(actual, expected, StringComparison.Ordinal))
                throw new InvalidOperationException(
                    $"{label}_mep_system_name_mismatch:expected={expected}:actual={actual}");
        }

        private static MepSystemState SnapshotMepSystem(Document doc, long id)
        {
            var system = doc.GetElement(ElementIdCompat.Create(id)) as MEPSystem;
            if (system == null)
            {
                return new MepSystemState
                {
                    exists = false,
                    systemId = id,
                    memberIds = new List<long>()
                };
            }
            return new MepSystemState
            {
                exists = true,
                systemId = id,
                name = system.Name ?? "",
                typeId = ElementIdCompat.GetValue(system.GetTypeId()),
                isEmpty = system.IsEmpty,
                memberIds = system.Elements
                    .Cast<Element>()
                    .Where(element => element != null)
                    .Select(element => ElementIdCompat.GetValue(element.Id))
                    .Distinct()
                    .OrderBy(elementId => elementId)
                    .ToList()
            };
        }

        private static List<string> SnapshotElementMepSystemAssignments(
            Document doc,
            IEnumerable<long> elementIds)
        {
            var rows = new List<string>();
            foreach (var elementId in elementIds.Distinct().OrderBy(id => id))
            {
                var element = doc.GetElement(ElementIdCompat.Create(elementId));
                var systemIds = element == null
                    ? new List<long>()
                    : MepSystemUtil.GetConnectors(element)
                        .Select(connector => connector.MEPSystem)
                        .Where(system => system != null)
                        .Select(system => ElementIdCompat.GetValue(system!.Id))
                        .Distinct()
                        .OrderBy(id => id)
                        .ToList();
                rows.Add($"{elementId}:{string.Join(",", systemIds)}");
            }
            return rows;
        }

        private static void AssertElementsAssignedToSystem(
            Document doc,
            IEnumerable<long> elementIds,
            long expectedSystemId,
            long forbiddenSystemId)
        {
            foreach (var elementId in elementIds)
            {
                var element = doc.GetElement(ElementIdCompat.Create(elementId)) ??
                    throw new InvalidOperationException(
                        $"mep_system_merge_element_missing:{elementId}");
                var systemIds = MepSystemUtil.GetConnectors(element)
                    .Select(connector => connector.MEPSystem)
                    .Where(system => system != null)
                    .Select(system => ElementIdCompat.GetValue(system!.Id))
                    .Distinct()
                    .ToList();
                if (!systemIds.Contains(expectedSystemId) ||
                    systemIds.Contains(forbiddenSystemId))
                    throw new InvalidOperationException(
                        $"mep_system_merge_assignment_failed:{elementId}:" +
                        $"systems={string.Join(",", systemIds)}");
            }
        }

        private static bool MepSystemStatesEqual(MepSystemState a, MepSystemState b)
        {
            return a.exists == b.exists &&
                a.systemId == b.systemId &&
                string.Equals(a.name, b.name, StringComparison.Ordinal) &&
                a.typeId == b.typeId &&
                a.isEmpty == b.isEmpty &&
                a.memberIds.SequenceEqual(b.memberIds);
        }

        private static object SnapshotResolvedConnector(ResolvedConnector connector)
        {
            return new
            {
                elementId = ElementIdCompat.GetValue(connector.Owner.Id),
                connectorId = connector.ConnectorId,
                connectorIdBasis = connector.ConnectorIdBasis,
                origin = new[]
                {
                    connector.Connector.Origin.X,
                    connector.Connector.Origin.Y,
                    connector.Connector.Origin.Z
                },
                systemId = connector.Connector.MEPSystem == null
                    ? 0
                    : ElementIdCompat.GetValue(connector.Connector.MEPSystem.Id),
                systemName = connector.Connector.MEPSystem?.Name ?? ""
            };
        }

        private static object HandleDisconnectOnly(Document doc, Params p, bool shouldApply)
        {
            if (p.connectOpenPair != null ||
                (p.disconnectPairs != null && p.disconnectPairs.Count > 0) ||
                !string.IsNullOrWhiteSpace(p.repair?.kind))
                throw new ArgumentException(
                    "disconnectOnlyPairs cannot be combined with connectOpenPair, disconnectPairs, or repair.");
            if (p.disconnectOnlyPairs == null || p.disconnectOnlyPairs.Count == 0)
                throw new ArgumentException("disconnectOnlyPairs is required.");
            if (p.disconnectOnlyPairs.Count > 32)
                throw new ArgumentException("disconnectOnlyPairs exceeds the maximum of 32.");
            if (p.originToleranceFt <= 0 || p.originToleranceFt > 0.05)
                throw new ArgumentException("originToleranceFt must be greater than zero and no more than 0.05.");

            var pairElementIds = p.disconnectOnlyPairs
                .SelectMany(pair => new[] { pair.first?.elementId ?? 0, pair.second?.elementId ?? 0 })
                .Where(id => id > 0)
                .Distinct()
                .OrderBy(id => id)
                .ToList();
            if (pairElementIds.Count > 64)
                throw new ArgumentException("Disconnect-only scope exceeds the maximum of 64 elements.");

            var beforePairs = p.disconnectOnlyPairs
                .Select((pair, index) => SnapshotPair(doc, pair, index, p.originToleranceFt, false))
                .ToList();
            if (beforePairs.Any(pair => !(bool)pair.GetType().GetProperty("connected")!.GetValue(pair)!))
            {
                return new
                {
                    status = "Blocked",
                    dryRun = !shouldApply,
                    blockCode = "specified_disconnect_only_pair_is_not_currently_connected",
                    beforePairs,
                    auditedElementIds = pairElementIds
                };
            }

            var beforeTopology = SnapshotTopology(doc, pairElementIds);
            var beforeConnectorTopology = SnapshotConnectorTopology(doc, pairElementIds);
            var expectedRemovedConnectorEdges = p.disconnectOnlyPairs
                .Select(pair => ConnectorEdgeIdentity(
                    ResolveConnector(doc, pair.first, p.originToleranceFt, false),
                    ResolveConnector(doc, pair.second, p.originToleranceFt, false)))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(edge => edge, StringComparer.Ordinal)
                .ToList();
            var expectedAfterConnectorTopology = beforeConnectorTopology
                .Where(edge => !expectedRemovedConnectorEdges.Contains(edge, StringComparer.Ordinal))
                .OrderBy(edge => edge, StringComparer.Ordinal)
                .ToList();
            if (expectedRemovedConnectorEdges.Any(edge =>
                !beforeConnectorTopology.Contains(edge, StringComparer.Ordinal)))
                throw new InvalidOperationException(
                    "specified_disconnect_only_connector_edge_missing_from_physical_topology");
            var expectedRemovedEdges = p.disconnectOnlyPairs
                .Select(pair =>
                {
                    var low = Math.Min(pair.first.elementId, pair.second.elementId);
                    var high = Math.Max(pair.first.elementId, pair.second.elementId);
                    return $"{low}:{high}";
                })
                .Distinct(StringComparer.Ordinal)
                .OrderBy(edge => edge, StringComparer.Ordinal)
                .ToList();
            var expectedAfterTopology = beforeTopology
                .Where(edge => !expectedRemovedEdges.Contains(edge, StringComparer.Ordinal))
                .OrderBy(edge => edge, StringComparer.Ordinal)
                .ToList();
            if (expectedRemovedEdges.Any(edge => !beforeTopology.Contains(edge, StringComparer.Ordinal)))
                throw new InvalidOperationException("specified_disconnect_only_edge_missing_from_physical_topology");

            var nativeFailures = new List<CapturedFailure>();
            var transactionGroupRolledBack = false;
            List<object> afterPairs;
            List<string> afterTopology;
            List<string> afterConnectorTopology;
            using (var group = new TransactionGroup(doc, shouldApply
                ? "Disconnect Exact MEP Connector Pairs"
                : "Dry Run Disconnect Exact MEP Connector Pairs"))
            {
                group.Start();
                try
                {
                    using (var tx = new Transaction(doc, "Disconnect Exact MEP Connector Pairs"))
                    {
                        tx.Start();
                        tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(
                            tx,
                            nativeFailures,
                            rollbackOnErrors: true,
                            deleteWarnings: false));
                        var resolvedDisconnectPairs = p.disconnectOnlyPairs
                            .Select(pair => new
                            {
                                First = ResolveConnector(doc, pair.first, p.originToleranceFt, false),
                                Second = ResolveConnector(doc, pair.second, p.originToleranceFt, false)
                            })
                            .ToList();
                        foreach (var pair in resolvedDisconnectPairs)
                        {
                            AssertCompatible(pair.First.Connector, pair.Second.Connector, "disconnect");
                            if (!AreDirectlyConnected(pair.First.Connector, pair.Second.Connector))
                                throw new InvalidOperationException(
                                    "specified_disconnect_only_pair_changed_before_disconnect");
                        }
                        foreach (var pair in resolvedDisconnectPairs)
                        {
                            pair.First.Connector.DisconnectFrom(pair.Second.Connector);
                        }
                        doc.Regenerate();
                        // Revit removes transient interior MEPCurve connectors when a
                        // takeoff is disconnected. Treat that expected disappearance as
                        // an open pair and let the exact topology audit prove the edge
                        // removal instead of failing connector re-resolution.
                        afterPairs = SafeSnapshotPairs(
                            doc,
                            p.disconnectOnlyPairs,
                            p.originToleranceFt);
                        afterTopology = SnapshotTopology(doc, pairElementIds);
                        afterConnectorTopology = SnapshotConnectorTopology(doc, pairElementIds);
                        if (afterPairs.Any(pair => (bool)pair.GetType().GetProperty("connected")!.GetValue(pair)!))
                            throw new InvalidOperationException("disconnect_only_pair_still_connected");
                        if (p.verify && (!expectedAfterTopology.SequenceEqual(afterTopology) ||
                            !expectedAfterConnectorTopology.SequenceEqual(afterConnectorTopology)))
                            throw new InvalidOperationException("disconnect_only_changed_unexpected_physical_topology");
                        var txStatus = tx.Commit();
                        if (txStatus != TransactionStatus.Committed)
                            throw new InvalidOperationException(
                                $"disconnect_only_transaction_not_committed:{txStatus}");
                    }

                    if (shouldApply)
                    {
                        var groupStatus = group.Assimilate();
                        if (groupStatus != TransactionStatus.Committed)
                            throw new InvalidOperationException(
                                $"disconnect_only_transaction_group_not_committed:{groupStatus}");
                    }
                    else
                    {
                        group.RollBack();
                        transactionGroupRolledBack = true;
                    }
                }
                catch (Exception ex)
                {
                    try
                    {
                        if (group.GetStatus() == TransactionStatus.Started)
                        {
                            group.RollBack();
                            transactionGroupRolledBack = true;
                        }
                    }
                    catch { }
                    var rollbackPairs = SafeSnapshotPairs(doc, p.disconnectOnlyPairs, p.originToleranceFt);
                    var rollbackTopology = SnapshotTopology(doc, pairElementIds);
                    var rollbackConnectorTopology = SnapshotConnectorTopology(doc, pairElementIds);
                    return new
                    {
                        status = "Blocked",
                        dryRun = !shouldApply,
                        blockCode = "disconnect_only_failed",
                        reason = ex.Message,
                        transactionGroupRolledBack,
                        rollbackVerified = beforeTopology.SequenceEqual(rollbackTopology) &&
                            beforeConnectorTopology.SequenceEqual(rollbackConnectorTopology) &&
                            rollbackPairs.All(pair =>
                                (bool)pair.GetType().GetProperty("connected")!.GetValue(pair)!),
                        beforePairs,
                        rollbackPairs,
                        beforeTopology,
                        rollbackTopology,
                        beforeConnectorTopology,
                        rollbackConnectorTopology,
                        expectedRemovedEdges,
                        expectedRemovedConnectorEdges,
                        nativeFailures,
                        auditedElementIds = pairElementIds
                    };
                }
            }

            var finalPairs = SafeSnapshotPairs(doc, p.disconnectOnlyPairs, p.originToleranceFt);
            var finalTopology = SnapshotTopology(doc, pairElementIds);
            var finalConnectorTopology = SnapshotConnectorTopology(doc, pairElementIds);
            var rollbackVerified = shouldApply || (
                beforeTopology.SequenceEqual(finalTopology) &&
                beforeConnectorTopology.SequenceEqual(finalConnectorTopology) &&
                finalPairs.All(pair =>
                    (bool)pair.GetType().GetProperty("connected")!.GetValue(pair)!));
            return new
            {
                status = shouldApply ? "Disconnected" : "DryRunReady",
                dryRun = !shouldApply,
                transactionGroupRolledBack,
                rollbackVerified,
                beforePairs,
                afterPairs,
                finalPairs,
                beforeTopology,
                expectedAfterTopology,
                afterTopology,
                finalTopology,
                beforeConnectorTopology,
                expectedAfterConnectorTopology,
                afterConnectorTopology,
                finalConnectorTopology,
                topologyExactMatch = expectedAfterTopology.SequenceEqual(afterTopology),
                connectorTopologyExactMatch =
                    expectedAfterConnectorTopology.SequenceEqual(afterConnectorTopology),
                nativeFailures,
                auditedElementIds = pairElementIds,
                nextAction = shouldApply
                    ? "Move only the now-independent retained subgraphs, then reconnect with exact open-pair operations."
                    : "Apply only these exact disconnect boundaries if the dry-run pair and rollback audits are accepted."
            };
        }

        private static object HandleStandaloneRepair(Document doc, Params p, bool shouldApply)
        {
            var operationKind = NormalizeOperationKind(p.repair?.kind);
            var repairElementIds = ResolveRepairElementIds(doc, p.repair, operationKind);
            if (repairElementIds.Count > 100)
                throw new ArgumentException("Standalone repair scope exceeds the maximum of 100 elements.");

            var before = SnapshotRepairElements(doc, repairElementIds);
            var beforeFingerprint = SnapshotRepairFingerprint(doc, repairElementIds);
            var beforeTopology = SnapshotTopology(doc, repairElementIds);
            var beforeConnectorTopology = SnapshotConnectorTopology(doc, repairElementIds);
            if (!p.allowConnectedRepair && beforeTopology.Count > 0)
            {
                return new
                {
                    status = "Blocked",
                    dryRun = !shouldApply,
                    blockCode = "standalone_repair_requires_open_elements",
                    reason = "Standalone geometry repair is limited to physically open elements unless allowConnectedRepair:true is explicit.",
                    operationKind,
                    repairElementIds,
                    before,
                    beforeTopology
                };
            }

            var nativeFailures = new List<CapturedFailure>();
            var transactionGroupRolledBack = false;
            List<object> after;
            List<string> afterTopology;
            List<string> afterConnectorTopology;
            using (var group = new TransactionGroup(doc, shouldApply
                ? "Repair Open MEP Geometry"
                : "Dry Run Open MEP Geometry Repair"))
            {
                group.Start();
                try
                {
                    using (var tx = new Transaction(doc, shouldApply
                        ? "Repair Open MEP Geometry"
                        : "Dry Run Open MEP Geometry Repair"))
                    {
                        tx.Start();
                        tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(
                            tx,
                            nativeFailures,
                            rollbackOnErrors: true,
                            deleteWarnings: false));
                        ApplyRepair(doc, p.repair, operationKind, repairElementIds);
                        doc.Regenerate();
                        after = SnapshotRepairElements(doc, repairElementIds);
                        afterTopology = SnapshotTopology(doc, repairElementIds);
                        afterConnectorTopology = SnapshotConnectorTopology(doc, repairElementIds);
                        if (p.verify && (!beforeTopology.SequenceEqual(afterTopology) ||
                            !beforeConnectorTopology.SequenceEqual(afterConnectorTopology)))
                            throw new InvalidOperationException("standalone_repair_changed_physical_topology");
                        var txStatus = tx.Commit();
                        if (txStatus != TransactionStatus.Committed)
                            throw new InvalidOperationException($"standalone_repair_transaction_not_committed:{txStatus}");
                    }

                    if (shouldApply)
                    {
                        var groupStatus = group.Assimilate();
                        if (groupStatus != TransactionStatus.Committed)
                            throw new InvalidOperationException($"standalone_repair_transaction_group_not_committed:{groupStatus}");
                    }
                    else
                    {
                        group.RollBack();
                        transactionGroupRolledBack = true;
                    }
                }
                catch (Exception ex)
                {
                    try
                    {
                        if (group.GetStatus() == TransactionStatus.Started)
                        {
                            group.RollBack();
                            transactionGroupRolledBack = true;
                        }
                    }
                    catch { }
                    var rollback = SnapshotRepairElements(doc, repairElementIds);
                    var rollbackTopology = SnapshotTopology(doc, repairElementIds);
                    var rollbackConnectorTopology = SnapshotConnectorTopology(doc, repairElementIds);
                    return new
                    {
                        status = "Blocked",
                        dryRun = !shouldApply,
                        blockCode = "standalone_repair_failed",
                        reason = ex.Message,
                        operationKind,
                        repairElementIds,
                        before,
                        rollback,
                        beforeTopology,
                        rollbackTopology,
                        beforeConnectorTopology,
                        rollbackConnectorTopology,
                        nativeFailures,
                        transactionGroupRolledBack,
                        rollbackVerified = beforeFingerprint.SequenceEqual(SnapshotRepairFingerprint(doc, repairElementIds)) &&
                            beforeTopology.SequenceEqual(rollbackTopology) &&
                            beforeConnectorTopology.SequenceEqual(rollbackConnectorTopology)
                    };
                }
            }

            var final = shouldApply ? SnapshotRepairElements(doc, repairElementIds) : SnapshotRepairElements(doc, repairElementIds);
            var finalTopology = SnapshotTopology(doc, repairElementIds);
            var finalConnectorTopology = SnapshotConnectorTopology(doc, repairElementIds);
            return new
            {
                status = shouldApply ? "Repaired" : "DryRunReady",
                dryRun = !shouldApply,
                operationKind,
                repairElementIds,
                before,
                after,
                final,
                beforeTopology,
                afterTopology,
                finalTopology,
                beforeConnectorTopology,
                afterConnectorTopology,
                finalConnectorTopology,
                nativeFailures,
                transactionGroupRolledBack,
                rollbackVerified = shouldApply || (
                    beforeFingerprint.SequenceEqual(SnapshotRepairFingerprint(doc, repairElementIds)) &&
                    beforeTopology.SequenceEqual(finalTopology) &&
                    beforeConnectorTopology.SequenceEqual(finalConnectorTopology)),
                nextAction = shouldApply
                    ? "Read back exact connectors and continue with the next fitting."
                    : "Apply this exact open-element geometry repair only if the before/after curve and connector plan is accepted."
            };
        }

        private static object HandleOpenConnectorConnection(Document doc, Params p, bool shouldApply)
        {
            if (p.connectOpenPair == null)
                throw new ArgumentException("connectOpenPair is required.");
            if (p.originToleranceFt <= 0 || p.originToleranceFt > 0.05)
                throw new ArgumentException("originToleranceFt must be greater than zero and no more than 0.05.");
            if (p.connectionMaxDistanceFt <= 0 || p.connectionMaxDistanceFt > 10.0)
                throw new ArgumentException("connectionMaxDistanceFt must be greater than zero and no more than 10.");

            var first = ResolveConnector(doc, p.connectOpenPair.first, p.originToleranceFt, false);
            var second = ResolveConnector(doc, p.connectOpenPair.second, p.originToleranceFt, false);
            // A transition is specifically the supported case where connector
            // profiles may differ (for example, round-to-rectangular). Keep the
            // domain guard here and let the resolved connection-kind preflight
            // below reject incompatible direct/elbow plans.
            AssertCompatible(first.Connector, second.Connector, "connect", allowDifferentShapes: true);

            var before = BuildOpenConnectionSnapshot(first, second);
            var alreadyConnected = AreDirectlyConnected(first.Connector, second.Connector);
            if (alreadyConnected)
            {
                return new
                {
                    status = "AlreadyConnected",
                    dryRun = !shouldApply,
                    connectionKind = "direct",
                    before,
                    after = before,
                    verified = true,
                    nextAction = "Read back the retained connector pair and continue with the next smallest repair."
                };
            }

            var firstPhysicalOwners = PhysicalConnectedOwnerIds(first.Connector);
            var secondPhysicalOwners = PhysicalConnectedOwnerIds(second.Connector);
            if (firstPhysicalOwners.Count > 0 || secondPhysicalOwners.Count > 0)
            {
                return new
                {
                    status = "Blocked",
                    dryRun = !shouldApply,
                    blockCode = "connector_not_physically_open",
                    before,
                    firstPhysicalOwners,
                    secondPhysicalOwners
                };
            }

            var distanceFt = first.Connector.Origin.DistanceTo(second.Connector.Origin);
            if (distanceFt > p.connectionMaxDistanceFt)
            {
                return new
                {
                    status = "Blocked",
                    dryRun = !shouldApply,
                    blockCode = "connector_distance_exceeds_limit",
                    distanceFt,
                    connectionMaxDistanceFt = p.connectionMaxDistanceFt,
                    before
                };
            }

            var sameSize = ConnectorSizesMatch(first.Connector, second.Connector);
            var axisDot = ConnectorAxisDot(first.Connector, second.Connector);
            var connectionKind = ResolveOpenConnectionKind(p.connectionKind, sameSize, distanceFt, axisDot);
            var preflightError = ValidateOpenConnectionPlan(connectionKind, sameSize, distanceFt, axisDot);
            if (preflightError != null)
            {
                return new
                {
                    status = "Blocked",
                    dryRun = !shouldApply,
                    blockCode = preflightError,
                    connectionKind,
                    sameSize,
                    distanceFt,
                    axisDot,
                    before
                };
            }

            Workset? requestedWorkset;
            try
            {
                requestedWorkset = ResolveFittingWorkset(doc, p.fittingWorksetId, p.fittingWorksetName);
            }
            catch (Exception ex)
            {
                return new
                {
                    status = "Blocked",
                    dryRun = !shouldApply,
                    blockCode = "fitting_workset_resolution_failed",
                    reason = ex.Message,
                    connectionKind,
                    before
                };
            }

            var plan = new
            {
                connectionKind,
                firstElementId = ElementIdCompat.GetValue(first.Owner.Id),
                firstConnectorId = first.ConnectorId,
                secondElementId = ElementIdCompat.GetValue(second.Owner.Id),
                secondConnectorId = second.ConnectorId,
                distanceFt,
                sameSize,
                axisDot,
                elbowTurnAngleDegrees = connectionKind == "elbow"
                    ? (double?)ComputeElbowTurnAngleDegrees(axisDot)
                    : null,
                fittingWorkset = requestedWorkset == null ? null : new
                {
                    id = requestedWorkset.Id.IntegerValue,
                    name = requestedWorkset.Name
                }
            };

            var nativeFailures = new List<CapturedFailure>();
            long? fittingId = null;
            object? fittingWorkset = null;
            using (var tx = new Transaction(
                doc,
                shouldApply
                    ? $"Connect Open MEP Pair ({connectionKind})"
                    : $"Connect Open MEP Pair Dry Run ({connectionKind})"))
            {
                tx.Start();
                tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(
                    tx,
                    nativeFailures,
                    rollbackOnErrors: true,
                    deleteWarnings: false));
                try
                {
                    Element? fitting = null;
                    if (connectionKind == "transition")
                        fitting = doc.Create.NewTransitionFitting(first.Connector, second.Connector);
                    else if (connectionKind == "elbow")
                        fitting = doc.Create.NewElbowFitting(first.Connector, second.Connector);
                    else
                        first.Connector.ConnectTo(second.Connector);

                    if (connectionKind != "direct" && fitting == null)
                        throw new InvalidOperationException($"Revit did not create the required {connectionKind} fitting.");

                    if (fitting != null)
                    {
                        fittingId = ElementIdCompat.GetValue(fitting.Id);
                        if (requestedWorkset != null)
                            fittingWorkset = ApplyAndVerifyFittingWorkset(fitting, requestedWorkset, p.verify);
                    }

                    doc.Regenerate();
                    if (p.verify)
                    {
                        var connected = connectionKind == "direct"
                            ? AreDirectlyConnected(first.Connector, second.Connector)
                            : fitting != null && FittingConnectsOwners(
                                fitting,
                                ElementIdCompat.GetValue(first.Owner.Id),
                                ElementIdCompat.GetValue(second.Owner.Id));
                        if (!connected)
                            throw new InvalidOperationException("open_connector_connection_native_audit_failed");
                    }

                    if (shouldApply)
                    {
                        var txStatus = tx.Commit();
                        if (txStatus != TransactionStatus.Committed)
                            throw new InvalidOperationException($"open_connector_connection_transaction_not_committed:{txStatus}");
                    }
                    else
                    {
                        tx.RollBack();
                    }
                }
                catch (Exception ex)
                {
                    try
                    {
                        if (tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                    }
                    catch { }
                    return new
                    {
                        status = "Blocked",
                        dryRun = !shouldApply,
                        blockCode = "open_connector_connection_failed",
                        reason = ex.Message,
                        plan,
                        fittingId,
                        nativeFailures,
                        rolledBack = !shouldApply,
                        rollbackVerified = SafeOpenPairUnconnected(doc, p.connectOpenPair, p.originToleranceFt)
                    };
                }
            }

            if (!shouldApply)
            {
                var rollbackVerified = SafeOpenPairUnconnected(doc, p.connectOpenPair, p.originToleranceFt);
                return new
                {
                    status = rollbackVerified ? "DryRunPassed" : "Blocked",
                    dryRun = true,
                    mutationAttempted = true,
                    before,
                    plan,
                    transientFittingId = fittingId,
                    fittingWorkset,
                    nativeFailures,
                    rolledBack = true,
                    rollbackVerified,
                    nextAction = rollbackVerified
                        ? "Apply this exact open-connector connection only if the native dry run, connector identities, fitting kind, workset, and rollback proof are accepted."
                        : "Preserve the pre-action checkpoint and repair only this failed connection dry-run stage."
                };
            }

            var finalFirst = ResolveConnectorAfterFitting(doc, p.connectOpenPair.first, p.originToleranceFt);
            var finalSecond = ResolveConnectorAfterFitting(doc, p.connectOpenPair.second, p.originToleranceFt);
            var after = BuildOpenConnectionSnapshot(finalFirst, finalSecond);
            var verified = connectionKind == "direct"
                ? AreDirectlyConnected(finalFirst.Connector, finalSecond.Connector)
                : fittingId.HasValue &&
                    PhysicalConnectedOwnerIds(finalFirst.Connector).Contains(fittingId.Value) &&
                    PhysicalConnectedOwnerIds(finalSecond.Connector).Contains(fittingId.Value);
            return new
            {
                status = verified ? "Connected" : "Blocked",
                dryRun = false,
                before,
                plan,
                after,
                fittingId,
                fittingWorkset,
                nativeFailures,
                verified,
                nextAction = verified
                    ? "Save the accepted checkpoint, read back the connected element graph, and capture focused visual evidence."
                    : "Preserve the pre-action checkpoint and repair only this failed connection stage."
            };
        }

        private static object BuildOpenConnectionSnapshot(ResolvedConnector first, ResolvedConnector second)
        {
            return new
            {
                distanceFt = first.Connector.Origin.DistanceTo(second.Connector.Origin),
                axisDot = ConnectorAxisDot(first.Connector, second.Connector),
                sameSize = ConnectorSizesMatch(first.Connector, second.Connector),
                first = ConnectorSnapshotWithGeometry(first),
                second = ConnectorSnapshotWithGeometry(second)
            };
        }

        private static object ConnectorSnapshotWithGeometry(ResolvedConnector resolved)
        {
            var connector = resolved.Connector;
            var axis = SafeConnectorAxis(connector);
            return new
            {
                elementId = ElementIdCompat.GetValue(resolved.Owner.Id),
                connectorId = resolved.ConnectorId,
                connectorIdBasis = resolved.ConnectorIdBasis,
                origin = new[] { connector.Origin.X, connector.Origin.Y, connector.Origin.Z },
                direction = new[] { axis.X, axis.Y, axis.Z },
                domain = SafeText(() => connector.Domain.ToString()),
                shape = SafeText(() => connector.Shape.ToString()),
                size = ConnectorSizeSnapshot(connector),
                physicalConnectedOwnerIds = PhysicalConnectedOwnerIds(connector)
            };
        }

        private static object ConnectorSizeSnapshot(Connector connector)
        {
            try
            {
                if (connector.Shape == ConnectorProfileType.Round)
                    return new { kind = "round", diameterFt = connector.Radius * 2.0, widthFt = (double?)null, heightFt = (double?)null };
                return new
                {
                    kind = connector.Shape.ToString().ToLowerInvariant(),
                    diameterFt = (double?)null,
                    widthFt = (double?)connector.Width,
                    heightFt = (double?)connector.Height
                };
            }
            catch
            {
                return new { kind = "unknown", diameterFt = (double?)null, widthFt = (double?)null, heightFt = (double?)null };
            }
        }

        private static string ResolveOpenConnectionKind(string? requested, bool sameSize, double distanceFt, double axisDot)
        {
            var normalized = (requested ?? "auto").Trim().ToLowerInvariant().Replace("-", "_");
            if (normalized == "auto")
            {
                if (!sameSize) return "transition";
                if (Math.Abs(axisDot) <= 0.25) return "elbow";
                if (axisDot <= -0.5 && distanceFt <= 0.02) return "direct";
                return "unsupported";
            }
            if (normalized == "direct" || normalized == "elbow" || normalized == "transition")
                return normalized;
            return "unsupported";
        }

        private static string? ValidateOpenConnectionPlan(string connectionKind, bool sameSize, double distanceFt, double axisDot)
        {
            if (connectionKind == "unsupported") return "unsupported_connection_geometry";
            if (connectionKind == "transition")
            {
                if (distanceFt <= 1e-4) return "transition_requires_positive_connector_gap";
                if (axisDot > -0.5) return "transition_requires_opposing_connector_directions";
                return null;
            }
            if (!sameSize) return $"{connectionKind}_requires_matching_sizes";
            if (connectionKind == "elbow")
            {
                // Native elbow connectors are commonly trimmed back from the
                // theoretical centerline intersection. Permit a tightly bounded
                // positive gap so Revit can recreate the real source fitting
                // instead of requiring coincident connector origins.
                // A 90-degree rectangular elbow can legitimately trim each
                // connected duct back by 0.75 ft, producing a diagonal
                // connector gap of sqrt(0.75^2 + 0.75^2) ~= 1.061 ft. Keep a
                // narrow absolute guard while allowing that native case; the
                // caller-provided connectionMaxDistanceFt is checked first.
                if (distanceFt > 1.5) return "elbow_connector_gap_exceeds_native_safety_limit";
                // Revit evaluates the turn between one connector's inward
                // direction and the other connector's outward direction. The
                // native API documents a typical valid elbow range of 2 to 95
                // degrees, so permit 45-degree and other native-valid elbows
                // while still rejecting near-straight and over-bent pairs.
                var turnAngleDegrees = ComputeElbowTurnAngleDegrees(axisDot);
                if (turnAngleDegrees < 2.0) return "elbow_angle_below_native_safety_limit";
                if (turnAngleDegrees > 95.0) return "elbow_angle_above_native_safety_limit";
                return null;
            }
            if (distanceFt > 0.02) return "direct_connection_gap_exceeds_limit";
            if (axisDot > -0.5) return "direct_connection_requires_opposing_connector_directions";
            return null;
        }

        private static XYZ SafeConnectorAxis(Connector connector)
        {
            try { return connector.CoordinateSystem.BasisZ.Normalize(); }
            catch { return XYZ.Zero; }
        }

        private static double ConnectorAxisDot(Connector first, Connector second)
        {
            var firstAxis = SafeConnectorAxis(first);
            var secondAxis = SafeConnectorAxis(second);
            return firstAxis.DotProduct(secondAxis);
        }

        private static double ComputeElbowTurnAngleDegrees(double axisDot)
        {
            var inwardToOutwardDot = Math.Max(-1.0, Math.Min(1.0, -axisDot));
            return Math.Acos(inwardToOutwardDot) * 180.0 / Math.PI;
        }

        private static bool ConnectorSizesMatch(Connector first, Connector second)
        {
            const double toleranceFt = 1.0 / 192.0;
            try
            {
                if (first.Shape != second.Shape) return false;
                if (first.Shape == ConnectorProfileType.Round)
                    return Math.Abs(first.Radius - second.Radius) <= toleranceFt;
                var direct =
                    Math.Abs(first.Width - second.Width) <= toleranceFt &&
                    Math.Abs(first.Height - second.Height) <= toleranceFt;
                var rotated =
                    Math.Abs(first.Width - second.Height) <= toleranceFt &&
                    Math.Abs(first.Height - second.Width) <= toleranceFt;
                return direct || rotated;
            }
            catch
            {
                return false;
            }
        }

        private static Workset? ResolveFittingWorkset(Document doc, long? requestedId, string? requestedName)
        {
            var userWorksets = new FilteredWorksetCollector(doc)
                .OfKind(WorksetKind.UserWorkset)
                .ToWorksets()
                .ToList();
            if (requestedId.HasValue)
            {
                var byId = userWorksets.FirstOrDefault(workset => workset.Id.IntegerValue == requestedId.Value);
                if (byId == null) throw new InvalidOperationException($"Requested fitting workset id {requestedId.Value} was not found.");
                if (!string.IsNullOrWhiteSpace(requestedName) &&
                    !string.Equals(byId.Name, requestedName.Trim(), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"Requested fitting workset id/name mismatch: {requestedId.Value} is '{byId.Name}', not '{requestedName.Trim()}'.");
                return byId;
            }
            if (string.IsNullOrWhiteSpace(requestedName)) return null;
            var matches = userWorksets
                .Where(workset => string.Equals(workset.Name, requestedName.Trim(), StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (matches.Count != 1)
                throw new InvalidOperationException($"Requested fitting workset '{requestedName.Trim()}' matched {matches.Count} user worksets.");
            return matches[0];
        }

        private static object ApplyAndVerifyFittingWorkset(Element fitting, Workset requestedWorkset, bool verify)
        {
            var parameter = fitting.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM)
                ?? throw new InvalidOperationException($"Fitting {ElementIdCompat.GetValue(fitting.Id)} does not expose ELEM_PARTITION_PARAM.");
            if (parameter.IsReadOnly)
                throw new InvalidOperationException($"Fitting {ElementIdCompat.GetValue(fitting.Id)} workset is read-only.");
            if (!parameter.Set(requestedWorkset.Id.IntegerValue))
                throw new InvalidOperationException($"Could not assign fitting {ElementIdCompat.GetValue(fitting.Id)} to workset '{requestedWorkset.Name}'.");
            var readbackId = parameter.AsInteger();
            if (verify && readbackId != requestedWorkset.Id.IntegerValue)
                throw new InvalidOperationException($"Fitting {ElementIdCompat.GetValue(fitting.Id)} workset readback mismatch.");
            return new
            {
                elementId = ElementIdCompat.GetValue(fitting.Id),
                requestedWorksetId = requestedWorkset.Id.IntegerValue,
                requestedWorksetName = requestedWorkset.Name,
                readbackWorksetId = readbackId,
                verified = readbackId == requestedWorkset.Id.IntegerValue
            };
        }

        private static bool SafeOpenPairUnconnected(Document doc, ConnectorPair pair, double originToleranceFt)
        {
            try
            {
                var first = ResolveConnector(doc, pair.first, originToleranceFt, false);
                var second = ResolveConnector(doc, pair.second, originToleranceFt, false);
                return !AreDirectlyConnected(first.Connector, second.Connector) &&
                    PhysicalConnectedOwnerIds(first.Connector).Count == 0 &&
                    PhysicalConnectedOwnerIds(second.Connector).Count == 0;
            }
            catch
            {
                return false;
            }
        }

        private static bool FittingConnectsOwners(Element fitting, long firstOwnerId, long secondOwnerId)
        {
            var connectedOwnerIds = new HashSet<long>();
            foreach (var connector in MepSystemUtil.GetConnectors(fitting))
            {
                foreach (var ownerId in PhysicalConnectedOwnerIds(connector))
                    connectedOwnerIds.Add(ownerId);
            }
            return connectedOwnerIds.Contains(firstOwnerId) && connectedOwnerIds.Contains(secondOwnerId);
        }

        private static ResolvedConnector ResolveConnectorAfterFitting(
            Document doc,
            ConnectorReference reference,
            double originToleranceFt)
        {
            var owner = doc.GetElement(ElementIdCompat.Create(reference.elementId))
                ?? throw new InvalidOperationException($"connector_owner_not_found:{reference.elementId}");
            var connectors = MepSystemUtil.GetConnectors(owner).Where(connector => connector != null).ToList();
            foreach (var connector in connectors)
            {
                if (MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId) &&
                    nativeId == reference.connectorId)
                {
                    return new ResolvedConnector
                    {
                        Owner = owner,
                        Connector = connector,
                        ConnectorId = nativeId,
                        ConnectorIdBasis = "revit_native_connector_id",
                        Origin = connector.Origin
                    };
                }
            }

            if (reference.afterOriginXyz == null)
                throw new InvalidOperationException(
                    $"post_fitting_connector_without_native_id_requires_after_origin_guard:{reference.elementId}:{reference.connectorId}");
            return ResolveConnector(doc, reference, originToleranceFt, true);
        }

        private static string NormalizeOperationKind(string? value)
        {
            var normalized = (value ?? string.Empty).Trim().ToLowerInvariant().Replace("-", "_");
            if (normalized == "move_elements_vector" ||
                normalized == "set_curve_line" ||
                normalized == "set_flex_curve")
                return normalized;
            throw new ArgumentException("repair.kind must be move_elements_vector, set_curve_line, or set_flex_curve.");
        }

        private static List<long> ResolveRepairElementIds(Document doc, RepairOperation repair, string operationKind)
        {
            if (repair == null) throw new ArgumentException("repair is required.");
            var ids = operationKind == "move_elements_vector"
                ? (repair.elementIds ?? new List<long>()).Where(id => id > 0).Distinct().ToList()
                : new List<long> { repair.elementId };
            if (ids.Count == 0 || ids.Any(id => id <= 0))
                throw new ArgumentException("repair must identify at least one positive element id.");
            foreach (var id in ids)
            {
                if (doc.GetElement(ElementIdCompat.Create(id)) == null)
                    throw new ArgumentException($"repair_element_not_found:{id}");
            }
            if (operationKind == "move_elements_vector" &&
                (!IsFinite(repair.vectorX) || !IsFinite(repair.vectorY) || !IsFinite(repair.vectorZ)))
                throw new ArgumentException("repair vector components must be finite.");
            if (operationKind == "set_curve_line")
            {
                ParseXyz(repair.startXyz, "repair_start");
                ParseXyz(repair.endXyz, "repair_end");
            }
            if (operationKind == "set_flex_curve")
            {
                var element = doc.GetElement(ElementIdCompat.Create(repair.elementId));
                if (!(element is Autodesk.Revit.DB.Mechanical.FlexDuct) &&
                    !(element is Autodesk.Revit.DB.Plumbing.FlexPipe))
                    throw new ArgumentException($"repair_element_is_not_flex_mep:{repair.elementId}");
                ValidateFlexPoints(repair.flexPoints);
                if (repair.startTangent != null) ParseNonZeroVector(repair.startTangent, "repair_start_tangent");
                if (repair.endTangent != null) ParseNonZeroVector(repair.endTangent, "repair_end_tangent");
            }
            return ids;
        }

        private static void ApplyRepair(
            Document doc,
            RepairOperation repair,
            string operationKind,
            List<long> repairElementIds)
        {
            if (operationKind == "move_elements_vector")
            {
                var ids = repairElementIds.Select(ElementIdCompat.Create).ToList();
                ElementTransformUtils.MoveElements(doc, ids, new XYZ(repair.vectorX, repair.vectorY, repair.vectorZ));
                return;
            }
            var element = doc.GetElement(ElementIdCompat.Create(repair.elementId))
                ?? throw new InvalidOperationException($"repair_element_not_found:{repair.elementId}");
            if (operationKind == "set_flex_curve")
            {
                var points = repair.flexPoints
                    .Select((point, index) => ParseXyz(point, $"repair_flex_point_{index}"))
                    .ToList();
                if (element is Autodesk.Revit.DB.Mechanical.FlexDuct flexDuct)
                {
                    flexDuct.Points = points;
                    if (repair.startTangent != null)
                        flexDuct.StartTangent = ParseNonZeroVector(repair.startTangent, "repair_start_tangent");
                    if (repair.endTangent != null)
                        flexDuct.EndTangent = ParseNonZeroVector(repair.endTangent, "repair_end_tangent");
                    return;
                }
                if (element is Autodesk.Revit.DB.Plumbing.FlexPipe flexPipe)
                {
                    flexPipe.Points = points;
                    if (repair.startTangent != null)
                        flexPipe.StartTangent = ParseNonZeroVector(repair.startTangent, "repair_start_tangent");
                    if (repair.endTangent != null)
                        flexPipe.EndTangent = ParseNonZeroVector(repair.endTangent, "repair_end_tangent");
                    return;
                }
                throw new InvalidOperationException($"repair_element_is_not_flex_mep:{repair.elementId}");
            }
            if (!(element.Location is LocationCurve locationCurve))
                throw new InvalidOperationException($"repair_element_has_no_location_curve:{repair.elementId}");
            var start = ParseXyz(repair.startXyz, "repair_start");
            var end = ParseXyz(repair.endXyz, "repair_end");
            if (start.DistanceTo(end) <= 1e-6)
                throw new InvalidOperationException("repair_curve_line_is_degenerate");
            locationCurve.Curve = Line.CreateBound(start, end);
        }

        private static ResolvedConnector ResolveConnector(
            Document doc,
            ConnectorReference reference,
            double originTolerance,
            bool useAfterOrigin)
        {
            if (reference == null || reference.elementId <= 0)
                throw new ArgumentException("connector reference elementId must be positive.");
            var owner = doc.GetElement(ElementIdCompat.Create(reference.elementId))
                ?? throw new InvalidOperationException($"connector_owner_not_found:{reference.elementId}");
            var connectors = MepSystemUtil.GetConnectors(owner).Where(connector => connector != null).ToList();
            if (connectors.Count == 0)
                throw new InvalidOperationException($"connector_owner_has_no_connectors:{reference.elementId}");

            foreach (var connector in connectors)
            {
                if (MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId) &&
                    nativeId == reference.connectorId)
                {
                    ValidateOriginGuardIfProvided(connector.Origin, useAfterOrigin ? reference.afterOriginXyz : reference.expectedOriginXyz, originTolerance, reference);
                    return new ResolvedConnector
                    {
                        Owner = owner,
                        Connector = connector,
                        ConnectorId = nativeId,
                        ConnectorIdBasis = "revit_native_connector_id",
                        Origin = connector.Origin
                    };
                }
            }

            if (reference.connectorId < 0 || reference.connectorId >= connectors.Count)
                throw new InvalidOperationException(
                    $"connector_id_not_found:{reference.elementId}:{reference.connectorId}");
            var expected = useAfterOrigin ? reference.afterOriginXyz : reference.expectedOriginXyz;
            if (expected == null)
                throw new InvalidOperationException(
                    $"connector_index_requires_origin_guard:{reference.elementId}:{reference.connectorId}");
            var indexed = connectors[(int)reference.connectorId];
            var expectedPoint = ParseXyz(expected, "connector_expected_origin");
            var distance = indexed.Origin.DistanceTo(expectedPoint);
            if (distance > originTolerance)
                throw new InvalidOperationException(
                    $"connector_origin_guard_failed:{reference.elementId}:{reference.connectorId}:{distance:0.########}");
            return new ResolvedConnector
            {
                Owner = owner,
                Connector = indexed,
                ConnectorId = reference.connectorId,
                ConnectorIdBasis = "enumeration_index_with_origin_guard",
                Origin = indexed.Origin
            };
        }

        private static ResolvedConnector ResolveConnectorAfterRepair(
            Document doc,
            ConnectorReference reference,
            double originTolerance,
            RepairOperation repair,
            string operationKind,
            List<long> repairElementIds)
        {
            if (reference.afterOriginXyz != null)
                return ResolveConnector(doc, reference, originTolerance, true);
            if (operationKind == "move_elements_vector" && repairElementIds.Contains(reference.elementId))
            {
                if (reference.expectedOriginXyz == null)
                    return ResolveConnector(doc, reference, originTolerance, false);
                var before = ParseXyz(reference.expectedOriginXyz, "connector_expected_origin");
                var adjusted = new ConnectorReference
                {
                    elementId = reference.elementId,
                    connectorId = reference.connectorId,
                    afterOriginXyz = new[]
                    {
                        before.X + repair.vectorX,
                        before.Y + repair.vectorY,
                        before.Z + repair.vectorZ
                    }
                };
                return ResolveConnector(doc, adjusted, originTolerance, true);
            }
            return ResolveConnector(doc, reference, originTolerance, false);
        }

        private static object SnapshotPair(
            Document doc,
            ConnectorPair pair,
            int pairIndex,
            double originTolerance,
            bool useAfterOrigin)
        {
            var a = ResolveConnector(doc, pair.first, originTolerance, useAfterOrigin);
            var b = ResolveConnector(doc, pair.second, originTolerance, useAfterOrigin);
            return BuildPairSnapshot(pairIndex, a, b);
        }

        private static object SnapshotPairAfterRepair(
            Document doc,
            ConnectorPair pair,
            int pairIndex,
            double originTolerance,
            RepairOperation repair,
            string operationKind,
            List<long> repairElementIds)
        {
            var a = ResolveConnectorAfterRepair(doc, pair.first, originTolerance, repair, operationKind, repairElementIds);
            var b = ResolveConnectorAfterRepair(doc, pair.second, originTolerance, repair, operationKind, repairElementIds);
            return BuildPairSnapshot(pairIndex, a, b);
        }

        private static object BuildPairSnapshot(int pairIndex, ResolvedConnector a, ResolvedConnector b)
        {
            return new
            {
                pairIndex,
                connected = AreDirectlyConnected(a.Connector, b.Connector),
                distanceFt = a.Connector.Origin.DistanceTo(b.Connector.Origin),
                a = ConnectorSnapshot(a),
                b = ConnectorSnapshot(b)
            };
        }

        private static object ConnectorSnapshot(ResolvedConnector resolved)
        {
            var connector = resolved.Connector;
            return new
            {
                elementId = ElementIdCompat.GetValue(resolved.Owner.Id),
                connectorId = resolved.ConnectorId,
                connectorIdBasis = resolved.ConnectorIdBasis,
                origin = new[] { connector.Origin.X, connector.Origin.Y, connector.Origin.Z },
                domain = SafeText(() => connector.Domain.ToString()),
                shape = SafeText(() => connector.Shape.ToString()),
                systemClassification = ConnectorSystemClassification(connector),
                systemName = SafeText(() => connector.MEPSystem?.Name ?? string.Empty),
                physicalConnectedOwnerIds = PhysicalConnectedOwnerIds(connector)
            };
        }

        private static List<object> SafeSnapshotPairs(
            Document doc,
            List<ConnectorPair> pairs,
            double originTolerance)
        {
            var result = new List<object>();
            for (var index = 0; index < pairs.Count; index++)
            {
                try
                {
                    result.Add(SnapshotPair(doc, pairs[index], index, originTolerance, false));
                }
                catch (Exception ex)
                {
                    result.Add(new { pairIndex = index, connected = false, error = ex.Message });
                }
            }
            return result;
        }

        private static List<string> SnapshotTopology(Document doc, List<long> elementIds)
        {
            var edges = new HashSet<string>(StringComparer.Ordinal);
            foreach (var elementId in elementIds)
            {
                var element = doc.GetElement(ElementIdCompat.Create(elementId));
                if (element == null) continue;
                foreach (var connector in MepSystemUtil.GetConnectors(element))
                {
                    foreach (var ownerId in PhysicalConnectedOwnerIds(connector))
                    {
                        var low = Math.Min(elementId, ownerId);
                        var high = Math.Max(elementId, ownerId);
                        edges.Add($"{low}:{high}");
                    }
                }
            }
            return edges.OrderBy(edge => edge, StringComparer.Ordinal).ToList();
        }

        private static List<string> SnapshotConnectorTopology(Document doc, List<long> elementIds)
        {
            var edges = new HashSet<string>(StringComparer.Ordinal);
            foreach (var elementId in elementIds)
            {
                var element = doc.GetElement(ElementIdCompat.Create(elementId));
                if (element == null) continue;
                foreach (var connector in MepSystemUtil.GetConnectors(element))
                {
                    if (connector == null) continue;
                    try
                    {
                        foreach (Connector reference in connector.AllRefs)
                        {
                            var owner = reference?.Owner;
                            if (owner == null || owner is MEPSystem || owner.Id == connector.Owner?.Id) continue;
                            var first = ConnectorEndpointIdentity(elementId, connector);
                            var second = ConnectorEndpointIdentity(
                                ElementIdCompat.GetValue(owner.Id),
                                reference);
                            edges.Add(string.CompareOrdinal(first, second) <= 0
                                ? $"{first}<=>{second}"
                                : $"{second}<=>{first}");
                        }
                    }
                    catch { }
                }
            }
            return edges.OrderBy(edge => edge, StringComparer.Ordinal).ToList();
        }

        private static string ConnectorEdgeIdentity(ResolvedConnector first, ResolvedConnector second)
        {
            var a = ConnectorEndpointIdentity(ElementIdCompat.GetValue(first.Owner.Id), first.Connector);
            var b = ConnectorEndpointIdentity(ElementIdCompat.GetValue(second.Owner.Id), second.Connector);
            return string.CompareOrdinal(a, b) <= 0 ? $"{a}<=>{b}" : $"{b}<=>{a}";
        }

        private static string ConnectorEndpointIdentity(long elementId, Connector connector)
        {
            var connectorIdentity = MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId)
                ? $"native:{nativeId}"
                : $"origin:{PointFingerprint(connector.Origin)}";
            return $"{elementId}/{connectorIdentity}";
        }

        private static List<object> SnapshotRepairElements(Document doc, List<long> elementIds)
        {
            var result = new List<object>();
            foreach (var elementId in elementIds.OrderBy(id => id))
            {
                var element = doc.GetElement(ElementIdCompat.Create(elementId));
                if (element == null)
                {
                    result.Add(new { elementId, exists = false });
                    continue;
                }
                double[]? startXyz = null;
                double[]? endXyz = null;
                if (element.Location is LocationCurve locationCurve && locationCurve.Curve != null)
                {
                    var start = locationCurve.Curve.GetEndPoint(0);
                    var end = locationCurve.Curve.GetEndPoint(1);
                    startXyz = new[] { start.X, start.Y, start.Z };
                    endXyz = new[] { end.X, end.Y, end.Z };
                }
                var connectors = MepSystemUtil.GetConnectors(element)
                    .Where(connector => connector != null)
                    .Select((connector, index) => new
                    {
                        index,
                        connectorId = MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId)
                            ? nativeId
                            : index,
                        origin = new[] { connector.Origin.X, connector.Origin.Y, connector.Origin.Z },
                        systemClassification = ConnectorSystemClassification(connector),
                        systemName = SafeText(() => connector.MEPSystem?.Name ?? string.Empty),
                        physicalConnectedOwnerIds = PhysicalConnectedOwnerIds(connector)
                    })
                    .OrderBy(connector => connector.connectorId)
                    .ToList();
                var flexGeometry = SnapshotFlexGeometry(element);
                result.Add(new
                {
                    elementId,
                    exists = true,
                    category = SafeText(() => element.Category?.Name ?? string.Empty),
                    startXyz,
                    endXyz,
                    connectors,
                    flexGeometry
                });
            }
            return result;
        }

        private static List<string> SnapshotRepairFingerprint(Document doc, List<long> elementIds)
        {
            var result = new List<string>();
            foreach (var elementId in elementIds.OrderBy(id => id))
            {
                var element = doc.GetElement(ElementIdCompat.Create(elementId));
                if (element == null)
                {
                    result.Add($"{elementId}|missing");
                    continue;
                }
                var curve = "no_curve";
                if (element.Location is LocationCurve locationCurve && locationCurve.Curve != null)
                {
                    curve = $"{PointFingerprint(locationCurve.Curve.GetEndPoint(0))}>" +
                        $"{PointFingerprint(locationCurve.Curve.GetEndPoint(1))}";
                }
                var flexCurve = FlexGeometryFingerprint(element);
                var connectors = MepSystemUtil.GetConnectors(element)
                    .Where(connector => connector != null)
                    .Select(connector =>
                    {
                        var connectorId = MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId)
                            ? nativeId.ToString()
                            : "origin_guard";
                        return $"{connectorId}@{PointFingerprint(connector.Origin)}=>" +
                            $"{ConnectorSystemClassification(connector)}=>" +
                            string.Join(",", PhysicalConnectedOwnerIds(connector));
                    })
                    .OrderBy(value => value, StringComparer.Ordinal)
                    .ToList();
                result.Add($"{elementId}|{curve}|{flexCurve}|{string.Join(";", connectors)}");
            }
            return result;
        }

        private static object? SnapshotFlexGeometry(Element element)
        {
            if (element is Autodesk.Revit.DB.Mechanical.FlexDuct flexDuct)
                return BuildFlexGeometrySnapshot("duct", flexDuct.Points, flexDuct.StartTangent, flexDuct.EndTangent);
            if (element is Autodesk.Revit.DB.Plumbing.FlexPipe flexPipe)
                return BuildFlexGeometrySnapshot("pipe", flexPipe.Points, flexPipe.StartTangent, flexPipe.EndTangent);
            return null;
        }

        private static object BuildFlexGeometrySnapshot(
            string kind,
            IList<XYZ> points,
            XYZ startTangent,
            XYZ endTangent)
        {
            return new
            {
                kind,
                points = (points ?? new List<XYZ>())
                    .Select(point => new[] { point.X, point.Y, point.Z })
                    .ToList(),
                startTangent = new[] { startTangent.X, startTangent.Y, startTangent.Z },
                endTangent = new[] { endTangent.X, endTangent.Y, endTangent.Z }
            };
        }

        private static string FlexGeometryFingerprint(Element element)
        {
            if (element is Autodesk.Revit.DB.Mechanical.FlexDuct flexDuct)
                return BuildFlexGeometryFingerprint(flexDuct.Points, flexDuct.StartTangent, flexDuct.EndTangent);
            if (element is Autodesk.Revit.DB.Plumbing.FlexPipe flexPipe)
                return BuildFlexGeometryFingerprint(flexPipe.Points, flexPipe.StartTangent, flexPipe.EndTangent);
            return "no_flex_curve";
        }

        private static string BuildFlexGeometryFingerprint(
            IList<XYZ> points,
            XYZ startTangent,
            XYZ endTangent)
        {
            return string.Join(">", (points ?? new List<XYZ>()).Select(PointFingerprint)) +
                $"|st:{PointFingerprint(startTangent)}|et:{PointFingerprint(endTangent)}";
        }

        private static void ValidateFlexPoints(List<double[]>? pointArrays)
        {
            if (pointArrays == null || pointArrays.Count < 2)
                throw new ArgumentException("repair.flexPoints must contain at least two XYZ points.");
            if (pointArrays.Count > 64)
                throw new ArgumentException("repair.flexPoints exceeds the maximum of 64 points.");
            XYZ? previous = null;
            for (var index = 0; index < pointArrays.Count; index++)
            {
                var point = ParseXyz(pointArrays[index], $"repair_flex_point_{index}");
                if (previous != null && previous.DistanceTo(point) <= 1e-6)
                    throw new ArgumentException($"repair_flex_points_are_degenerate:{index - 1}:{index}");
                previous = point;
            }
        }

        private static XYZ ParseNonZeroVector(double[]? values, string name)
        {
            var vector = ParseXyz(values, name);
            if (vector.GetLength() <= 1e-9)
                throw new ArgumentException($"{name} must be non-zero.");
            return vector;
        }

        private static string PointFingerprint(XYZ point)
        {
            return $"{BitConverter.DoubleToInt64Bits(point.X)}," +
                $"{BitConverter.DoubleToInt64Bits(point.Y)}," +
                $"{BitConverter.DoubleToInt64Bits(point.Z)}";
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

        private static bool AreDirectlyConnected(Connector a, Connector b)
        {
            try
            {
                foreach (Connector reference in a.AllRefs)
                {
                    if (reference?.Owner?.Id != b.Owner?.Id) continue;
                    if (MepSystemUtil.TryGetNativeConnectorId(reference, out var referenceId) &&
                        MepSystemUtil.TryGetNativeConnectorId(b, out var bId))
                    {
                        if (referenceId == bId) return true;
                        continue;
                    }
                    if (reference.Origin.DistanceTo(b.Origin) <= 1e-6) return true;
                }
            }
            catch { }
            return false;
        }

        private static void AssertCompatible(
            Connector a,
            Connector b,
            string stage,
            bool allowDifferentShapes = false)
        {
            try
            {
                if (a.Domain != b.Domain)
                    throw new InvalidOperationException($"connector_domain_mismatch_{stage}:{a.Domain}:{b.Domain}");
            }
            catch (InvalidOperationException) { throw; }
            catch { }
            try
            {
                if (!allowDifferentShapes && a.Shape != b.Shape)
                    throw new InvalidOperationException($"connector_shape_mismatch_{stage}:{a.Shape}:{b.Shape}");
            }
            catch (InvalidOperationException) { throw; }
            catch { }
            var firstSystem = ConnectorSystemClassification(a);
            var secondSystem = ConnectorSystemClassification(b);
            if (!string.IsNullOrWhiteSpace(firstSystem) &&
                !string.IsNullOrWhiteSpace(secondSystem) &&
                !string.Equals(firstSystem, secondSystem, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException(
                    $"connector_system_classification_mismatch_{stage}:{firstSystem}:{secondSystem}");
        }

        private static string ConnectorSystemClassification(Connector connector)
        {
            try
            {
                var value = connector.PipeSystemType.ToString();
                if (IsDefinedSystemClassification(value)) return $"pipe:{value}";
            }
            catch { }
            try
            {
                var value = connector.DuctSystemType.ToString();
                if (IsDefinedSystemClassification(value)) return $"duct:{value}";
            }
            catch { }
            try
            {
                var system = connector.MEPSystem;
                if (system != null)
                    return $"mep_type:{ElementIdCompat.GetValue(system.GetTypeId())}";
            }
            catch { }
            return string.Empty;
        }

        private static bool IsDefinedSystemClassification(string? value)
        {
            var normalized = (value ?? string.Empty).Trim();
            return normalized.Length > 0 &&
                normalized.IndexOf("undefined", StringComparison.OrdinalIgnoreCase) < 0 &&
                normalized.IndexOf("invalid", StringComparison.OrdinalIgnoreCase) < 0;
        }

        private static void AssertExpectedModel(Document doc, string? expectedModelPath)
        {
            var expected = (expectedModelPath ?? string.Empty).Trim();
            if (expected.Length == 0) return;
            var actual = Path.GetFullPath(doc.PathName ?? string.Empty);
            var normalizedExpected = Path.GetFullPath(expected);
            if (!string.Equals(actual, normalizedExpected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException(
                    $"active_model_path_mismatch:expected={normalizedExpected}:actual={actual}");
        }

        private static XYZ ParseXyz(double[]? values, string label)
        {
            if (values == null || values.Length < 3 ||
                !IsFinite(values[0]) || !IsFinite(values[1]) || !IsFinite(values[2]))
                throw new ArgumentException($"{label}_must_be_finite_xyz");
            return new XYZ(values[0], values[1], values[2]);
        }

        private static void ValidateOriginGuardIfProvided(
            XYZ actual,
            double[]? expectedValues,
            double originTolerance,
            ConnectorReference reference)
        {
            if (expectedValues == null) return;
            var expected = ParseXyz(expectedValues, "connector_expected_origin");
            var distance = actual.DistanceTo(expected);
            if (distance > originTolerance)
                throw new InvalidOperationException(
                    $"connector_origin_guard_failed:{reference.elementId}:{reference.connectorId}:{distance:0.########}");
        }

        private static bool IsFinite(double value) =>
            !double.IsNaN(value) && !double.IsInfinity(value);

        private static string SafeText(Func<string> read)
        {
            try { return read() ?? string.Empty; }
            catch { return string.Empty; }
        }
    }
}

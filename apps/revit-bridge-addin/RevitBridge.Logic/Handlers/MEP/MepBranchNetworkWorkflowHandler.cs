using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class MepBranchNetworkWorkflowHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string kind { get; set; } = "duct";
            public string? frameId { get; set; }
            public List<MepRoutingUtil.RoutePoint> mainPoints { get; set; } = new List<MepRoutingUtil.RoutePoint>();
            public List<BranchSpec> branches { get; set; } = new List<BranchSpec>();
            public List<AccessorySpec>? accessories { get; set; }
            public long? viewId { get; set; }
            public string? roomNumber { get; set; }
            public string? levelName { get; set; }
            public long? levelId { get; set; }
            public string? systemType { get; set; }
            public string? ductType { get; set; }
            public string? pipeType { get; set; }
            public string? ductSize { get; set; }
            public string? diameter { get; set; }
            public string? pipeSize { get; set; }
            public List<string>? mainSegmentSizes { get; set; }
            public string? sizePolicy { get; set; } = "use_default_with_warning";
            public string? elevationPolicy { get; set; } = "resolve_context_default";
            public string? routingMode { get; set; } = "polyline";
            public bool apply { get; set; } = false;
            public bool verify { get; set; } = true;
            public bool visualVerify { get; set; } = true;
            public long? visualViewId { get; set; }
            public int imageSize { get; set; } = 2200;
            public double focusPaddingFt { get; set; } = 6.0;
            public double? defaultOffsetFt { get; set; }
            public double? ceilingOffsetFt { get; set; }
        }

        public sealed class BranchSpec
        {
            public string? name { get; set; }
            public int mainSegmentIndex { get; set; } = 0;
            public string? connectionMode { get; set; } = "tee";
            public long? existingBranchAnchorElementId { get; set; }
            public string? branchSize { get; set; }
            public List<string>? branchSegmentSizes { get; set; }
            public MepRoutingUtil.RoutePoint? connectionPoint { get; set; }
            public List<MepRoutingUtil.RoutePoint> points { get; set; } = new List<MepRoutingUtil.RoutePoint>();
        }

        public sealed class AccessorySpec
        {
            public string? kind { get; set; }
            public string? familyName { get; set; }
            public string? typeName { get; set; }
            public string? familyPath { get; set; }
            public string? action { get; set; } = "insert";
            public string? on { get; set; }
            public int? mainSegmentIndex { get; set; }
            public int? branchIndex { get; set; }
            public int? branchSegmentIndex { get; set; }
            public double? chainageFt { get; set; }
            public MepRoutingUtil.RoutePoint? point { get; set; }
            public long? familySymbolId { get; set; }
            public long? targetElementId { get; set; }
            public List<long>? targetElementIds { get; set; }
            public long? typeId { get; set; }
            public string? targetTypeName { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();

            var warnings = new List<string>();
            var kind = MepRoutingUtil.NormalizeKind(p.kind);
            if (p.mainPoints == null || p.mainPoints.Count < 2)
            {
                return Task.FromResult<object>(new { status = "Blocked", error = "At least two mainPoints are required.", warnings });
            }

            var doc = app.ActiveUIDocument.Document;
            var ctx = MepRoutingUtil.ResolveRoutingContext(doc, app, new MepRoutingUtil.RoutingContextRequest
            {
                viewId = p.viewId,
                roomNumber = p.roomNumber,
                levelName = p.levelName,
                levelId = p.levelId,
                systemKind = kind,
                routingMode = p.routingMode,
                defaultOffsetFt = p.defaultOffsetFt,
                ceilingOffsetFt = p.ceilingOffsetFt,
                dryRun = true
            });
            warnings.AddRange(ctx.Warnings);
            if (ctx.Level == null)
            {
                return Task.FromResult<object>(new { status = "Blocked", error = "Could not resolve a level for this network.", warnings });
            }

            var mainResolved = ResolvePoints(p.mainPoints, p.frameId, ctx.RecommendedZ);
            TransactionGroup? networkApplyGroup = null;
            var networkApplyCommitted = false;
            if (p.apply)
            {
                networkApplyGroup = new TransactionGroup(doc, "Apply MEP Branch Network Atomically");
                try
                {
                    var startStatus = networkApplyGroup.Start();
                    if (startStatus != TransactionStatus.Started)
                    {
                        try { networkApplyGroup.Dispose(); } catch { }
                        networkApplyGroup = null;
                        return Task.FromResult<object>(new
                        {
                            status = "Blocked",
                            workflowMode = "applyRequested",
                            reason = "Revit did not start the atomic network transaction group.",
                            transactionGroupStartStatus = startStatus.ToString(),
                            warnings
                        });
                    }
                }
                catch (Exception ex)
                {
                    try { networkApplyGroup.Dispose(); } catch { }
                    networkApplyGroup = null;
                    return Task.FromResult<object>(new
                    {
                        status = "Blocked",
                        workflowMode = "applyRequested",
                        reason = "Revit could not start the atomic network transaction group.",
                        error = ex.Message,
                        warnings
                    });
                }
            }

            try
            {

            var accessoryFamilyLoadResults = p.apply
                ? EnsureAccessoryFamiliesLoaded(doc, kind, p.accessories, warnings)
                : new List<object>();
            var failedFamilyLoad = accessoryFamilyLoadResults.FirstOrDefault(x =>
            {
                var json = ToElement(x);
                return IsBlocked(ReadString(json, "status"));
            });
            if (failedFamilyLoad != null)
            {
                var rolledBack = RollBackTransactionGroup(networkApplyGroup);
                networkApplyGroup = null;
                return Task.FromResult<object>(new
                {
                    status = p.apply ? (rolledBack ? "BlockedRolledBack" : "BlockedRollbackFailed") : "Blocked",
                    workflowMode = "applyRequested",
                    reason = "One or more accessory families could not be loaded before route geometry was created.",
                    atomicRollbackSucceeded = p.apply ? rolledBack : (bool?)null,
                    accessoryFamilyLoadResults,
                    warnings = warnings.Distinct().ToList()
                });
            }

            var branchPlans = BuildBranchPlans(kind, p, mainResolved, ctx.RecommendedZ, warnings);
            var accessoryPlans = BuildAccessoryPlans(doc, kind, p, mainResolved, ctx.RecommendedZ);
            var blockingAccessoryPlans = accessoryPlans.Where(x => x.applySupported == false).ToList();

            var mainDryRun = Invoke(new CreateMepRouteHandler(), app, ToCreateMainParams(p, kind, dryRun: true));
            var mainDryRunJson = ToElement(mainDryRun);
            warnings.AddRange(ReadStringArray(mainDryRunJson, "warnings"));
            if (IsBlocked(ReadString(mainDryRunJson, "status")))
            {
                var rolledBack = RollBackTransactionGroup(networkApplyGroup);
                networkApplyGroup = null;
                return Task.FromResult<object>(new
                {
                    status = p.apply ? (rolledBack ? "BlockedRolledBack" : "BlockedRollbackFailed") : "Blocked",
                    workflowMode = p.apply ? "applyRequested" : "dryRun",
                    reason = "Main route dry-run failed.",
                    atomicRollbackSucceeded = p.apply ? rolledBack : (bool?)null,
                    networkPlan = BuildNetworkPlan(mainResolved, branchPlans, accessoryPlans),
                    accessoryFamilyLoadResults,
                    mainDryRun,
                    warnings = warnings.Distinct().ToList()
                });
            }

            if (blockingAccessoryPlans.Count > 0 && p.apply)
            {
                var rolledBack = RollBackTransactionGroup(networkApplyGroup);
                networkApplyGroup = null;
                return Task.FromResult<object>(new
                {
                    status = rolledBack ? "BlockedRolledBack" : "BlockedRollbackFailed",
                    workflowMode = "applyRequested",
                    reason = "One or more accessory/damper graph nodes are not safe to apply.",
                    atomicRollbackSucceeded = rolledBack,
                    networkPlan = BuildNetworkPlan(mainResolved, branchPlans, accessoryPlans),
                    accessoryFamilyLoadResults,
                    mainDryRun,
                    warnings = warnings.Distinct().ToList()
                });
            }

            if (!p.apply)
            {
                return Task.FromResult<object>(new
                {
                    status = "DryRunReady",
                    workflowMode = "dryRun",
                    executionOrder = BuildExecutionOrder(p.branches.Count, accessoryPlans.Count, applied: false, visualAttempted: false),
                    networkPlan = BuildNetworkPlan(mainResolved, branchPlans, accessoryPlans),
                    accessoryFamilyLoadResults,
                    mainDryRun,
                    warnings = warnings.Distinct().ToList()
                });
            }

            var mainApply = Invoke(new CreateMepRouteHandler(), app, ToCreateMainParams(p, kind, dryRun: false));
            var mainApplyJson = ToElement(mainApply);
            warnings.AddRange(ReadStringArray(mainApplyJson, "warnings"));
            if (IsBlocked(ReadString(mainApplyJson, "status")))
            {
                var rolledBack = RollBackTransactionGroup(networkApplyGroup);
                networkApplyGroup = null;
                return Task.FromResult<object>(new
                {
                    status = rolledBack ? "BlockedRolledBack" : "BlockedRollbackFailed",
                    workflowMode = "apply",
                    reason = "Main route apply failed.",
                    atomicRollbackSucceeded = rolledBack,
                    networkPlan = BuildNetworkPlan(mainResolved, branchPlans, accessoryPlans),
                    accessoryFamilyLoadResults,
                    mainDryRun,
                    mainApply,
                    warnings = warnings.Distinct().ToList()
                });
            }

            var mainElementIds = ReadLongArray(mainApplyJson, "createdElementIds");
            var mainFittingIds = ReadLongArray(mainApplyJson, "createdFittingIds");
            var branchResults = new List<object>();
            var createdBranchIds = new List<long>();
            var createdBranchFittingIds = new List<long>();
            var splitMainIds = new List<long>();
            var branchElementIdsByBranchIndex = new Dictionary<int, List<long>>();

            for (var i = 0; i < p.branches.Count; i++)
            {
                var branch = p.branches[i];
                if (branch.mainSegmentIndex < 0 || branch.mainSegmentIndex >= mainElementIds.Count)
                {
                    var rolledBack = RollBackTransactionGroup(networkApplyGroup);
                    networkApplyGroup = null;
                    return Task.FromResult<object>(new
                    {
                        status = rolledBack ? "BlockedRolledBack" : "BlockedRollbackFailed",
                        workflowMode = "apply",
                        reason = $"Branch {i} references mainSegmentIndex {branch.mainSegmentIndex}, but only {mainElementIds.Count} main segment(s) were created.",
                        atomicRollbackSucceeded = rolledBack,
                        networkPlan = BuildNetworkPlan(mainResolved, branchPlans, accessoryPlans),
                        accessoryFamilyLoadResults,
                        mainDryRun,
                        mainApply,
                        branchResults,
                        warnings = warnings.Distinct().ToList()
                    });
                }

                var branchParams = ToBranchParams(p, kind, branch, mainElementIds[branch.mainSegmentIndex], dryRun: false);
                var branchApply = Invoke(new ConnectMepBranchHandler(), app, branchParams);
                var branchJson = ToElement(branchApply);
                warnings.AddRange(ReadStringArray(branchJson, "warnings"));
                branchResults.Add(new { index = i, name = branch.name, result = branchApply });
                if (IsBlocked(ReadString(branchJson, "status")) || ReadBool(branchJson, "rolledBack"))
                {
                    var rolledBack = RollBackTransactionGroup(networkApplyGroup);
                    networkApplyGroup = null;
                    return Task.FromResult<object>(new
                    {
                        status = rolledBack ? "BlockedRolledBack" : "BlockedRollbackFailed",
                        workflowMode = "apply",
                        reason = $"Branch {i} failed. The complete network transaction group was rolled back.",
                        atomicRollbackSucceeded = rolledBack,
                        networkPlan = BuildNetworkPlan(mainResolved, branchPlans, accessoryPlans),
                        accessoryFamilyLoadResults,
                        mainDryRun,
                        mainApply,
                        branchResults,
                        warnings = warnings.Distinct().ToList()
                    });
                }

                var branchElementIds = ReadLongArray(branchJson, "createdBranchElementIds");
                branchElementIdsByBranchIndex[i] = branchElementIds;
                createdBranchIds.AddRange(branchElementIds);
                createdBranchFittingIds.AddRange(ReadLongArray(branchJson, "createdFittingIds"));
                splitMainIds.AddRange(ReadLongArray(branchJson, "splitMainSegmentIds"));
            }

            var accessoryResults = ApplyAccessoryPlans(app, kind, accessoryPlans, mainElementIds, branchElementIdsByBranchIndex, warnings);
            var createdAccessoryIds = accessoryResults
                .SelectMany(x => x.CreatedElementIds)
                .Where(x => x > 0)
                .Distinct()
                .ToList();
            var deletedAccessoryIds = accessoryResults
                .SelectMany(x => x.DeletedElementIds)
                .Where(x => x > 0)
                .Distinct()
                .ToList();
            var changedAccessoryIds = accessoryResults
                .SelectMany(x => x.ChangedElementIds)
                .Where(x => x > 0)
                .Distinct()
                .ToList();
            if (accessoryResults.Any(x => !x.Ok))
            {
                var rolledBack = RollBackTransactionGroup(networkApplyGroup);
                networkApplyGroup = null;
                return Task.FromResult<object>(new
                {
                    status = rolledBack ? "BlockedRolledBack" : "BlockedRollbackFailed",
                    workflowMode = "apply",
                    reason = "Accessory apply failed. The complete network transaction group was rolled back.",
                    atomicRollbackSucceeded = rolledBack,
                    networkPlan = BuildNetworkPlan(mainResolved, branchPlans, accessoryPlans),
                    accessoryFamilyLoadResults,
                    mainDryRun,
                    mainApply,
                    branchResults,
                    accessoryResults,
                    warnings = warnings.Distinct().ToList()
                });
            }

            var allModelIds = mainElementIds
                .Concat(mainFittingIds)
                .Concat(splitMainIds)
                .Concat(createdBranchIds)
                .Concat(createdBranchFittingIds)
                .Concat(createdAccessoryIds)
                .Concat(changedAccessoryIds)
                .Where(x => x > 0)
                .Distinct()
                .ToList();

            var existingModelIds = allModelIds
                .Where(id => doc.GetElement(ElementIdCompat.Create(id)) != null)
                .ToList();
            var branchAuditStatuses = branchResults
                .Select(ReadBranchNetworkAuditStatus)
                .ToList();
            var semanticVerification = MepNetworkApplyPolicy.Verify(
                allModelIds,
                existingModelIds,
                branchAuditStatuses,
                p.verify);
            if (!semanticVerification.Pass)
            {
                var rolledBack = RollBackTransactionGroup(networkApplyGroup);
                networkApplyGroup = null;
                return Task.FromResult<object>(new
                {
                    status = rolledBack ? "BlockedRolledBack" : "BlockedRollbackFailed",
                    workflowMode = "apply",
                    reason = "Post-apply semantic verification failed. The complete network transaction group was rolled back.",
                    atomicRollbackSucceeded = rolledBack,
                    semanticVerification,
                    networkPlan = BuildNetworkPlan(mainResolved, branchPlans, accessoryPlans),
                    accessoryFamilyLoadResults,
                    mainDryRun,
                    mainApply,
                    branchResults,
                    accessoryResults,
                    warnings = warnings.Distinct().ToList()
                });
            }

            object visualVerification = new { status = "SkippedByRequest" };
            var visualAttempted = false;
            if (p.visualVerify && allModelIds.Count > 0)
            {
                visualAttempted = true;
                visualVerification = TryExportVisual(app, p, mainElementIds, splitMainIds, createdBranchIds, mainFittingIds.Concat(createdBranchFittingIds).ToList(), createdAccessoryIds.Concat(changedAccessoryIds).ToList(), allModelIds);
            }

            try
            {
                var commitStatus = networkApplyGroup?.Assimilate() ?? TransactionStatus.Error;
                if (commitStatus != TransactionStatus.Committed)
                    throw new InvalidOperationException($"TransactionGroup.Assimilate returned {commitStatus}.");
                networkApplyCommitted = true;
                networkApplyGroup = null;
            }
            catch (Exception ex)
            {
                warnings.Add($"The atomic network transaction group could not be committed: {ex.Message}");
                var rolledBack = RollBackTransactionGroup(networkApplyGroup);
                networkApplyGroup = null;
                return Task.FromResult<object>(new
                {
                    status = rolledBack ? "BlockedRolledBack" : "BlockedRollbackFailed",
                    workflowMode = "apply",
                    reason = "Revit could not commit the complete network transaction group.",
                    atomicRollbackSucceeded = rolledBack,
                    semanticVerification,
                    warnings = warnings.Distinct().ToList()
                });
            }

            return Task.FromResult<object>(new
            {
                status = !p.visualVerify
                    ? "AppliedNetworkVerified"
                    : ReadString(ToElement(visualVerification), "status") == "CaptureReadyForAIReview"
                        ? "AppliedNetworkVisualVerificationReady"
                        : "AppliedNetworkVisualVerificationIncomplete",
                workflowMode = "apply",
                atomicCommitSucceeded = true,
                semanticVerification,
                executionOrder = BuildExecutionOrder(p.branches.Count, accessoryPlans.Count, applied: true, visualAttempted),
                networkPlan = BuildNetworkPlan(mainResolved, branchPlans, accessoryPlans),
                accessoryFamilyLoadResults,
                mainDryRun,
                mainApply,
                branchResults,
                accessoryResults,
                created = new
                {
                    mainElementIds,
                    mainFittingIds,
                    splitMainSegmentIds = splitMainIds.Distinct().ToList(),
                    branchElementIds = createdBranchIds.Distinct().ToList(),
                    branchFittingIds = createdBranchFittingIds.Distinct().ToList(),
                    accessoryElementIds = createdAccessoryIds,
                    deletedAccessoryElementIds = deletedAccessoryIds,
                    changedAccessoryElementIds = changedAccessoryIds,
                    allModelIds
                },
                visualVerification,
                warnings = warnings.Distinct().ToList()
            });
            }
            catch (Exception ex)
            {
                warnings.Add($"Atomic MEP network apply failed: {ex.Message}");
                var rolledBack = p.apply && RollBackTransactionGroup(networkApplyGroup);
                networkApplyGroup = null;
                return Task.FromResult<object>(new
                {
                    status = !p.apply ? "Blocked" : rolledBack ? "BlockedRolledBack" : "BlockedRollbackFailed",
                    workflowMode = p.apply ? "apply" : "dryRun",
                    reason = "The network workflow encountered an unexpected error.",
                    error = ex.Message,
                    atomicRollbackSucceeded = p.apply ? rolledBack : (bool?)null,
                    warnings = warnings.Distinct().ToList()
                });
            }
            finally
            {
                if (!networkApplyCommitted && networkApplyGroup != null)
                {
                    RollBackTransactionGroup(networkApplyGroup);
                }
            }
        }

        private static List<XYZ> ResolvePoints(List<MepRoutingUtil.RoutePoint> points, string? frameId, double fallbackZ)
        {
            return (points ?? new List<MepRoutingUtil.RoutePoint>())
                .Select(p => MepRoutingUtil.ResolveRoutePoint(p, frameId, fallbackZ, out _))
                .ToList();
        }

        private static List<object> BuildBranchPlans(string kind, Params p, List<XYZ> mainResolved, double fallbackZ, List<string> warnings)
        {
            var plans = new List<object>();
            for (var i = 0; i < (p.branches?.Count ?? 0); i++)
            {
                var branch = p.branches[i];
                var branchPoints = ResolveBranchPoints(branch, p.frameId, fallbackZ);
                object? splitPlan = null;
                var validMainSegment = branch.mainSegmentIndex >= 0 && branch.mainSegmentIndex < mainResolved.Count - 1;
                if (validMainSegment && branchPoints.Count >= 2)
                {
                    var a = mainResolved[branch.mainSegmentIndex];
                    var b = mainResolved[branch.mainSegmentIndex + 1];
                    var line = Line.CreateBound(a, b);
                    var projected = line.Project(branchPoints[0]);
                    var projectedPoint = projected?.XYZPoint;
                    var distance = projectedPoint == null ? (double?)null : branchPoints[0].DistanceTo(projectedPoint);
                    var precheck = BranchSplitPlanner.PlanLineSplitGeometry(
                        kind,
                        true,
                        true,
                        a,
                        b,
                        branchPoints[0],
                        branchPoints,
                        projectedPoint,
                        distance,
                        branch.connectionMode ?? "tee");
                    splitPlan = precheck.ToResponse();
                }
                else if (!validMainSegment)
                {
                    warnings.Add($"Branch {i} references invalid mainSegmentIndex {branch.mainSegmentIndex}.");
                }

                plans.Add(new
                {
                    index = i,
                    name = branch.name,
                    mainSegmentIndex = branch.mainSegmentIndex,
                    connectionMode = string.IsNullOrWhiteSpace(branch.connectionMode) ? "tee" : branch.connectionMode,
                    existingBranchAnchorElementId = branch.existingBranchAnchorElementId,
                    requestedSize = branch.branchSize,
                    segmentSizes = BuildBranchSegmentSizeTexts(branch, Math.Max(0, branchPoints.Count - 1)),
                    jointPlan = MepRouteJointPlanner.PlanJoints(BuildBranchSegmentSizeTexts(branch, Math.Max(0, branchPoints.Count - 1))).Select(j => new
                    {
                        jointIndex = j.JointIndex,
                        expectedFitting = j.ExpectedFitting,
                        reason = j.Reason,
                        fromSize = j.FromSize,
                        toSize = j.ToSize
                    }).ToList(),
                    points = branchPoints.Select(ToPointObject).ToList(),
                    splitPlan
                });
            }
            return plans;
        }

        private static List<XYZ> ResolveBranchPoints(BranchSpec branch, string? frameId, double fallbackZ)
        {
            var source = new List<MepRoutingUtil.RoutePoint>();
            if (branch.connectionPoint != null) source.Add(branch.connectionPoint);
            if (branch.points != null) source.AddRange(branch.points);
            return ResolvePoints(source, frameId, fallbackZ);
        }

        private sealed class AccessoryPlan
        {
            public int index { get; set; }
            public string? action { get; set; }
            public string? kind { get; set; }
            public string? familyName { get; set; }
            public string? typeName { get; set; }
            public string? familyPath { get; set; }
            public string? on { get; set; }
            public int? mainSegmentIndex { get; set; }
            public int? branchIndex { get; set; }
            public int? branchSegmentIndex { get; set; }
            public double? chainageFt { get; set; }
            public object? point { get; set; }
            public bool applySupported { get; set; }
            public string? blockCode { get; set; }
            public string? blockReason { get; set; }
            public long? familySymbolId { get; set; }
            public string? familySymbolName { get; set; }
            public string? familySymbolFamilyName { get; set; }
            public bool familyLoadRequired { get; set; }
            public string? resolvedFamilyPath { get; set; }
            public List<long> targetElementIds { get; set; } = new List<long>();
            public List<object> targetElements { get; set; } = new List<object>();
            public long? targetTypeId { get; set; }
            public string? targetTypeName { get; set; }
            public string? hostKind { get; set; }
            public int? hostIndex { get; set; }
            public int? hostSegmentIndex { get; set; }
            public object? resolvedPoint { get; set; }
            public double? distanceToHostFt { get; set; }
        }

        private sealed class AccessoryApplyResult
        {
            public int Index { get; set; }
            public bool Ok { get; set; }
            public string Action { get; set; } = "";
            public string? Status { get; set; }
            public string? Error { get; set; }
            public List<long> CreatedElementIds { get; set; } = new List<long>();
            public List<long> DeletedElementIds { get; set; } = new List<long>();
            public List<long> ChangedElementIds { get; set; } = new List<long>();
            public List<object> TypeChanges { get; set; } = new List<object>();
            public long? HostElementId { get; set; }
            public long? FamilySymbolId { get; set; }
            public long? TargetTypeId { get; set; }
            public object? Location { get; set; }
        }

        private static List<AccessoryPlan> BuildAccessoryPlans(Document doc, string routeKind, Params p, List<XYZ> mainResolved, double fallbackZ)
        {
            var result = new List<AccessoryPlan>();
            var accessories = p.accessories;
            for (var i = 0; i < (accessories?.Count ?? 0); i++)
            {
                var a = accessories![i];
                var kind = (a.kind ?? "").Trim().ToLowerInvariant();
                var action = string.IsNullOrWhiteSpace(a.action) ? "insert" : a.action!.Trim().ToLowerInvariant();
                var isDamper = kind.Contains("damper") ||
                    (a.familyName ?? "").IndexOf("damper", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    (a.typeName ?? "").IndexOf("damper", StringComparison.OrdinalIgnoreCase) >= 0;
                var plan = new AccessoryPlan
                {
                    index = i,
                    action = action,
                    kind = string.IsNullOrWhiteSpace(a.kind) ? (isDamper ? "damper" : "accessory") : a.kind,
                    familyName = a.familyName,
                    typeName = a.typeName,
                    familyPath = a.familyPath,
                    on = a.on,
                    mainSegmentIndex = a.mainSegmentIndex,
                    branchIndex = a.branchIndex,
                    branchSegmentIndex = a.branchSegmentIndex,
                    chainageFt = a.chainageFt,
                    point = a.point == null ? null : new { a.point.x, a.point.y, a.point.z, a.point.xPx, a.point.yPx },
                    applySupported = false
                };

                if (action == "delete" || action == "remove")
                {
                    var targets = ResolveAccessoryTargets(doc, routeKind, a, plan);
                    if (targets.Count == 0)
                    {
                        if (string.IsNullOrWhiteSpace(plan.blockCode))
                        {
                            plan.blockCode = "accessory_target_required";
                            plan.blockReason = "Accessory delete requires targetElementId or targetElementIds.";
                        }
                        result.Add(plan);
                        continue;
                    }

                    plan.targetElementIds = targets.Select(e => ElementIdCompat.GetValue(e.Id)).Distinct().ToList();
                    plan.targetElements = targets.Select(ToElementSummary).ToList();
                    plan.applySupported = true;
                    result.Add(plan);
                    continue;
                }

                if (action == "type_change" || action == "change_type")
                {
                    var targets = ResolveAccessoryTargets(doc, routeKind, a, plan);
                    if (targets.Count == 0)
                    {
                        if (string.IsNullOrWhiteSpace(plan.blockCode))
                        {
                            plan.blockCode = "accessory_target_required";
                            plan.blockReason = "Accessory type-change requires targetElementId or targetElementIds.";
                        }
                        result.Add(plan);
                        continue;
                    }

                    var targetSymbol = ResolveAccessorySymbolForRouteKind(doc, routeKind, a);
                    if (targetSymbol == null)
                    {
                        plan.blockCode = "accessory_target_type_not_found";
                        plan.blockReason = "Could not resolve a compatible accessory target type. Provide typeId, targetTypeName, or familyName/typeName for a loaded accessory family.";
                        result.Add(plan);
                        continue;
                    }

                    var invalid = targets.FirstOrDefault(e => !CanChangeElementToType(e, targetSymbol.Id));
                    if (invalid != null)
                    {
                        plan.blockCode = "accessory_type_not_valid_for_target";
                        plan.blockReason = $"Target accessory {ElementIdCompat.GetValue(invalid.Id)} cannot change to type {ElementIdCompat.GetValue(targetSymbol.Id)}.";
                        result.Add(plan);
                        continue;
                    }

                    plan.targetElementIds = targets.Select(e => ElementIdCompat.GetValue(e.Id)).Distinct().ToList();
                    plan.targetElements = targets.Select(ToElementSummary).ToList();
                    plan.targetTypeId = ElementIdCompat.GetValue(targetSymbol.Id);
                    plan.targetTypeName = targetSymbol.Name;
                    plan.familySymbolId = ElementIdCompat.GetValue(targetSymbol.Id);
                    plan.familySymbolName = targetSymbol.Name;
                    plan.familySymbolFamilyName = targetSymbol.FamilyName;
                    plan.applySupported = true;
                    result.Add(plan);
                    continue;
                }

                if (action != "insert")
                {
                    plan.blockCode = "accessory_action_not_supported";
                    plan.blockReason = "Accessory action must be insert, delete, remove, type_change, or change_type.";
                    result.Add(plan);
                    continue;
                }

                if (a.branchIndex.HasValue)
                {
                    var branchIndex = a.branchIndex.Value;
                    plan.hostKind = "branch";
                    plan.hostIndex = branchIndex;
                    if (branchIndex < 0 || branchIndex >= (p.branches?.Count ?? 0))
                    {
                        plan.blockCode = "invalid_accessory_branch";
                        plan.blockReason = $"Accessory references branchIndex {branchIndex}, but the network has {(p.branches?.Count ?? 0)} branch(es).";
                        result.Add(plan);
                        continue;
                    }

                    var branchPoints = ResolveBranchPoints(p.branches[branchIndex], p.frameId, fallbackZ);
                    var branchSegmentIndex = a.branchSegmentIndex ?? 0;
                    plan.hostSegmentIndex = branchSegmentIndex;
                    if (branchSegmentIndex < 0 || branchSegmentIndex >= Math.Max(0, branchPoints.Count - 1))
                    {
                        plan.blockCode = "invalid_accessory_branch_segment";
                        plan.blockReason = $"Accessory references branchSegmentIndex {branchSegmentIndex}, but branch {branchIndex} has {Math.Max(0, branchPoints.Count - 1)} segment(s).";
                        result.Add(plan);
                        continue;
                    }

                    var hostLine = Line.CreateBound(branchPoints[branchSegmentIndex], branchPoints[branchSegmentIndex + 1]);
                    if (!PlanAccessoryInsertionPoint(a, p.frameId, fallbackZ, hostLine, "branch segment", plan, out var insertionPoint, out var distanceToHost))
                    {
                        result.Add(plan);
                        continue;
                    }

                    plan.resolvedPoint = insertionPoint == null ? null : ToPointObject(insertionPoint);
                    plan.distanceToHostFt = distanceToHost;
                }
                else
                {
                    var mainIndex = a.mainSegmentIndex ?? 0;
                    plan.hostKind = "main";
                    plan.hostIndex = mainIndex;
                    if (mainIndex < 0 || mainIndex >= Math.Max(0, mainResolved.Count - 1))
                    {
                        plan.blockCode = "invalid_accessory_main_segment";
                        plan.blockReason = $"Accessory references mainSegmentIndex {mainIndex}, but the main route has {Math.Max(0, mainResolved.Count - 1)} segment(s).";
                        result.Add(plan);
                        continue;
                    }

                    var hostLine = Line.CreateBound(mainResolved[mainIndex], mainResolved[mainIndex + 1]);
                    plan.hostSegmentIndex = mainIndex;
                    if (!PlanAccessoryInsertionPoint(a, p.frameId, fallbackZ, hostLine, "main segment", plan, out var insertionPoint, out var distanceToHost))
                    {
                        result.Add(plan);
                        continue;
                    }

                    plan.resolvedPoint = insertionPoint == null ? null : ToPointObject(insertionPoint);
                    plan.distanceToHostFt = distanceToHost;
                }

                var symbol = ResolveAccessorySymbolForRouteKind(doc, routeKind, a);
                if (symbol == null)
                {
                    var resolvedFamilyPath = ResolveOptionalFamilyPath(a, out var familyPathError);
                    if (!string.IsNullOrWhiteSpace(a.familyPath))
                    {
                        plan.familyLoadRequired = true;
                        plan.resolvedFamilyPath = resolvedFamilyPath;
                    }

                    plan.blockCode = "accessory_symbol_not_found";
                    plan.blockReason = familyPathError ?? $"Could not resolve a {routeKind} accessory FamilySymbol. Provide familySymbolId, familyPath, or familyName/typeName for a loaded {routeKind} accessory family.";
                    result.Add(plan);
                    continue;
                }

                plan.familySymbolId = ElementIdCompat.GetValue(symbol.Id);
                plan.familySymbolName = symbol.Name;
                plan.familySymbolFamilyName = symbol.FamilyName;
                plan.applySupported = true;
                plan.blockCode = null;
                plan.blockReason = null;
                result.Add(plan);
            }
            return result;
        }

        private sealed class FamilyLoadOptions : IFamilyLoadOptions
        {
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues)
            {
                overwriteParameterValues = false;
                return true;
            }

            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            {
                source = FamilySource.Family;
                overwriteParameterValues = false;
                return true;
            }
        }

        private static List<object> EnsureAccessoryFamiliesLoaded(Document doc, string routeKind, List<AccessorySpec>? accessories, List<string> warnings)
        {
            var results = new List<object>();
            if (accessories == null || accessories.Count == 0) return results;

            var paths = new List<string>();
            for (var i = 0; i < accessories.Count; i++)
            {
                var spec = accessories[i];
                var action = string.IsNullOrWhiteSpace(spec.action) ? "insert" : spec.action!.Trim().ToLowerInvariant();
                if (action != "insert" || string.IsNullOrWhiteSpace(spec.familyPath)) continue;
                if (!AccessoryCategoryForRouteKind(routeKind).HasValue) continue;

                var resolved = ResolveOptionalFamilyPath(spec, out var error);
                if (resolved == null)
                {
                    results.Add(new { status = "Blocked", accessoryIndex = i, familyPath = spec.familyPath, error = error ?? "Family path could not be resolved." });
                    continue;
                }
                paths.Add(resolved);
            }

            foreach (var path in paths.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (HasFamilyLoadedFromName(doc, Path.GetFileNameWithoutExtension(path)))
                {
                    results.Add(new { status = "AlreadyLoaded", familyPath = path, familyName = Path.GetFileNameWithoutExtension(path), loaded = false });
                    continue;
                }

                using (var tx = new Transaction(doc, "Load MEP Accessory Family"))
                {
                    tx.Start();
                    try
                    {
                        var loaded = doc.LoadFamily(path, new FamilyLoadOptions(), out Family family);
                        if (family == null) throw new InvalidOperationException("Revit did not return a Family after loading.");
                        var symbols = family.GetFamilySymbolIds()
                            .Select(id => doc.GetElement(id))
                            .OfType<FamilySymbol>()
                            .Select(s => new
                            {
                                id = ElementIdCompat.GetValue(s.Id),
                                name = s.Name,
                                familyName = s.FamilyName,
                                categoryId = ElementIdCompat.GetValue(s.Category?.Id),
                                categoryName = s.Category?.Name
                            })
                            .ToList();
                        tx.Commit();
                        results.Add(new
                        {
                            status = loaded ? "Loaded" : "AlreadyLoaded",
                            loaded,
                            familyPath = path,
                            familyId = ElementIdCompat.GetValue(family.Id),
                            familyName = family.Name,
                            symbols
                        });
                    }
                    catch (Exception ex)
                    {
                        try { tx.RollBack(); } catch { }
                        results.Add(new { status = "Blocked", familyPath = path, error = ex.Message });
                        warnings.Add($"Accessory family load failed for '{path}': {ex.Message}");
                    }
                }
            }

            return results;
        }

        private static bool AccessoryFamilyLoadRequested(string routeKind, List<AccessorySpec>? accessories)
        {
            if (!AccessoryCategoryForRouteKind(routeKind).HasValue) return false;
            if (accessories == null || accessories.Count == 0) return false;
            return accessories.Any(spec =>
            {
                var action = string.IsNullOrWhiteSpace(spec.action) ? "insert" : spec.action!.Trim().ToLowerInvariant();
                return action == "insert" && !string.IsNullOrWhiteSpace(spec.familyPath);
            });
        }

        private static bool RollBackTransactionGroup(TransactionGroup? group)
        {
            if (group == null) return true;
            var rolledBack = false;
            try { rolledBack = group.RollBack() == TransactionStatus.RolledBack; } catch { }
            try { group.Dispose(); } catch { }
            return rolledBack;
        }

        private static string? ReadBranchNetworkAuditStatus(object branchResult)
        {
            try
            {
                var row = ToElement(branchResult);
                if (!row.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object) return null;
                if (!result.TryGetProperty("connectedNetworkAudit", out var audit) || audit.ValueKind != JsonValueKind.Object) return null;
                var status = ReadString(audit, "status");
                if (!string.Equals(status, "Ok", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(status, "Success", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(status, "Passed", StringComparison.OrdinalIgnoreCase)) return "Failed";
                if (!audit.TryGetProperty("systemAudit", out var systemAudit) || systemAudit.ValueKind != JsonValueKind.Object) return null;
                if (!systemAudit.TryGetProperty("pass", out var pass) || pass.ValueKind != JsonValueKind.True) return "Failed";
                return "Ok";
            }
            catch
            {
                return "Failed";
            }
        }

        private static bool HasFamilyLoadedFromName(Document doc, string familyName)
        {
            if (string.IsNullOrWhiteSpace(familyName)) return false;
            return new FilteredElementCollector(doc)
                .OfClass(typeof(Family))
                .Cast<Family>()
                .Any(f => string.Equals(f.Name, familyName, StringComparison.OrdinalIgnoreCase));
        }

        private static string? ResolveOptionalFamilyPath(AccessorySpec spec, out string? error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(spec.familyPath)) return null;
            try
            {
                var resolved = WorkspacePaths.ResolveExistingFileUnderWorkspace(spec.familyPath);
                if (!resolved.EndsWith(".rfa", StringComparison.OrdinalIgnoreCase))
                {
                    error = "Accessory familyPath must reference an .rfa file.";
                    return null;
                }
                return resolved;
            }
            catch (Exception ex)
            {
                error = $"Accessory familyPath could not be resolved under the Revit Operator workspace: {ex.Message}";
                return null;
            }
        }

        private static bool PlanAccessoryInsertionPoint(
            AccessorySpec a,
            string? frameId,
            double fallbackZ,
            Line hostLine,
            string hostLabel,
            AccessoryPlan plan,
            out XYZ? insertionPoint,
            out double? distanceToHost)
        {
            insertionPoint = null;
            distanceToHost = null;
                var hostLength = hostLine.Length;
                if (a.point != null)
                {
                    var requested = MepRoutingUtil.ResolveRoutePoint(a.point, frameId, fallbackZ, out _);
                    var projection = hostLine.Project(requested);
                    insertionPoint = projection?.XYZPoint;
                    distanceToHost = insertionPoint == null ? null : requested.DistanceTo(insertionPoint);
                    if (distanceToHost == null || distanceToHost > 0.25)
                    {
                        plan.blockCode = "accessory_point_too_far_from_host";
                        plan.blockReason = $"Accessory point must project within 0.25 ft of the target {hostLabel}.";
                        return false;
                    }
                }
                else if (a.chainageFt.HasValue)
                {
                    if (a.chainageFt.Value < 0.5 || a.chainageFt.Value > hostLength - 0.5)
                    {
                        plan.blockCode = "accessory_chainage_too_close_to_segment_end";
                        plan.blockReason = "Accessory chainage must be at least 0.5 ft from both host segment ends.";
                        return false;
                    }

                    insertionPoint = hostLine.Evaluate(a.chainageFt.Value / hostLength, true);
                    distanceToHost = 0;
                }
                else
                {
                    plan.blockCode = "accessory_location_required";
                    plan.blockReason = "Accessory insertion requires either point or chainageFt.";
                    return false;
                }

            return true;
        }

        private static List<AccessoryApplyResult> ApplyAccessoryPlans(UIApplication app, string routeKind, List<AccessoryPlan> accessoryPlans, List<long> mainElementIds, Dictionary<int, List<long>> branchElementIdsByBranchIndex, List<string> warnings)
        {
            var doc = app.ActiveUIDocument.Document;
            var results = new List<AccessoryApplyResult>();
            var supported = accessoryPlans.Where(x => x.applySupported).ToList();
            if (supported.Count == 0) return results;

            using (var tx = new Transaction(doc, "Apply MEP Network Accessories"))
            {
                tx.Start();
                foreach (var plan in supported)
                {
                    var result = new AccessoryApplyResult
                    {
                        Index = plan.index,
                        Action = plan.action ?? "insert",
                        FamilySymbolId = plan.familySymbolId,
                        TargetTypeId = plan.targetTypeId,
                        Location = plan.resolvedPoint
                    };
                    try
                    {
                        var action = (plan.action ?? "insert").Trim().ToLowerInvariant();
                        if (action == "insert")
                        {
                            if (!plan.hostIndex.HasValue)
                                throw new InvalidOperationException("Accessory insert has no host index.");
                            if (!plan.familySymbolId.HasValue)
                                throw new InvalidOperationException("Accessory plan has no resolved family symbol id.");

                            long hostId;
                            if (string.Equals(plan.hostKind, "main", StringComparison.OrdinalIgnoreCase))
                            {
                                if (plan.hostIndex.Value < 0 || plan.hostIndex.Value >= mainElementIds.Count)
                                    throw new InvalidOperationException($"Accessory host main index {plan.hostIndex.Value} was not created.");
                                hostId = mainElementIds[plan.hostIndex.Value];
                            }
                            else if (string.Equals(plan.hostKind, "branch", StringComparison.OrdinalIgnoreCase))
                            {
                                var branchIndex = plan.hostIndex.Value;
                                var branchSegmentIndex = plan.hostSegmentIndex ?? 0;
                                if (!branchElementIdsByBranchIndex.TryGetValue(branchIndex, out var branchElementIds))
                                    throw new InvalidOperationException($"Accessory host branch index {branchIndex} was not created.");
                                if (branchSegmentIndex < 0 || branchSegmentIndex >= branchElementIds.Count)
                                    throw new InvalidOperationException($"Accessory host branch {branchIndex} segment {branchSegmentIndex} was not created.");
                                hostId = branchElementIds[branchSegmentIndex];
                            }
                            else
                            {
                                throw new InvalidOperationException("Accessory insert hostKind must be main or branch.");
                            }

                            var hostElement = doc.GetElement(ElementIdCompat.Create(hostId));
                            if (!HostMatchesRouteKind(hostElement, routeKind))
                                throw new InvalidOperationException($"Accessory host element {hostId} is not a {routeKind} curve.");
                            result.HostElementId = hostId;

                            var symbol = doc.GetElement(ElementIdCompat.Create(plan.familySymbolId.Value)) as FamilySymbol;
                            if (symbol == null)
                                throw new InvalidOperationException($"Accessory FamilySymbol {plan.familySymbolId.Value} was not found.");
                            if (!symbol.IsActive)
                            {
                                symbol.Activate();
                                doc.Regenerate();
                            }

                            var point = ReadPointObject(plan.resolvedPoint);
                            if (point == null)
                                throw new InvalidOperationException("Accessory plan has no resolved insertion point.");

                            var instance = doc.Create.NewFamilyInstance(point, symbol, hostElement, StructuralType.NonStructural);
                            doc.Regenerate();
                            var id = ElementIdCompat.GetValue(instance.Id);
                            result.CreatedElementIds.Add(id);
                            result.Ok = true;
                            result.Status = string.Equals(routeKind, "pipe", StringComparison.OrdinalIgnoreCase)
                                ? "CreatedPipeAccessory"
                                : "CreatedDuctAccessory";
                        }
                        else if (action == "delete" || action == "remove")
                        {
                            if (plan.targetElementIds.Count == 0)
                                throw new InvalidOperationException("Accessory delete has no target ids.");
                            foreach (var id in plan.targetElementIds.Distinct())
                            {
                                var target = doc.GetElement(ElementIdCompat.Create(id));
                                if (target == null)
                                    throw new InvalidOperationException($"Accessory target {id} was not found.");
                                var deleted = doc.Delete(target.Id)
                                    .Select(ElementIdCompat.GetValue)
                                    .Where(x => x > 0)
                                    .ToList();
                                result.DeletedElementIds.AddRange(deleted);
                            }
                            result.Ok = true;
                            result.Status = "DeletedAccessory";
                        }
                        else if (action == "type_change" || action == "change_type")
                        {
                            if (plan.targetElementIds.Count == 0)
                                throw new InvalidOperationException("Accessory type-change has no target ids.");
                            if (!plan.targetTypeId.HasValue)
                                throw new InvalidOperationException("Accessory type-change has no resolved target type id.");

                            var newTypeId = ElementIdCompat.Create(plan.targetTypeId.Value);
                            foreach (var id in plan.targetElementIds.Distinct())
                            {
                                var target = doc.GetElement(ElementIdCompat.Create(id));
                                if (target == null)
                                    throw new InvalidOperationException($"Accessory target {id} was not found.");
                                var oldTypeId = ElementIdCompat.GetValue(target.GetTypeId());
                                if (!CanChangeElementToType(target, newTypeId))
                                    throw new InvalidOperationException($"Accessory target {id} cannot change to type {plan.targetTypeId.Value}.");
                                target.ChangeTypeId(newTypeId);
                                result.ChangedElementIds.Add(id);
                                result.TypeChanges.Add(new { elementId = id, previousTypeId = oldTypeId, newTypeId = plan.targetTypeId.Value });
                            }
                            doc.Regenerate();
                            result.Ok = true;
                            result.Status = "ChangedAccessoryType";
                        }
                        else
                        {
                            throw new InvalidOperationException($"Unsupported accessory action '{plan.action}'.");
                        }
                    }
                    catch (Exception ex)
                    {
                        result.Ok = false;
                        result.Status = "Failed";
                        result.Error = ex.Message;
                        warnings.Add($"Accessory {plan.index} failed: {ex.Message}");
                    }
                    results.Add(result);
                }

                if (results.Any(x => !x.Ok))
                {
                    tx.RollBack();
                    foreach (var result in results)
                    {
                        result.CreatedElementIds.Clear();
                        result.DeletedElementIds.Clear();
                        result.ChangedElementIds.Clear();
                        result.TypeChanges.Clear();
                    }
                }
                else
                {
                    tx.Commit();
                    try { doc.Regenerate(); } catch { }
                    try { app.ActiveUIDocument?.RefreshActiveView(); } catch { }
                }
            }

            return results;
        }

        private static object TryDeleteCreatedElements(Document doc, List<long> ids)
        {
            var deleted = new List<long>();
            var missing = new List<long>();
            var failed = new List<object>();
            if (ids.Count == 0)
            {
                return new { attempted = false, deletedElementIds = deleted, missingElementIds = missing, failed };
            }

            using (var tx = new Transaction(doc, "Cleanup Failed MEP Network Accessory Apply"))
            {
                tx.Start();
                foreach (var id in ids.Distinct())
                {
                    try
                    {
                        var elem = doc.GetElement(ElementIdCompat.Create(id));
                        if (elem == null)
                        {
                            missing.Add(id);
                            continue;
                        }

                        var deletedIds = doc.Delete(elem.Id)
                            .Select(ElementIdCompat.GetValue)
                            .Where(x => x > 0)
                            .ToList();
                        deleted.AddRange(deletedIds);
                    }
                    catch (Exception ex)
                    {
                        failed.Add(new { elementId = id, error = ex.Message });
                    }
                }

                if (failed.Count > 0)
                {
                    tx.RollBack();
                    return new { attempted = true, committed = false, deletedElementIds = new List<long>(), missingElementIds = missing, failed };
                }

                tx.Commit();
            }

            return new { attempted = true, committed = true, deletedElementIds = deleted.Distinct().OrderBy(x => x).ToList(), missingElementIds = missing.Distinct().OrderBy(x => x).ToList(), failed };
        }

        private static FamilySymbol? ResolveDuctAccessorySymbol(Document doc, AccessorySpec spec)
        {
            if (spec.familySymbolId.HasValue && spec.familySymbolId.Value != 0)
                return doc.GetElement(ElementIdCompat.Create(spec.familySymbolId.Value)) as FamilySymbol;

            var family = (spec.familyName ?? "").Trim();
            var type = (spec.typeName ?? "").Trim();
            return new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .Where(s => ElementIdCompat.GetValue(s.Category?.Id) == (long)BuiltInCategory.OST_DuctAccessory)
                .Where(s => family.Length == 0 || (s.FamilyName ?? "").IndexOf(family, StringComparison.OrdinalIgnoreCase) >= 0)
                .Where(s => type.Length == 0 || (s.Name ?? "").IndexOf(type, StringComparison.OrdinalIgnoreCase) >= 0)
                .OrderBy(s => string.Equals(s.FamilyName, family, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ThenBy(s => string.Equals(s.Name, type, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .FirstOrDefault();
        }

        private static FamilySymbol? ResolveAccessorySymbolForRouteKind(Document doc, string routeKind, AccessorySpec spec)
        {
            var requestedTypeId = spec.typeId ?? spec.familySymbolId;
            if (requestedTypeId.HasValue && requestedTypeId.Value != 0)
                return doc.GetElement(ElementIdCompat.Create(requestedTypeId.Value)) as FamilySymbol;

            var family = (spec.familyName ?? "").Trim();
            var type = (spec.targetTypeName ?? spec.typeName ?? "").Trim();
            var category = AccessoryCategoryForRouteKind(routeKind);
            if (!category.HasValue) return null;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .Where(s => ElementIdCompat.GetValue(s.Category?.Id) == (long)category.Value)
                .Where(s => family.Length == 0 || (s.FamilyName ?? "").IndexOf(family, StringComparison.OrdinalIgnoreCase) >= 0)
                .Where(s => type.Length == 0 || (s.Name ?? "").IndexOf(type, StringComparison.OrdinalIgnoreCase) >= 0)
                .OrderBy(s => string.Equals(s.FamilyName, family, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ThenBy(s => string.Equals(s.Name, type, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .FirstOrDefault();
        }

        private static List<Element> ResolveAccessoryTargets(Document doc, string routeKind, AccessorySpec spec, AccessoryPlan plan)
        {
            var ids = new List<long>();
            if (spec.targetElementId.HasValue && spec.targetElementId.Value != 0) ids.Add(spec.targetElementId.Value);
            if (spec.targetElementIds != null) ids.AddRange(spec.targetElementIds.Where(x => x != 0));
            ids = ids.Distinct().ToList();
            if (ids.Count == 0) return new List<Element>();

            var expectedCategory = AccessoryCategoryForRouteKind(routeKind);
            if (!expectedCategory.HasValue)
            {
                plan.blockCode = "accessory_route_kind_not_supported";
                plan.blockReason = "Accessory delete/type-change supports duct or pipe route kinds only.";
                return new List<Element>();
            }

            var targets = new List<Element>();
            var missing = new List<long>();
            var wrongCategory = new List<object>();
            foreach (var id in ids)
            {
                var element = doc.GetElement(ElementIdCompat.Create(id));
                if (element == null)
                {
                    missing.Add(id);
                    continue;
                }

                var catId = ElementIdCompat.GetValue(element.Category?.Id);
                if (catId != (long)expectedCategory.Value)
                {
                    wrongCategory.Add(new { elementId = id, categoryId = catId, categoryName = element.Category?.Name });
                    continue;
                }

                targets.Add(element);
            }

            if (missing.Count > 0)
            {
                plan.blockCode = "accessory_target_not_found";
                plan.blockReason = "One or more accessory target ids were not found: " + string.Join(", ", missing);
                return new List<Element>();
            }

            if (wrongCategory.Count > 0)
            {
                plan.blockCode = "accessory_target_wrong_category";
                plan.blockReason = $"All accessory targets must be {expectedCategory.Value} elements for route kind '{routeKind}'.";
                plan.targetElements = wrongCategory;
                return new List<Element>();
            }

            return targets;
        }

        private static BuiltInCategory? AccessoryCategoryForRouteKind(string routeKind)
        {
            if (string.Equals(routeKind, "duct", StringComparison.OrdinalIgnoreCase)) return BuiltInCategory.OST_DuctAccessory;
            if (string.Equals(routeKind, "pipe", StringComparison.OrdinalIgnoreCase)) return BuiltInCategory.OST_PipeAccessory;
            return null;
        }

        private static bool HostMatchesRouteKind(Element? element, string? routeKind)
        {
            if (element == null) return false;
            if (string.Equals(routeKind, "duct", StringComparison.OrdinalIgnoreCase)) return element is Duct;
            if (string.Equals(routeKind, "pipe", StringComparison.OrdinalIgnoreCase)) return element is Pipe;
            return false;
        }

        private static bool CanChangeElementToType(Element element, ElementId typeId)
        {
            if (typeId == null || typeId == ElementId.InvalidElementId) return false;
            try
            {
                var validTypes = element.GetValidTypes();
                if (validTypes != null && validTypes.Count > 0)
                    return validTypes.Contains(typeId);
            }
            catch { }

            return ElementIdCompat.GetValue(element.GetTypeId()) == ElementIdCompat.GetValue(typeId);
        }

        private static object ToElementSummary(Element element) => new
        {
            elementId = ElementIdCompat.GetValue(element.Id),
            categoryId = ElementIdCompat.GetValue(element.Category?.Id),
            categoryName = element.Category?.Name,
            name = element.Name,
            typeId = ElementIdCompat.GetValue(element.GetTypeId())
        };

        private static object BuildNetworkPlan(List<XYZ> mainResolved, List<object> branchPlans, List<AccessoryPlan> accessoryPlans) => new
        {
            main = new
            {
                points = mainResolved.Select(ToPointObject).ToList(),
                segmentCount = Math.Max(0, mainResolved.Count - 1),
                totalLengthFt = mainResolved.Count < 2 ? 0.0 : Enumerable.Range(0, mainResolved.Count - 1).Sum(i => mainResolved[i].DistanceTo(mainResolved[i + 1]))
            },
            branches = branchPlans,
            accessories = accessoryPlans
        };

        private static CreateMepRouteHandler.Params ToCreateMainParams(Params p, string kind, bool dryRun) => new CreateMepRouteHandler.Params
        {
            kind = kind,
            frameId = p.frameId,
            points = p.mainPoints ?? new List<MepRoutingUtil.RoutePoint>(),
            viewId = p.viewId,
            roomNumber = p.roomNumber,
            levelName = p.levelName,
            levelId = p.levelId,
            systemType = p.systemType,
            ductType = p.ductType,
            pipeType = p.pipeType,
            ductSize = p.ductSize,
            diameter = p.diameter,
            pipeSize = p.pipeSize,
            segmentSizes = p.mainSegmentSizes,
            sizePolicy = p.sizePolicy,
            elevationPolicy = p.elevationPolicy,
            routingMode = p.routingMode,
            connectSegments = true,
            verify = p.verify,
            dryRun = dryRun,
            defaultOffsetFt = p.defaultOffsetFt,
            ceilingOffsetFt = p.ceilingOffsetFt
        };

        private static ConnectMepBranchHandler.Params ToBranchParams(Params p, string kind, BranchSpec branch, long mainElementId, bool dryRun) => new ConnectMepBranchHandler.Params
        {
            kind = kind,
            mainElementId = mainElementId,
            branchPoints = BuildBranchRoutePoints(branch),
            branchSize = branch.branchSize,
            branchSegmentSizes = branch.branchSegmentSizes,
            connectionMode = branch.connectionMode,
            existingBranchAnchorElementId = branch.existingBranchAnchorElementId,
            frameId = p.frameId,
            viewId = p.viewId,
            roomNumber = p.roomNumber,
            levelName = p.levelName,
            levelId = p.levelId,
            dryRun = dryRun,
            verify = p.verify,
            visualVerify = false,
            visualViewId = p.visualViewId,
            imageSize = p.imageSize,
            focusPaddingFt = p.focusPaddingFt
        };

        private static List<MepRoutingUtil.RoutePoint> BuildBranchRoutePoints(BranchSpec branch)
        {
            var points = new List<MepRoutingUtil.RoutePoint>();
            if (branch.connectionPoint != null) points.Add(branch.connectionPoint);
            if (branch.points != null) points.AddRange(branch.points);
            return points;
        }

        private static List<string?> BuildBranchSegmentSizeTexts(BranchSpec branch, int segmentCount)
        {
            var result = new List<string?>();
            for (var i = 0; i < segmentCount; i++)
            {
                if (branch.branchSegmentSizes != null && i < branch.branchSegmentSizes.Count && !string.IsNullOrWhiteSpace(branch.branchSegmentSizes[i]))
                    result.Add(branch.branchSegmentSizes[i]);
                else
                    result.Add(branch.branchSize);
            }
            return result;
        }

        private static object TryExportVisual(UIApplication app, Params p, List<long> mainIds, List<long> splitMainIds, List<long> branchIds, List<long> fittingIds, List<long> accessoryIds, List<long> allIds)
        {
            try
            {
                var groups = new List<HighlightAndExportHandler.HighlightGroup>();
                if (mainIds.Count > 0)
                    groups.Add(new HighlightAndExportHandler.HighlightGroup { name = "main_segments", elementIds = mainIds, overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 7, r = 80, g = 180, b = 80 } });
                if (splitMainIds.Count > 0)
                    groups.Add(new HighlightAndExportHandler.HighlightGroup { name = "split_main_segments", elementIds = splitMainIds, overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 7, r = 60, g = 220, b = 120 } });
                if (branchIds.Count > 0)
                    groups.Add(new HighlightAndExportHandler.HighlightGroup { name = "branch_segments", elementIds = branchIds, overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 8, r = 0, g = 180, b = 255 } });
                if (fittingIds.Count > 0)
                    groups.Add(new HighlightAndExportHandler.HighlightGroup { name = "fittings", elementIds = fittingIds, overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 9, r = 255, g = 140, b = 0 } });
                if (accessoryIds.Count > 0)
                    groups.Add(new HighlightAndExportHandler.HighlightGroup { name = "accessories", elementIds = accessoryIds, overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 10, r = 220, g = 70, b = 220 } });

                var capture = Invoke(new HighlightAndExportHandler(), app, new HighlightAndExportHandler.Params
                {
                    viewId = p.visualViewId ?? p.viewId,
                    elementIds = allIds,
                    focusElementIds = branchIds.Count > 0 ? branchIds : allIds,
                    imageSize = Math.Max(512, Math.Min(4096, p.imageSize)),
                    focusPaddingFt = Math.Max(0.5, Math.Min(100.0, p.focusPaddingFt)),
                    highlightGroups = groups
                });
                var captureJson = ToElement(capture);
                return new { status = "CaptureReadyForAIReview", capture, capturePath = ReadString(captureJson, "path") };
            }
            catch (Exception ex)
            {
                return new { status = "CaptureFailed", error = ex.Message };
            }
        }

        private static XYZ? ReadPointObject(object? value)
        {
            if (value == null) return null;
            var json = JsonSerializer.Serialize(value);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("x", out var x) || !root.TryGetProperty("y", out var y) || !root.TryGetProperty("z", out var z)) return null;
            return new XYZ(x.GetDouble(), y.GetDouble(), z.GetDouble());
        }

        private static string[] BuildExecutionOrder(int branchCount, int accessoryCount, bool applied, bool visualAttempted)
        {
            var steps = new List<string> { "resolve-routing-context", "dry-run-main-route", "plan-branch-network" };
            if (applied)
            {
                steps.Add("apply-main-route");
                for (var i = 0; i < branchCount; i++) steps.Add($"apply-branch-{i}");
            }
            if (accessoryCount > 0) steps.Add(applied ? "apply-supported-accessory-graph-nodes" : "plan-accessory-graph-nodes");
            if (visualAttempted) steps.Add("highlight-created-network-and-export-focused-post-change-image");
            return steps.ToArray();
        }

        private static object Invoke(IRequestHandler handler, UIApplication app, object payload)
        {
            var json = JsonSerializer.Serialize(payload);
            return handler.Handle(app, json).GetAwaiter().GetResult();
        }

        private static bool IsBlocked(string status) =>
            status.Equals("Blocked", StringComparison.OrdinalIgnoreCase) ||
            status.Equals("Failed", StringComparison.OrdinalIgnoreCase);

        private static JsonElement ToElement(object value)
        {
            var json = JsonSerializer.Serialize(value);
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.Clone();
        }

        private static string ReadString(JsonElement obj, string name)
        {
            if (obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
                return value.GetString() ?? "";
            return "";
        }

        private static bool ReadBool(JsonElement obj, string name)
        {
            if (obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var value) && (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False))
                return value.GetBoolean();
            return false;
        }

        private static List<long> ReadLongArray(JsonElement obj, string name)
        {
            if (obj.ValueKind != JsonValueKind.Object || !obj.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
                return new List<long>();

            var result = new List<long>();
            foreach (var item in value.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out var id))
                    result.Add(id);
            }
            return result;
        }

        private static List<string> ReadStringArray(JsonElement obj, string name)
        {
            if (obj.ValueKind != JsonValueKind.Object || !obj.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
                return new List<string>();

            var result = new List<string>();
            foreach (var item in value.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String)
                    result.Add(item.GetString() ?? "");
            }
            return result.Where(x => !string.IsNullOrWhiteSpace(x)).ToList();
        }

        private static object ToPointObject(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
    }
}

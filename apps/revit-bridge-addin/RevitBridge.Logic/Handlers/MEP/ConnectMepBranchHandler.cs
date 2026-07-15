using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class ConnectMepBranchHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string kind { get; set; } = "duct";
            public long mainElementId { get; set; }
            public List<MepRoutingUtil.RoutePoint> branchPoints { get; set; } = new List<MepRoutingUtil.RoutePoint>();
            public string? branchSize { get; set; }
            public List<string>? branchSegmentSizes { get; set; }
            public string? branchSystemType { get; set; }
            public string? branchPipeType { get; set; }
            public string? connectionMode { get; set; } = "auto";
            public string? frameId { get; set; }
            public long? viewId { get; set; }
            public string? roomNumber { get; set; }
            public string? levelName { get; set; }
            public long? levelId { get; set; }
            public bool dryRun { get; set; } = true;
            public bool verify { get; set; } = true;
            public bool visualVerify { get; set; } = true;
            public long? visualViewId { get; set; }
            public int imageSize { get; set; } = 2200;
            public double focusPaddingFt { get; set; } = 4.0;
            public string? takeoffFamilyName { get; set; }
            public string? takeoffTypeName { get; set; }
            public string? teeFamilyName { get; set; }
            public string? teeTypeName { get; set; }
            public string? transitionFamilyName { get; set; }
            public string? transitionTypeName { get; set; }
            public long? existingBranchAnchorElementId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();

            var warnings = new List<string>();
            if (p.mainElementId <= 0)
            {
                return Task.FromResult<object>(new { status = "Blocked", error = "mainElementId is required.", warnings });
            }
            if (p.branchPoints == null || p.branchPoints.Count < 2)
            {
                return Task.FromResult<object>(new { status = "Blocked", error = "At least two branchPoints are required.", warnings });
            }

            var doc = app.ActiveUIDocument.Document;
            var main = doc.GetElement(ElementIdCompat.Create(p.mainElementId));
            if (main == null)
            {
                return Task.FromResult<object>(new { status = "Blocked", error = $"Element {p.mainElementId} was not found.", warnings });
            }

            var kind = MepRoutingUtil.NormalizeKind(p.kind);
            var requestedConnectionMode = NormalizeConnectionMode(p.connectionMode);
            var explicitPipeBranchOverride = !string.IsNullOrWhiteSpace(p.branchSystemType)
                || !string.IsNullOrWhiteSpace(p.branchPipeType);
            if (explicitPipeBranchOverride && kind != "pipe")
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    error = "branchSystemType and branchPipeType are supported only for pipe branches.",
                    warnings
                });
            }
            if (explicitPipeBranchOverride && requestedConnectionMode != "tee")
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    error = "An explicit pipe branch system/type override requires connectionMode:\"tee\" so the request cannot fall back to an open connector or tap path.",
                    warnings
                });
            }
            var explicitBranchSystemType = string.IsNullOrWhiteSpace(p.branchSystemType)
                ? null
                : MepRoutingUtil.FindSystemType(doc, p.branchSystemType, "pipe");
            var explicitBranchPipeType = string.IsNullOrWhiteSpace(p.branchPipeType)
                ? null
                : MepRoutingUtil.FindPipeType(doc, p.branchPipeType);
            if (!string.IsNullOrWhiteSpace(p.branchSystemType) && explicitBranchSystemType == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    error = $"Could not resolve explicit pipe branch system type '{p.branchSystemType}'.",
                    warnings
                });
            }
            if (!string.IsNullOrWhiteSpace(p.branchPipeType) && explicitBranchPipeType == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    error = $"Could not resolve explicit pipe branch pipe type '{p.branchPipeType}'.",
                    warnings
                });
            }
            var mainCategory = main.Category?.Name ?? "";
            var isMainKind =
                (kind == "duct" && main.Category != null && ElementIdCompat.GetValue(main.Category.Id) == (int)BuiltInCategory.OST_DuctCurves) ||
                (kind == "pipe" && main.Category != null && ElementIdCompat.GetValue(main.Category.Id) == (int)BuiltInCategory.OST_PipeCurves);
            if (!isMainKind)
            {
                warnings.Add($"mainElementId category is '{mainCategory}', not the expected {kind} curve category.");
            }

            var ctx = MepRoutingUtil.ResolveRoutingContext(doc, app, new MepRoutingUtil.RoutingContextRequest
            {
                viewId = p.viewId,
                roomNumber = p.roomNumber,
                levelName = p.levelName,
                levelId = p.levelId,
                systemKind = kind,
                dryRun = true
            });
            warnings.AddRange(ctx.Warnings);

            var branch = p.branchPoints.Select(x => MepRoutingUtil.ResolveRoutePoint(x, p.frameId, ctx.RecommendedZ, out _)).ToList();
            var branchStart = branch[0];
            var branchSegmentSizeTexts = BuildBranchSegmentSizeTexts(p, Math.Max(0, branch.Count - 1));
            var branchJointPlans = MepRouteJointPlanner.PlanJoints(branchSegmentSizeTexts);
            var mainCurveType = GetMepCurveType(main, kind);
            var takeoffPreference = DescribeTakeoffRoutingPreference(doc, mainCurveType, kind, p.takeoffFamilyName, p.takeoffTypeName);
            var pipeTapHasExplicitTakeoffPreference = kind != "pipe" || HasExplicitTakeoffRoutingPreference(doc, mainCurveType);

            var location = main.Location as LocationCurve;
            XYZ? nearestPoint = null;
            double? distanceToMain = null;
            double? normalizedParameter = null;
            XYZ? mainStart = null;
            XYZ? mainEnd = null;
            object? splitPlan = null;
            BranchSplitPrecheck splitPrecheck = BranchSplitPrecheck.Blocked("not_evaluated", "Split planning was not evaluated.");
            if (location?.Curve != null)
            {
                try
                {
                    if (location.Curve.IsBound)
                    {
                        mainStart = location.Curve.GetEndPoint(0);
                        mainEnd = location.Curve.GetEndPoint(1);
                    }
                    var projection = location.Curve.Project(branchStart);
                    if (projection != null)
                    {
                        nearestPoint = projection.XYZPoint;
                        distanceToMain = branchStart.DistanceTo(nearestPoint);
                        normalizedParameter = projection.Parameter;
                    }
                    splitPrecheck = BranchSplitPlanner.PlanDuctLineSplit(kind, main, location.Curve, branchStart, branch, nearestPoint, distanceToMain, requestedConnectionMode);
                    splitPlan = splitPrecheck.ToResponse();
                }
                catch (Exception ex)
                {
                    warnings.Add($"Could not project branch start to main curve: {ex.Message}");
                }
            }

            else
            {
                warnings.Add("Main element does not expose a LocationCurve; split/tee planning is not available for this element.");
            }

            var existingBranchAnchorPlan = PlanExistingBranchAnchor(
                doc,
                main,
                kind,
                p.existingBranchAnchorElementId,
                splitPrecheck.SplitPoint,
                branch.Count > 1 ? branch[1] : null,
                p.branchSize,
                warnings);

            var connectors = MepRoutingUtil.GetConnectors(main);
            var nearestConnector = MepRoutingUtil.FindClosestConnector(connectors, branchStart, 0.5);
            var nearestConnectorDistance = nearestConnector == null ? (double?)null : nearestConnector.Origin.DistanceTo(branchStart);
            var nearestConnectorOpen = false;
            if (nearestConnector != null)
            {
                try { nearestConnectorOpen = !nearestConnector.IsConnected; } catch { nearestConnectorOpen = false; }
            }

            var retainedAnchorModeSupported = !existingBranchAnchorPlan.Requested
                || MepExistingBranchAnchorPlanner.SupportsConnectionMode(requestedConnectionMode);
            var feasibleExistingConnector = !existingBranchAnchorPlan.Requested
                && nearestConnector != null
                && nearestConnectorOpen
                && nearestConnectorDistance.GetValueOrDefault(999) <= 0.25;
            var feasibleTap = !existingBranchAnchorPlan.Requested
                && splitPrecheck.ApplySupported
                && requestedConnectionMode == "tap"
                && pipeTapHasExplicitTakeoffPreference;
            var feasibleSplitTee = splitPrecheck.ApplySupported
                && requestedConnectionMode != "tap"
                && retainedAnchorModeSupported
                && (!existingBranchAnchorPlan.Requested || existingBranchAnchorPlan.ApplySupported);
            var status = p.dryRun
                ? "Dry Run"
                : (feasibleExistingConnector
                    ? "CreatedWithOpenConnectors"
                    : (feasibleTap
                        ? "CreatedWithTapTakeoff"
                        : (feasibleSplitTee
                            ? (existingBranchAnchorPlan.Requested ? "CreatedWithRetainedBranchAnchor" : "CreatedWithSplitTee")
                            : "Blocked")));
            var nextStep = splitPrecheck.BlockReason;
            if (existingBranchAnchorPlan.Requested && !retainedAnchorModeSupported)
                nextStep = "existingBranchAnchorElementId requires connectionMode:\"tee\"; retained anchors never fall back to an open-main or tap/takeoff path.";
            else if (feasibleExistingConnector)
                nextStep = "Safe apply path is available because the branch starts at an existing open main connector.";
            else if (feasibleTap)
                nextStep = $"Safe {kind} tap/takeoff apply path is available for this projected non-connector branch point.";
            else if (requestedConnectionMode == "tap" && splitPrecheck.ApplySupported && kind == "pipe" && !pipeTapHasExplicitTakeoffPreference)
                nextStep = "Pipe tap/takeoff apply is blocked because the selected pipe type does not expose an explicit tap/takeoff routing preference. Use connectionMode:\"tee\" for a split tee, or choose a pipe type with a takeoff/tap routing preference.";
            else if (existingBranchAnchorPlan.Requested && !existingBranchAnchorPlan.ApplySupported)
                nextStep = existingBranchAnchorPlan.BlockReason;
            else if (existingBranchAnchorPlan.Requested && existingBranchAnchorPlan.ApplySupported)
                nextStep = "Safe split/tee apply can reuse the retained two-connector branch anchor without creating a duplicate transition or reducer.";
            else if (feasibleSplitTee)
                nextStep = $"Safe {kind} split/tee apply path is available for this projected non-connector branch point.";

            if (!p.dryRun && !feasibleExistingConnector && !feasibleTap && !feasibleSplitTee)
            {
                warnings.Add($"Apply mode is guarded for this case: {nextStep}");
            }

            var createdBranchIds = new List<long>();
            var createdFittingIds = new List<long>();
            var splitMainSegmentIds = new List<long>();
            long? splitMainStartSegmentId = null;
            long? splitMainEndSegmentId = null;
            var connectionAttempts = new List<object>();
            var openConnectorCount = (int?)null;
            var rolledBack = false;
            object? connectedNetworkAudit = null;
            object? focusedCapture = null;

            if (!p.dryRun && feasibleExistingConnector && nearestConnector != null)
            {
                using (var tx = new Transaction(doc, "Connect MEP Branch"))
                {
                    tx.Start();
                    try
                    {
                        var snapped = new List<XYZ>(branch);
                        snapped[0] = nearestConnector.Origin;

                        var branchElements = new List<Element>();
                        for (var i = 0; i < snapped.Count - 1; i++)
                        {
                            var a = snapped[i];
                            var b = snapped[i + 1];
                            if (a.DistanceTo(b) <= 1e-6) throw new InvalidOperationException($"Branch segment {i + 1} has zero length after snapping to connector.");
                            var sizeWarnings = new List<string>();
                            var requestedSize = GetBranchSegmentSizeText(p, i);
                            var size = MepRoutingUtil.ChooseSize(kind, requestedSize, requestedSize, requestedSize, "use_default_with_warning", sizeWarnings);
                            warnings.AddRange(sizeWarnings);

                            Element curve;
                            object sizeApplied;
                            if (kind == "pipe")
                            {
                                var pipeTypeId = explicitBranchPipeType?.Id
                                    ?? (main is Pipe mainPipe ? mainPipe.PipeType.Id : (MepRoutingUtil.FindPipeType(doc, null)?.Id ?? ElementId.InvalidElementId));
                                var systemTypeId = explicitBranchSystemType?.Id ?? ResolveMainSystemTypeId(doc, main, "pipe");
                                var levelId = ResolveLevelId(doc, main, ctx.Level, a.Z);
                                if (pipeTypeId == ElementId.InvalidElementId || systemTypeId == ElementId.InvalidElementId || levelId == ElementId.InvalidElementId)
                                    throw new InvalidOperationException("Could not resolve pipe branch system/type/level from the main element.");

                                var pipe = Pipe.Create(doc, systemTypeId, pipeTypeId, levelId, a, b);
                                MepRoutingUtil.TryApplyPipeSize(pipe, size, out sizeApplied);
                                curve = pipe;
                            }
                            else
                            {
                                var fallbackDuctTypeId = main is Duct mainDuct ? mainDuct.DuctType.Id : (MepRoutingUtil.FindDuctType(doc, null)?.Id ?? ElementId.InvalidElementId);
                                var ductTypeId = ResolveDuctTypeIdForSize(doc, size, fallbackDuctTypeId);
                                var systemTypeId = ResolveMainSystemTypeId(doc, main, "duct");
                                var levelId = ResolveLevelId(doc, main, ctx.Level, a.Z);
                                if (ductTypeId == ElementId.InvalidElementId || systemTypeId == ElementId.InvalidElementId || levelId == ElementId.InvalidElementId)
                                    throw new InvalidOperationException("Could not resolve duct branch system/type/level from the main element.");

                                var duct = Duct.Create(doc, systemTypeId, ductTypeId, levelId, a, b);
                                MepRoutingUtil.TryApplyDuctSize(duct, size, out sizeApplied);
                                curve = duct;
                            }

                            branchElements.Add(curve);
                            createdBranchIds.Add(ElementIdCompat.GetValue(curve.Id));
                        }

                        doc.Regenerate();

                        if (branchElements.Count > 0)
                        {
                            var firstConnector = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[0]), snapped[0], 0.25);
                            var ok = MepRoutingUtil.TryCreateElbowOrConnect(doc, nearestConnector, firstConnector, out var fittingId, out var method, out var err);
                            if (fittingId.HasValue) createdFittingIds.Add(fittingId.Value);
                            connectionAttempts.Add(new
                            {
                                connection = "main_to_branch",
                                mainElementId = p.mainElementId,
                                branchElementId = createdBranchIds.FirstOrDefault(),
                                connected = ok,
                                method,
                                fittingId,
                                error = err
                            });
                        }

                        for (var i = 0; i < branchElements.Count - 1; i++)
                        {
                            var shared = snapped[i + 1];
                            var a = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[i]), shared, 0.25);
                            var b = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[i + 1]), shared, 0.25);
                            var jointPlan = branchJointPlans.FirstOrDefault(j => j.JointIndex == i);
                            var expectTransition = string.Equals(jointPlan?.ExpectedFitting, "transition", StringComparison.OrdinalIgnoreCase);
                            var ok = TryCreateTransitionElbowOrConnect(doc, doc.GetElement(main.GetTypeId()) as ElementType, kind, a, b, expectTransition,
                                p.transitionFamilyName, p.transitionTypeName, out var fittingId, out var method, out var err);
                            if (fittingId.HasValue) createdFittingIds.Add(fittingId.Value);
                            connectionAttempts.Add(new
                            {
                                connection = "branch_internal",
                                fromSegment = i,
                                toSegment = i + 1,
                                expectedFitting = jointPlan?.ExpectedFitting ?? "elbow_or_connect",
                                fromSize = jointPlan?.FromSize,
                                toSize = jointPlan?.ToSize,
                                connected = ok,
                                method,
                                fittingId,
                                error = err
                            });
                        }

                        doc.Regenerate();
                        openConnectorCount = MepRoutingUtil.CountOpenConnectors(branchElements.Concat(new[] { main }));
                        if (connectionAttempts.Any(x => !TryReadConnected(x)))
                        {
                            warnings.Add("One or more branch connector/fitting attempts failed; inspect connectionAttempts before relying on the branch.");
                        }
                        if (openConnectorCount.GetValueOrDefault(0) > 0)
                        {
                            warnings.Add($"Connector verification found {openConnectorCount} open connector(s) across the main and created branch elements.");
                        }

                        var commitStatus = tx.Commit();
                        if (commitStatus != TransactionStatus.Committed)
                            throw new InvalidOperationException($"Branch connection transaction did not commit: {commitStatus}.");
                    }
                    catch (Exception ex)
                    {
                        try { tx.RollBack(); } catch { }
                        rolledBack = true;
                        return Task.FromResult<object>(new
                        {
                            status = "Blocked",
                            dryRun = false,
                            scaffoldOnly = false,
                            error = ex.Message,
                            kind,
                            mainElementId = p.mainElementId,
                            createdBranchElementIds = new List<long>(),
                            createdFittingIds = new List<long>(),
                            connectionAttempts,
                            warnings,
                            rolledBack = true
                        });
                    }
                }
            }
            else if (!p.dryRun && feasibleSplitTee && splitPrecheck.SplitPoint != null)
            {
                using (var tx = new Transaction(doc, "Connect MEP Branch Split Tee"))
                {
                    tx.Start();
                    try
                    {
                        var failures = new List<CapturedFailure>();
                        tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(tx, failures, rollbackOnErrors: true, deleteWarnings: false));

                        var snapped = new List<XYZ>(branch);
                        var retainedAnchor = existingBranchAnchorPlan.AnchorElement;
                        var retainedAnchorMainConnector = existingBranchAnchorPlan.MainConnector;
                        var retainedAnchorBranchConnector = existingBranchAnchorPlan.BranchConnector;
                        if (existingBranchAnchorPlan.Requested)
                        {
                            if (!existingBranchAnchorPlan.ApplySupported || retainedAnchor == null || retainedAnchorMainConnector == null || retainedAnchorBranchConnector == null)
                                throw new InvalidOperationException(existingBranchAnchorPlan.BlockReason ?? "The retained branch anchor did not pass apply preflight.");
                            snapped[0] = retainedAnchorBranchConnector.Origin;
                        }
                        else
                        {
                            snapped[0] = splitPrecheck.SplitPoint;
                        }

                        ElementId curveTypeId;
                        if (kind == "pipe")
                        {
                            if (!(main is Pipe mainPipe)) throw new InvalidOperationException("Safe split/tee apply for kind 'pipe' requires a pipe main.");
                            curveTypeId = explicitBranchPipeType?.Id ?? mainPipe.PipeType.Id;
                        }
                        else
                        {
                            if (!(main is Duct mainDuct)) throw new InvalidOperationException("Safe split/tee apply for kind 'duct' requires a duct main.");
                            curveTypeId = mainDuct.DuctType.Id;
                        }
                        var systemTypeId = explicitBranchSystemType?.Id ?? ResolveMainSystemTypeId(doc, main, kind);
                        var levelId = ResolveLevelId(doc, main, ctx.Level, snapped[0].Z);
                        if (curveTypeId == ElementId.InvalidElementId || systemTypeId == ElementId.InvalidElementId || levelId == ElementId.InvalidElementId)
                            throw new InvalidOperationException($"Could not resolve {kind} branch system/type/level from the main element.");

                        var newMainId = kind == "pipe"
                            ? PlumbingUtils.BreakCurve(doc, main.Id, splitPrecheck.SplitPoint)
                            : MechanicalUtils.BreakCurve(doc, main.Id, splitPrecheck.SplitPoint);
                        if (newMainId == ElementId.InvalidElementId)
                            throw new InvalidOperationException($"Revit did not return a valid {kind} segment id from BreakCurve.");

                        doc.Regenerate();
                        var firstMainSegment = doc.GetElement(main.Id) as MEPCurve;
                        var secondMainSegment = doc.GetElement(newMainId) as MEPCurve;
                        if (firstMainSegment == null || secondMainSegment == null)
                            throw new InvalidOperationException($"Could not resolve both {kind} main segments after split.");

                        splitMainSegmentIds.Add(ElementIdCompat.GetValue(firstMainSegment.Id));
                        splitMainSegmentIds.Add(ElementIdCompat.GetValue(secondMainSegment.Id));
                        splitMainStartSegmentId = FindSegmentContainingEndpoint(
                            new[] { firstMainSegment, secondMainSegment },
                            mainStart ?? throw new InvalidOperationException("The original main start point was not available after split."));
                        splitMainEndSegmentId = FindSegmentContainingEndpoint(
                            new[] { firstMainSegment, secondMainSegment },
                            mainEnd ?? throw new InvalidOperationException("The original main end point was not available after split."));
                        if (!splitMainStartSegmentId.HasValue || !splitMainEndSegmentId.HasValue)
                            throw new InvalidOperationException("Could not map the split main segments back to the original main start and end points.");

                        var branchElements = new List<Element>();
                        for (var i = 0; i < snapped.Count - 1; i++)
                        {
                            var a = snapped[i];
                            var b = snapped[i + 1];
                            if (a.DistanceTo(b) <= 1e-6) throw new InvalidOperationException($"Branch segment {i + 1} has zero length after snapping to split point.");
                            var sizeWarnings = new List<string>();
                            var requestedSize = GetBranchSegmentSizeText(p, i);
                            var size = MepRoutingUtil.ChooseSize(kind, requestedSize, requestedSize, requestedSize, "use_default_with_warning", sizeWarnings);
                            warnings.AddRange(sizeWarnings);

                            Element curve;
                            if (kind == "pipe")
                            {
                                var pipe = Pipe.Create(doc, systemTypeId, curveTypeId, levelId, a, b);
                                MepRoutingUtil.TryApplyPipeSize(pipe, size, out _);
                                curve = pipe;
                            }
                            else
                            {
                                var ductTypeId = ResolveDuctTypeIdForSize(doc, size, curveTypeId);
                                var duct = Duct.Create(doc, systemTypeId, ductTypeId, levelId, a, b);
                                MepRoutingUtil.TryApplyDuctSize(duct, size, out _);
                                curve = duct;
                            }
                            branchElements.Add(curve);
                            createdBranchIds.Add(ElementIdCompat.GetValue(curve.Id));
                        }

                        doc.Regenerate();

                        if (branchElements.Count == 0)
                            throw new InvalidOperationException($"No branch {kind} segments were created.");

                        var mainA = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(firstMainSegment), splitPrecheck.SplitPoint, 0.25);
                        var mainB = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(secondMainSegment), splitPrecheck.SplitPoint, 0.25);
                        Element? retainedAnchorTeeSeed = null;
                        Connector? teeBranchConnector;
                        if (existingBranchAnchorPlan.Requested && retainedAnchorMainConnector != null)
                        {
                            retainedAnchorTeeSeed = CreateRetainedAnchorTeeSeed(
                                doc,
                                kind,
                                systemTypeId,
                                curveTypeId,
                                levelId,
                                splitPrecheck.SplitPoint,
                                retainedAnchorMainConnector);
                            doc.Regenerate();
                            teeBranchConnector = MepRoutingUtil.FindClosestConnector(
                                MepRoutingUtil.GetConnectors(retainedAnchorTeeSeed),
                                splitPrecheck.SplitPoint,
                                0.25);
                        }
                        else
                        {
                            teeBranchConnector = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[0]), splitPrecheck.SplitPoint, 0.25);
                        }
                        var teeOk = TryCreateTeeFitting(
                            doc,
                            mainCurveType,
                            kind,
                            p.teeFamilyName,
                            p.teeTypeName,
                            mainA,
                            mainB,
                            teeBranchConnector,
                            out var teeFittingId,
                            out var teeMethod,
                            out var teeError);
                        if (teeFittingId.HasValue) createdFittingIds.Add(teeFittingId.Value);
                        connectionAttempts.Add(new
                        {
                            connection = "split_main_to_branch_tee",
                            mainSegmentIds = splitMainSegmentIds.ToList(),
                            branchElementId = createdBranchIds.FirstOrDefault(),
                            connected = teeOk,
                            method = teeMethod,
                            fittingId = teeFittingId,
                            requestedTee = new
                            {
                                familyName = string.IsNullOrWhiteSpace(p.teeFamilyName) ? null : p.teeFamilyName,
                                typeName = string.IsNullOrWhiteSpace(p.teeTypeName) ? null : p.teeTypeName
                            },
                            error = teeError
                        });
                        if (!teeOk)
                            throw new InvalidOperationException($"Could not create tee fitting at split point: {teeError ?? teeMethod}");

                        if (existingBranchAnchorPlan.Requested && retainedAnchorMainConnector != null && retainedAnchorBranchConnector != null)
                        {
                            if (!teeFittingId.HasValue || retainedAnchorTeeSeed == null)
                                throw new InvalidOperationException("Retained branch anchor tee creation did not return the temporary seed and tee fitting required for direct reconnection.");

                            doc.Regenerate();
                            var teeElement = doc.GetElement(ElementIdCompat.Create(teeFittingId.Value));
                            if (teeElement == null)
                                throw new InvalidOperationException("Could not resolve the temporary tee seed connection after creating the retained-anchor tee.");

                            var teeSeedConnection = FindPhysicalConnectionOwnedBy(retainedAnchorTeeSeed, teeElement.Id);
                            if (teeSeedConnection == null)
                                throw new InvalidOperationException("The temporary tee seed was not physically connected to the created tee.");
                            teeSeedConnection.Item1.DisconnectFrom(teeSeedConnection.Item2);
                            var deletedSeedIds = doc.Delete(retainedAnchorTeeSeed.Id);
                            if (deletedSeedIds.Any(id => id == teeElement.Id))
                                throw new InvalidOperationException("Removing the temporary tee seed unexpectedly deleted the created tee fitting.");
                            doc.Regenerate();

                            teeElement = doc.GetElement(ElementIdCompat.Create(teeFittingId.Value));
                            if (teeElement == null)
                                throw new InvalidOperationException("The created tee fitting did not survive temporary seed removal.");
                            var teeAnchorConnector = MepRoutingUtil.FindClosestConnector(
                                MepRoutingUtil.GetConnectors(teeElement),
                                retainedAnchorMainConnector.Origin,
                                0.25);
                            var teeAnchorConnected = MepRoutingUtil.TryConnect(teeAnchorConnector, retainedAnchorMainConnector, out var teeAnchorError);
                            connectionAttempts.Add(new
                            {
                                connection = "tee_to_retained_anchor",
                                teeFittingId,
                                retainedAnchorElementId = p.existingBranchAnchorElementId,
                                connected = teeAnchorConnected,
                                method = teeAnchorConnected ? "connector_connect_to" : "failed",
                                fittingId = (long?)null,
                                error = teeAnchorError
                            });
                            if (!teeAnchorConnected)
                                throw new InvalidOperationException($"Could not directly connect the created tee to the retained branch anchor: {teeAnchorError}");

                            var createdBranchConnector = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[0]), snapped[0], 0.25);
                            var anchorConnected = MepRoutingUtil.TryCreateElbowOrConnect(
                                doc,
                                retainedAnchorBranchConnector,
                                createdBranchConnector,
                                out var anchorConnectionFittingId,
                                out var anchorConnectionMethod,
                                out var anchorConnectionError);
                            connectionAttempts.Add(new
                            {
                                connection = "retained_anchor_to_branch",
                                retainedAnchorElementId = p.existingBranchAnchorElementId,
                                branchElementId = createdBranchIds.FirstOrDefault(),
                                connected = anchorConnected,
                                method = anchorConnectionMethod,
                                fittingId = anchorConnectionFittingId,
                                error = anchorConnectionError
                            });
                            if (!anchorConnected)
                                throw new InvalidOperationException($"Could not connect the retained branch anchor to the new branch: {anchorConnectionError ?? anchorConnectionMethod}");
                            if (anchorConnectionFittingId.HasValue)
                                throw new InvalidOperationException("Retained branch anchor connection created an unexpected extra fitting instead of a direct physical connection.");
                        }

                        for (var i = 0; i < branchElements.Count - 1; i++)
                        {
                            var shared = snapped[i + 1];
                            var a = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[i]), shared, 0.25);
                            var b = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[i + 1]), shared, 0.25);
                            var jointPlan = branchJointPlans.FirstOrDefault(j => j.JointIndex == i);
                            var expectTransition = string.Equals(jointPlan?.ExpectedFitting, "transition", StringComparison.OrdinalIgnoreCase);
                            var ok = TryCreateTransitionElbowOrConnect(doc, doc.GetElement(main.GetTypeId()) as ElementType, kind, a, b, expectTransition,
                                p.transitionFamilyName, p.transitionTypeName, out var fittingId, out var method, out var err);
                            if (fittingId.HasValue) createdFittingIds.Add(fittingId.Value);
                            connectionAttempts.Add(new
                            {
                                connection = "branch_internal",
                                fromSegment = i,
                                toSegment = i + 1,
                                expectedFitting = jointPlan?.ExpectedFitting ?? "elbow_or_connect",
                                fromSize = jointPlan?.FromSize,
                                toSize = jointPlan?.ToSize,
                                connected = ok,
                                method,
                                fittingId,
                                error = err
                            });
                            if (!ok)
                                throw new InvalidOperationException($"Could not connect branch segment {i + 1} to segment {i + 2}: {err ?? method}");
                        }

                        doc.Regenerate();
                        if (FailureHandlingUtil.HasErrors(failures))
                            throw new InvalidOperationException("Revit reported an error while creating the branch split/tee.");

                        if (explicitBranchSystemType != null)
                        {
                            var wrongSystem = branchElements
                                .OfType<Pipe>()
                                .FirstOrDefault(pipe => ElementIdCompat.GetValue(ResolveMainSystemTypeId(doc, pipe, "pipe"))
                                    != ElementIdCompat.GetValue(explicitBranchSystemType.Id));
                            if (wrongSystem != null)
                                throw new InvalidOperationException($"Created pipe branch did not retain explicit system type '{explicitBranchSystemType.Name}' after tee connection.");
                        }

                        var auditElements = branchElements.Concat(new Element[] { firstMainSegment, secondMainSegment });
                        if (retainedAnchor != null) auditElements = auditElements.Concat(new[] { retainedAnchor });
                        openConnectorCount = MepRoutingUtil.CountOpenConnectors(auditElements);
                        var commitStatus = tx.Commit();
                        if (commitStatus != TransactionStatus.Committed || FailureHandlingUtil.HasErrors(failures))
                        {
                            var failureText = string.Join(" | ", failures
                                .Where(failure => string.Equals(failure.severity, "error", StringComparison.OrdinalIgnoreCase)
                                    || string.Equals(failure.severity, "document_corruption", StringComparison.OrdinalIgnoreCase))
                                .Select(failure => failure.message)
                                .Where(message => !string.IsNullOrWhiteSpace(message)));
                            throw new InvalidOperationException($"Branch split/tee transaction did not commit: {commitStatus}{(string.IsNullOrWhiteSpace(failureText) ? "." : $": {failureText}")}");
                        }
                    }
                    catch (Exception ex)
                    {
                        try { tx.RollBack(); } catch { }
                        rolledBack = true;
                        return Task.FromResult<object>(new
                        {
                            status = "Blocked",
                            dryRun = false,
                            scaffoldOnly = false,
                            error = ex.Message,
                            kind,
                            mainElementId = p.mainElementId,
                            splitPlan,
                            splitMainSegmentIds = new List<long>(),
                            createdBranchElementIds = new List<long>(),
                            createdFittingIds = new List<long>(),
                            connectionAttempts,
                            warnings,
                            rolledBack = true
                        });
                    }
                }
            }
            else if (!p.dryRun && feasibleTap && splitPrecheck.SplitPoint != null)
            {
                using (var tx = new Transaction(doc, "Connect MEP Branch Tap Takeoff"))
                {
                    tx.Start();
                    try
                    {
                        var failures = new List<CapturedFailure>();
                        tx.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(tx, failures, rollbackOnErrors: true, deleteWarnings: false));

                        var snapped = new List<XYZ>(branch);
                        snapped[0] = splitPrecheck.SplitPoint;

                        if (!(main is MEPCurve mainCurve)) throw new InvalidOperationException("Safe tap/takeoff apply requires a duct or pipe main.");
                        var curveTypeId = GetMepCurveTypeId(main, kind);
                        var systemTypeId = ResolveMainSystemTypeId(doc, main, kind);
                        var levelId = ResolveLevelId(doc, main, ctx.Level, snapped[0].Z);
                        if (curveTypeId == ElementId.InvalidElementId || systemTypeId == ElementId.InvalidElementId || levelId == ElementId.InvalidElementId)
                            throw new InvalidOperationException($"Could not resolve {kind} branch system/type/level from the main element.");

                        var branchElements = new List<Element>();
                        for (var i = 0; i < snapped.Count - 1; i++)
                        {
                            var a = snapped[i];
                            var b = snapped[i + 1];
                            if (a.DistanceTo(b) <= 1e-6) throw new InvalidOperationException($"Branch segment {i + 1} has zero length after snapping to takeoff point.");
                            var sizeWarnings = new List<string>();
                            var requestedSize = GetBranchSegmentSizeText(p, i);
                            var size = MepRoutingUtil.ChooseSize(kind, requestedSize, requestedSize, requestedSize, "use_default_with_warning", sizeWarnings);
                            warnings.AddRange(sizeWarnings);

                            Element curve;
                            if (kind == "pipe")
                            {
                                var pipe = Pipe.Create(doc, systemTypeId, curveTypeId, levelId, a, b);
                                MepRoutingUtil.TryApplyPipeSize(pipe, size, out _);
                                curve = pipe;
                            }
                            else
                            {
                                var ductTypeId = ResolveDuctTypeIdForSize(doc, size, curveTypeId);
                                var duct = Duct.Create(doc, systemTypeId, ductTypeId, levelId, a, b);
                                MepRoutingUtil.TryApplyDuctSize(duct, size, out _);
                                curve = duct;
                            }
                            branchElements.Add(curve);
                            createdBranchIds.Add(ElementIdCompat.GetValue(curve.Id));
                        }

                        doc.Regenerate();

                        if (branchElements.Count == 0)
                            throw new InvalidOperationException($"No branch {kind} segments were created.");

                        var branchConnector = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[0]), splitPrecheck.SplitPoint, 0.25);
                        var takeoffOk = TryCreateTakeoffFitting(doc, branchConnector, mainCurve, out var takeoffFittingId, out var takeoffMethod, out var takeoffError);
                        var takeoffFitting = takeoffFittingId.HasValue ? doc.GetElement(ElementIdCompat.Create(takeoffFittingId.Value)) : null;
                        var takeoffDescription = DescribeFittingElement(doc, takeoffFitting);
                        if (takeoffOk && !TakeoffMatchesRequest(takeoffFitting, p.takeoffFamilyName, p.takeoffTypeName, out var takeoffMismatch))
                        {
                            takeoffOk = false;
                            takeoffMethod = "takeoff_type_mismatch";
                            takeoffError = takeoffMismatch;
                        }
                        if (takeoffFittingId.HasValue) createdFittingIds.Add(takeoffFittingId.Value);
                        connectionAttempts.Add(new
                        {
                            connection = "main_to_branch_takeoff",
                            mainElementId = p.mainElementId,
                            branchElementId = createdBranchIds.FirstOrDefault(),
                            connected = takeoffOk,
                            method = takeoffMethod,
                            fittingId = takeoffFittingId,
                            fitting = takeoffDescription,
                            requestedTakeoff = new
                            {
                                familyName = string.IsNullOrWhiteSpace(p.takeoffFamilyName) ? null : p.takeoffFamilyName,
                                typeName = string.IsNullOrWhiteSpace(p.takeoffTypeName) ? null : p.takeoffTypeName
                            },
                            routingPreference = takeoffPreference,
                            error = takeoffError
                        });
                        if (!takeoffOk)
                            throw new InvalidOperationException($"Could not create takeoff fitting at projected tap point: {takeoffError ?? takeoffMethod}");

                        for (var i = 0; i < branchElements.Count - 1; i++)
                        {
                            var shared = snapped[i + 1];
                            var a = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[i]), shared, 0.25);
                            var b = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[i + 1]), shared, 0.25);
                            var jointPlan = branchJointPlans.FirstOrDefault(j => j.JointIndex == i);
                            var expectTransition = string.Equals(jointPlan?.ExpectedFitting, "transition", StringComparison.OrdinalIgnoreCase);
                            var ok = TryCreateTransitionElbowOrConnect(doc, doc.GetElement(main.GetTypeId()) as ElementType, kind, a, b, expectTransition,
                                p.transitionFamilyName, p.transitionTypeName, out var fittingId, out var method, out var err);
                            if (fittingId.HasValue) createdFittingIds.Add(fittingId.Value);
                            connectionAttempts.Add(new
                            {
                                connection = "branch_internal",
                                fromSegment = i,
                                toSegment = i + 1,
                                expectedFitting = jointPlan?.ExpectedFitting ?? "elbow_or_connect",
                                fromSize = jointPlan?.FromSize,
                                toSize = jointPlan?.ToSize,
                                connected = ok,
                                method,
                                fittingId,
                                error = err
                            });
                            if (!ok)
                                throw new InvalidOperationException($"Could not connect branch segment {i + 1} to segment {i + 2}: {err ?? method}");
                        }

                        doc.Regenerate();
                        if (FailureHandlingUtil.HasErrors(failures))
                            throw new InvalidOperationException("Revit reported an error while creating the branch tap/takeoff.");

                        openConnectorCount = MepRoutingUtil.CountOpenConnectors(branchElements.Concat(new[] { main }));
                        var commitStatus = tx.Commit();
                        if (commitStatus != TransactionStatus.Committed || FailureHandlingUtil.HasErrors(failures))
                        {
                            var failureText = string.Join(" | ", failures
                                .Where(failure => string.Equals(failure.severity, "error", StringComparison.OrdinalIgnoreCase)
                                    || string.Equals(failure.severity, "document_corruption", StringComparison.OrdinalIgnoreCase))
                                .Select(failure => failure.message)
                                .Where(message => !string.IsNullOrWhiteSpace(message)));
                            throw new InvalidOperationException($"Branch tap/takeoff transaction did not commit: {commitStatus}{(string.IsNullOrWhiteSpace(failureText) ? "." : $": {failureText}")}");
                        }
                    }
                    catch (Exception ex)
                    {
                        try { tx.RollBack(); } catch { }
                        rolledBack = true;
                        return Task.FromResult<object>(new
                        {
                            status = "Blocked",
                            dryRun = false,
                            scaffoldOnly = false,
                            error = ex.Message,
                            kind,
                            mainElementId = p.mainElementId,
                            splitPlan,
                            splitMainSegmentIds = new List<long>(),
                            createdBranchElementIds = new List<long>(),
                            createdFittingIds = new List<long>(),
                            connectionAttempts,
                            warnings,
                            rolledBack = true
                        });
                    }
                }
            }

            if (!p.dryRun && p.verify && (createdBranchIds.Count > 0 || splitMainSegmentIds.Count > 0))
            {
                connectedNetworkAudit = TryBuildConnectedNetworkAudit(app, createdBranchIds.FirstOrDefault(), splitMainSegmentIds.FirstOrDefault(), warnings);
            }

            if (!p.dryRun && p.visualVerify)
            {
                var focusIds = splitMainSegmentIds.Concat(createdBranchIds).Concat(createdFittingIds).Where(x => x > 0).Distinct().ToList();
                if (focusIds.Count > 0)
                {
                    focusedCapture = TryExportFocusedCapture(app, p, splitMainSegmentIds, createdBranchIds, createdFittingIds);
                }
            }

            return Task.FromResult<object>(new
            {
                status,
                dryRun = p.dryRun,
                scaffoldOnly = p.dryRun || (!feasibleExistingConnector && !feasibleTap && !feasibleSplitTee),
                kind,
                main = new
                {
                    id = ElementIdCompat.GetValue(main.Id),
                    category = mainCategory,
                    name = main.Name,
                    connectorCount = connectors.Count
                },
                branchPlan = new
                {
                    points = branch.Select(ToPointObject).ToList(),
                    segmentCount = Math.Max(0, branch.Count - 1),
                    requestedSize = string.IsNullOrWhiteSpace(p.branchSize) ? null : p.branchSize,
                    segmentSizes = branchSegmentSizeTexts,
                    requestedSystemType = string.IsNullOrWhiteSpace(p.branchSystemType) ? null : p.branchSystemType,
                    requestedPipeType = string.IsNullOrWhiteSpace(p.branchPipeType) ? null : p.branchPipeType,
                    jointPlan = branchJointPlans.Select(j => new
                    {
                        jointIndex = j.JointIndex,
                        expectedFitting = j.ExpectedFitting,
                        reason = j.Reason,
                        fromSize = j.FromSize,
                        toSize = j.ToSize
                    }).ToList(),
                    connectionMode = string.IsNullOrWhiteSpace(p.connectionMode) ? "auto" : p.connectionMode
                },
                mainIntersection = new
                {
                    branchStart = ToPointObject(branchStart),
                    nearestPointOnMain = nearestPoint == null ? null : ToPointObject(nearestPoint),
                    distanceToMainFt = distanceToMain,
                    curveParameter = normalizedParameter,
                    mainStart = mainStart == null ? null : ToPointObject(mainStart),
                    mainEnd = mainEnd == null ? null : ToPointObject(mainEnd)
                },
                splitPlan,
                existingConnectorFeasibility = new
                {
                    nearestOpenConnectorFound = feasibleExistingConnector,
                    nearestConnectorDistanceFt = nearestConnectorDistance,
                    nearestConnectorOpen
                },
                existingBranchAnchorPlan = existingBranchAnchorPlan.ToResponse(),
                selected = new
                {
                    type = DescribeElementType(doc, main),
                    system = DescribeSystemType(doc, main, kind),
                    branchPipeType = explicitBranchPipeType == null ? null : new { id = ElementIdCompat.GetValue(explicitBranchPipeType.Id), name = explicitBranchPipeType.Name },
                    branchSystemType = explicitBranchSystemType == null ? null : new { id = ElementIdCompat.GetValue(explicitBranchSystemType.Id), name = explicitBranchSystemType.Name },
                    level = DescribeLevel(doc, main, ctx.Level, branchStart.Z),
                    size = string.IsNullOrWhiteSpace(p.branchSize) ? (kind == "duct" ? "8x8" : "1") : p.branchSize,
                    segmentSizes = branchSegmentSizeTexts,
                    takeoffRoutingPreference = takeoffPreference
                },
                tapApplyPrecheck = requestedConnectionMode == "tap"
                    ? new
                    {
                        applySupported = feasibleTap,
                        explicitTakeoffRoutingPreferenceRequired = kind == "pipe",
                        explicitTakeoffRoutingPreferenceFound = kind == "pipe" ? pipeTapHasExplicitTakeoffPreference : (bool?)null,
                        blockReason = feasibleTap ? null : nextStep
                    }
                    : null,
                splitMainSegmentIds,
                splitMainStartSegmentId,
                splitMainEndSegmentId,
                createdBranchElementIds = createdBranchIds,
                createdFittingIds,
                connectionAttempts,
                openConnectorCount,
                connectedNetworkAudit,
                focusedCapture,
                applyStatus = p.dryRun
                    ? "NotAppliedDryRun"
                    : (feasibleExistingConnector
                        ? "AppliedExistingOpenConnectorOnly"
                        : (feasibleTap
                            ? "AppliedTapTakeoff"
                            : (feasibleSplitTee
                                ? (existingBranchAnchorPlan.Requested ? "AppliedSplitTeeWithRetainedBranchAnchor" : "AppliedSplitTee")
                                : "GuardedScaffoldOnly"))),
                recommendedNextImplementationStep = nextStep,
                warnings,
                rolledBack
            });
        }

        private static List<string?> BuildBranchSegmentSizeTexts(Params p, int segmentCount)
        {
            var result = new List<string?>();
            for (var i = 0; i < segmentCount; i++)
                result.Add(GetBranchSegmentSizeText(p, i));
            return result;
        }

        private static string? GetBranchSegmentSizeText(Params p, int segmentIndex)
        {
            if (p.branchSegmentSizes != null && segmentIndex >= 0 && segmentIndex < p.branchSegmentSizes.Count && !string.IsNullOrWhiteSpace(p.branchSegmentSizes[segmentIndex]))
                return p.branchSegmentSizes[segmentIndex];
            return p.branchSize;
        }

        private static long? FindSegmentContainingEndpoint(IEnumerable<MEPCurve> segments, XYZ endpoint)
        {
            return segments
                .Select(segment => new
                {
                    Id = ElementIdCompat.GetValue(segment.Id),
                    Distance = segment.Location is LocationCurve location && location.Curve.IsBound
                        ? Math.Min(location.Curve.GetEndPoint(0).DistanceTo(endpoint), location.Curve.GetEndPoint(1).DistanceTo(endpoint))
                        : double.PositiveInfinity
                })
                .Where(candidate => candidate.Distance <= 0.01)
                .OrderBy(candidate => candidate.Distance)
                .Select(candidate => (long?)candidate.Id)
                .FirstOrDefault();
        }

        private static Element CreateRetainedAnchorTeeSeed(
            Document doc,
            string kind,
            ElementId systemTypeId,
            ElementId curveTypeId,
            ElementId levelId,
            XYZ splitPoint,
            Connector retainedAnchorMainConnector)
        {
            var anchorPoint = retainedAnchorMainConnector.Origin;
            if (splitPoint.DistanceTo(anchorPoint) <= doc.Application.ShortCurveTolerance)
                throw new InvalidOperationException("The retained branch anchor is too close to the split point to create a safe temporary tee seed.");

            if (kind == "pipe")
            {
                var pipe = Pipe.Create(doc, systemTypeId, curveTypeId, levelId, splitPoint, anchorPoint);
                MepRoutingUtil.TryApplyPipeSize(pipe, new MepRoutingUtil.SizeChoice
                {
                    RequestedText = "retained_anchor_main_connector",
                    AppliedText = "retained_anchor_main_connector",
                    DiameterFt = retainedAnchorMainConnector.Radius * 2.0
                }, out _);
                return pipe;
            }

            var duct = Duct.Create(doc, systemTypeId, curveTypeId, levelId, splitPoint, anchorPoint);
            var size = new MepRoutingUtil.SizeChoice
            {
                RequestedText = "retained_anchor_main_connector",
                AppliedText = "retained_anchor_main_connector"
            };
            if (retainedAnchorMainConnector.Shape == ConnectorProfileType.Round)
                size.DiameterFt = retainedAnchorMainConnector.Radius * 2.0;
            else
            {
                size.WidthFt = retainedAnchorMainConnector.Width;
                size.HeightFt = retainedAnchorMainConnector.Height;
            }
            MepRoutingUtil.TryApplyDuctSize(duct, size, out _);
            return duct;
        }

        private static Tuple<Connector, Connector>? FindPhysicalConnectionOwnedBy(Element source, ElementId ownerId)
        {
            try
            {
                foreach (var connector in MepRoutingUtil.GetConnectors(source))
                {
                    foreach (Connector reference in connector.AllRefs)
                    {
                        if (reference?.Owner == null || reference.Owner is MEPSystem) continue;
                        if (reference.Owner.Id == ownerId) return Tuple.Create(connector, reference);
                    }
                }
            }
            catch { }
            return null;
        }

        private sealed class ExistingBranchAnchorPlan
        {
            public bool Requested { get; set; }
            public bool ApplySupported { get; set; }
            public long? AnchorElementId { get; set; }
            public Element? AnchorElement { get; set; }
            public Connector? MainConnector { get; set; }
            public Connector? BranchConnector { get; set; }
            public double? MainConnectorDistanceToSplitFt { get; set; }
            public string? BlockCode { get; set; }
            public string? BlockReason { get; set; }

            public object? ToResponse()
            {
                if (!Requested) return null;
                return new
                {
                    requested = true,
                    applySupported = ApplySupported,
                    anchorElementId = AnchorElementId,
                    anchorCategory = AnchorElement?.Category?.Name,
                    mainConnectorDistanceToSplitFt = MainConnectorDistanceToSplitFt,
                    mainConnector = DescribeConnector(MainConnector),
                    branchConnector = DescribeConnector(BranchConnector),
                    blockCode = string.IsNullOrWhiteSpace(BlockCode) ? null : BlockCode,
                    blockReason = string.IsNullOrWhiteSpace(BlockReason) ? null : BlockReason
                };
            }
        }

        private static ExistingBranchAnchorPlan PlanExistingBranchAnchor(
            Document doc,
            Element main,
            string kind,
            long? anchorElementId,
            XYZ? splitPoint,
            XYZ? downstreamPoint,
            string? requestedBranchSize,
            List<string> warnings)
        {
            var plan = new ExistingBranchAnchorPlan
            {
                Requested = anchorElementId.HasValue,
                AnchorElementId = anchorElementId
            };
            if (!anchorElementId.HasValue) return plan;
            if (anchorElementId.Value <= 0 || anchorElementId.Value == ElementIdCompat.GetValue(main.Id))
                return BlockAnchor(plan, "invalid_anchor_element_id", "existingBranchAnchorElementId must identify a positive element other than the main curve.");
            if (splitPoint == null || downstreamPoint == null)
                return BlockAnchor(plan, "anchor_geometry_unresolved", "The split point and first downstream branch point are required to orient a retained branch anchor.");

            var anchor = doc.GetElement(ElementIdCompat.Create(anchorElementId.Value));
            if (anchor == null)
                return BlockAnchor(plan, "anchor_not_found", $"Retained branch anchor element {anchorElementId.Value} was not found.");
            plan.AnchorElement = anchor;
            var categoryId = anchor.Category == null ? long.MinValue : ElementIdCompat.GetValue(anchor.Category.Id);
            var validCategory = kind == "pipe"
                ? categoryId == (int)BuiltInCategory.OST_PipeFitting || categoryId == (int)BuiltInCategory.OST_PipeAccessory
                : categoryId == (int)BuiltInCategory.OST_DuctFitting || categoryId == (int)BuiltInCategory.OST_DuctAccessory;
            if (!validCategory)
                return BlockAnchor(plan, "anchor_category_mismatch", $"Retained branch anchor category '{anchor.Category?.Name}' is not compatible with kind '{kind}'.");

            var anchorConnectors = MepRoutingUtil.GetConnectors(anchor).ToList();
            var mainRepresentative = MepRoutingUtil.GetConnectors(main).FirstOrDefault();
            if (mainRepresentative == null)
                return BlockAnchor(plan, "anchor_main_connector_incompatible", "The main curve does not expose a representative connector for retained-anchor validation.");
            var sizeWarnings = new List<string>();
            var requestedSize = MepRoutingUtil.ChooseSize(kind, requestedBranchSize, requestedBranchSize, requestedBranchSize, "explicit_required", sizeWarnings);
            warnings.AddRange(sizeWarnings);
            if (requestedSize.Missing)
                return BlockAnchor(plan, "anchor_branch_size_mismatch", "An explicit branch size is required when reusing a retained branch anchor.");

            var plannerResult = MepExistingBranchAnchorPlanner.Plan(
                anchorConnectors.Select((connector, index) => ToPlannerConnector(connector, index)).ToList(),
                ToPlannerPoint(splitPoint),
                ToPlannerPoint(downstreamPoint),
                ToPlannerSize(mainRepresentative),
                ToPlannerSize(mainRepresentative.Domain, requestedSize));
            if (!plannerResult.ApplySupported || !plannerResult.MainConnectorIndex.HasValue || !plannerResult.BranchConnectorIndex.HasValue)
                return BlockAnchor(plan, plannerResult.BlockCode, plannerResult.BlockReason);

            var mainSide = anchorConnectors[plannerResult.MainConnectorIndex.Value];
            var branchSide = anchorConnectors[plannerResult.BranchConnectorIndex.Value];

            plan.MainConnector = mainSide;
            plan.BranchConnector = branchSide;
            plan.MainConnectorDistanceToSplitFt = plannerResult.MainConnectorDistanceToSplitFt;
            plan.ApplySupported = true;
            return plan;
        }

        private static ExistingBranchAnchorPlan BlockAnchor(ExistingBranchAnchorPlan plan, string code, string reason)
        {
            plan.ApplySupported = false;
            plan.BlockCode = code;
            plan.BlockReason = reason;
            return plan;
        }

        private static MepBranchAnchorConnector ToPlannerConnector(Connector connector, int index)
        {
            return new MepBranchAnchorConnector
            {
                Index = index,
                Origin = ToPlannerPoint(connector.Origin),
                Size = ToPlannerSize(connector),
                PhysicallyConnected = MepRoutingUtil.IsPhysicallyConnected(connector)
            };
        }

        private static MepBranchAnchorPoint ToPlannerPoint(XYZ point) => new MepBranchAnchorPoint { X = point.X, Y = point.Y, Z = point.Z };

        private static MepBranchAnchorSize ToPlannerSize(Connector connector) => new MepBranchAnchorSize
        {
            Domain = NormalizePlannerDomain(connector.Domain),
            Shape = NormalizePlannerShape(connector.Shape),
            DiameterFt = connector.Shape == ConnectorProfileType.Round ? connector.Radius * 2.0 : (double?)null,
            WidthFt = connector.Shape == ConnectorProfileType.Rectangular ? connector.Width : (double?)null,
            HeightFt = connector.Shape == ConnectorProfileType.Rectangular ? connector.Height : (double?)null
        };

        private static MepBranchAnchorSize ToPlannerSize(Domain domain, MepRoutingUtil.SizeChoice size) => new MepBranchAnchorSize
        {
            Domain = NormalizePlannerDomain(domain),
            Shape = size.DiameterFt.HasValue ? "round" : "rectangular",
            DiameterFt = size.DiameterFt,
            WidthFt = size.WidthFt,
            HeightFt = size.HeightFt
        };

        private static string NormalizePlannerDomain(Domain domain)
        {
            var value = domain.ToString().ToLowerInvariant();
            if (value.Contains("piping")) return "piping";
            if (value.Contains("hvac")) return "hvac";
            return value;
        }

        private static string NormalizePlannerShape(ConnectorProfileType shape) => shape == ConnectorProfileType.Round
            ? "round"
            : shape == ConnectorProfileType.Rectangular ? "rectangular" : shape.ToString().ToLowerInvariant();

        private static object? DescribeConnector(Connector? connector)
        {
            if (connector == null) return null;
            try
            {
                return new
                {
                    origin = ToPointObject(connector.Origin),
                    domain = connector.Domain.ToString(),
                    shape = connector.Shape.ToString(),
                    diameterFt = connector.Shape == ConnectorProfileType.Round ? connector.Radius * 2.0 : (double?)null,
                    widthFt = connector.Shape == ConnectorProfileType.Rectangular ? connector.Width : (double?)null,
                    heightFt = connector.Shape == ConnectorProfileType.Rectangular ? connector.Height : (double?)null,
                    physicallyConnected = MepRoutingUtil.IsPhysicallyConnected(connector)
                };
            }
            catch
            {
                return null;
            }
        }

        private static bool TryCreateTeeFitting(
            Document doc,
            ElementType? curveType,
            string kind,
            string? requestedFamilyName,
            string? requestedTypeName,
            Connector? a,
            Connector? b,
            Connector? c,
            out long? fittingId,
            out string method,
            out string? error)
        {
            fittingId = null;
            method = "none";
            error = null;
            if (a == null || b == null || c == null)
            {
                error = "Could not find all three connectors at the split point.";
                return false;
            }

            var permutations = new[]
            {
                new[] { a, b, c },
                new[] { a, c, b },
                new[] { b, a, c },
                new[] { b, c, a },
                new[] { c, a, b },
                new[] { c, b, a }
            };
            foreach (var p in permutations)
            {
                try
                {
                    var fitting = doc.Create.NewTeeFitting(p[0], p[1], p[2]);
                    if (fitting != null)
                    {
                        fittingId = ElementIdCompat.GetValue(fitting.Id);
                        method = "new_tee_fitting";
                        error = null;
                        return true;
                    }
                }
                catch (Exception ex)
                {
                    error = string.IsNullOrWhiteSpace(error) ? ex.Message : error;
                }
            }

            var explicitFamily = (requestedFamilyName ?? "").Trim();
            var explicitType = (requestedTypeName ?? "").Trim();
            if (explicitFamily.Length == 0 && explicitType.Length == 0)
            {
                method = "failed";
                return false;
            }

            var requestedSymbol = FindRequestedJunctionSymbol(doc, kind, explicitFamily, explicitType);
            if (requestedSymbol == null)
            {
                error = $"Requested tee family/type was not found: family='{explicitFamily}', type='{explicitType}'.";
                method = "explicit_tee_not_found";
                return false;
            }

            var routingManager = GetRoutingPreferenceManager(curveType);
            if (routingManager == null)
            {
                error = $"The selected {kind} curve type does not expose a routing preference manager.";
                method = "explicit_tee_routing_unavailable";
                return false;
            }

            var originalJunctionType = routingManager.PreferredJunctionType;
            var temporaryRuleAdded = false;
            var explicitTeeCreated = false;
            var cleanupSucceeded = true;
            try
            {
                using (var rule = new RoutingPreferenceRule(requestedSymbol.Id, "Revit Operator temporary explicit tee precedent"))
                {
                    rule.AddCriterion(PrimarySizeCriterion.All());
                    routingManager.AddRule(RoutingPreferenceRuleGroupType.Junctions, rule, 0);
                    temporaryRuleAdded = true;
                }
                routingManager.PreferredJunctionType = PreferredJunctionType.Tee;
                doc.Regenerate();

                foreach (var p in permutations)
                {
                    try
                    {
                        var fitting = doc.Create.NewTeeFitting(p[0], p[1], p[2]);
                        if (fitting == null) continue;
                        fittingId = ElementIdCompat.GetValue(fitting.Id);
                        method = "new_tee_fitting_with_temporary_explicit_preference";
                        error = null;
                        explicitTeeCreated = true;
                        break;
                    }
                    catch (Exception ex)
                    {
                        error = ex.Message;
                    }
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }
            finally
            {
                try
                {
                    if (temporaryRuleAdded) routingManager.RemoveRule(RoutingPreferenceRuleGroupType.Junctions, 0);
                    routingManager.PreferredJunctionType = originalJunctionType;
                    doc.Regenerate();
                }
                catch (Exception cleanupError)
                {
                    cleanupSucceeded = false;
                    fittingId = null;
                    method = "explicit_tee_preference_cleanup_failed";
                    error = $"Temporary tee routing preference cleanup failed: {cleanupError.Message}";
                }
            }
            if (explicitTeeCreated && cleanupSucceeded) return true;
            if (!cleanupSucceeded) return false;
            method = "failed";
            return false;
        }

        private static RoutingPreferenceManager? GetRoutingPreferenceManager(ElementType? curveType)
        {
            if (curveType is DuctType ductType) return ductType.RoutingPreferenceManager;
            if (curveType is PipeType pipeType) return pipeType.RoutingPreferenceManager;
            return null;
        }

        private static ElementId ResolveDuctTypeIdForSize(
            Document doc,
            MepRoutingUtil.SizeChoice size,
            ElementId fallbackTypeId)
        {
            DuctType? requestedShapeType = null;
            if (size.WidthFt.HasValue && size.HeightFt.HasValue)
                requestedShapeType = MepRoutingUtil.FindDuctType(doc, "Rectangular Duct");
            else if (size.DiameterFt.HasValue)
                requestedShapeType = MepRoutingUtil.FindDuctType(doc, "Round Duct");
            return requestedShapeType?.Id ?? fallbackTypeId;
        }

        private static bool TryCreateTransitionElbowOrConnect(
            Document doc,
            ElementType? curveType,
            string kind,
            Connector? a,
            Connector? b,
            bool preferTransition,
            string? requestedFamilyName,
            string? requestedTypeName,
            out long? fittingId,
            out string method,
            out string? error)
        {
            if (MepRoutingUtil.TryCreateTransitionElbowOrConnect(doc, a, b, preferTransition,
                out fittingId, out method, out error)) return true;

            var family = (requestedFamilyName ?? "").Trim();
            var type = (requestedTypeName ?? "").Trim();
            if (!preferTransition || (family.Length == 0 && type.Length == 0)) return false;

            var symbol = FindRequestedJunctionSymbol(doc, kind, family, type);
            if (symbol == null)
            {
                method = "explicit_transition_not_found";
                error = $"Requested transition family/type was not found: family='{family}', type='{type}'.";
                return false;
            }
            var manager = GetRoutingPreferenceManager(curveType);
            if (manager == null)
            {
                method = "explicit_transition_routing_unavailable";
                error = $"The selected {kind} curve type does not expose a routing preference manager.";
                return false;
            }

            var temporaryRuleAdded = false;
            var created = false;
            var cleanupSucceeded = true;
            try
            {
                using (var rule = new RoutingPreferenceRule(symbol.Id, "Revit Operator temporary explicit transition precedent"))
                {
                    rule.AddCriterion(PrimarySizeCriterion.All());
                    manager.AddRule(RoutingPreferenceRuleGroupType.Transitions, rule, 0);
                    temporaryRuleAdded = true;
                }
                doc.Regenerate();
                created = MepRoutingUtil.TryCreateTransitionElbowOrConnect(doc, a, b, true,
                    out fittingId, out method, out error);
                if (created) method = "new_transition_fitting_with_temporary_explicit_preference";
            }
            catch (Exception ex)
            {
                fittingId = null;
                method = "explicit_transition_failed";
                error = ex.Message;
            }
            finally
            {
                try
                {
                    if (temporaryRuleAdded) manager.RemoveRule(RoutingPreferenceRuleGroupType.Transitions, 0);
                    doc.Regenerate();
                }
                catch (Exception cleanupError)
                {
                    cleanupSucceeded = false;
                    fittingId = null;
                    method = "explicit_transition_preference_cleanup_failed";
                    error = $"Temporary transition routing preference cleanup failed: {cleanupError.Message}";
                }
            }
            return created && cleanupSucceeded;
        }

        private static FamilySymbol? FindRequestedJunctionSymbol(Document doc, string kind, string familyName, string typeName)
        {
            var expectedCategoryId = string.Equals(kind, "pipe", StringComparison.OrdinalIgnoreCase)
                ? (int)BuiltInCategory.OST_PipeFitting
                : (int)BuiltInCategory.OST_DuctFitting;
            return new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .Where(symbol => symbol.Category != null && ElementIdCompat.GetValue(symbol.Category.Id) == expectedCategoryId)
                .Where(symbol => familyName.Length == 0 || string.Equals(symbol.FamilyName, familyName, StringComparison.OrdinalIgnoreCase))
                .Where(symbol => typeName.Length == 0 || string.Equals(symbol.Name, typeName, StringComparison.OrdinalIgnoreCase))
                .OrderBy(symbol => ElementIdCompat.GetValue(symbol.Id))
                .FirstOrDefault();
        }

        private static bool TryCreateTakeoffFitting(Document doc, Connector? branchConnector, MEPCurve main, out long? fittingId, out string method, out string? error)
        {
            fittingId = null;
            method = "none";
            error = null;
            if (branchConnector == null)
            {
                error = "Could not find the branch connector at the projected takeoff point.";
                return false;
            }
            if (main == null)
            {
                error = "Main MEP curve is required for takeoff fitting creation.";
                return false;
            }

            try
            {
                var fitting = doc.Create.NewTakeoffFitting(branchConnector, main);
                if (fitting != null)
                {
                    fittingId = ElementIdCompat.GetValue(fitting.Id);
                    method = "new_takeoff_fitting";
                    return true;
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }

            method = "failed";
            return false;
        }

        private static object? DescribeTakeoffRoutingPreference(Document doc, ElementType? curveType, string kind, string? requestedFamilyName, string? requestedTypeName)
        {
            if (curveType == null) return null;
            var rules = DescribeRoutingPreferenceRules(doc, curveType, "takeoff");
            var explicitRules = DescribeRoutingPreferenceRules(doc, curveType, "explicitTakeoff");
            var family = (requestedFamilyName ?? "").Trim();
            var type = (requestedTypeName ?? "").Trim();
            var requested = family.Length > 0 || type.Length > 0;
            var matches = requested
                ? rules.Where(r => MatchesText(r.FamilyName, family) && MatchesText(r.TypeName, type)).ToList()
                : new List<RoutingPreferenceRuleDescription>();
            return new
            {
                curveKind = kind,
                curveTypeId = ElementIdCompat.GetValue(curveType.Id),
                curveTypeName = curveType.Name,
                ductTypeId = curveType is DuctType ? ElementIdCompat.GetValue(curveType.Id) : (long?)null,
                ductTypeName = curveType is DuctType ? curveType.Name : null,
                pipeTypeId = curveType is PipeType ? ElementIdCompat.GetValue(curveType.Id) : (long?)null,
                pipeTypeName = curveType is PipeType ? curveType.Name : null,
                requestedFamilyName = family.Length == 0 ? null : family,
                requestedTypeName = type.Length == 0 ? null : type,
                requestedMatched = requested ? matches.Count > 0 : (bool?)null,
                candidateCount = rules.Count,
                candidates = rules.Select(r => r.ToResponse()).ToList(),
                explicitTakeoffCandidateCount = explicitRules.Count,
                explicitTakeoffCandidates = explicitRules.Select(r => r.ToResponse()).ToList(),
                matchingCandidates = matches.Select(r => r.ToResponse()).ToList()
            };
        }

        private static bool HasExplicitTakeoffRoutingPreference(Document doc, ElementType? curveType)
        {
            if (curveType == null) return false;
            return DescribeRoutingPreferenceRules(doc, curveType, "explicitTakeoff").Count > 0;
        }

        private sealed class RoutingPreferenceRuleDescription
        {
            public string GroupName { get; set; } = "";
            public int RuleIndex { get; set; }
            public long? PartId { get; set; }
            public string? PartName { get; set; }
            public string? CategoryName { get; set; }
            public string? FamilyName { get; set; }
            public string? TypeName { get; set; }

            public object ToResponse() => new
            {
                groupName = GroupName,
                ruleIndex = RuleIndex,
                partId = PartId,
                partName = PartName,
                categoryName = CategoryName,
                familyName = FamilyName,
                typeName = TypeName
            };
        }

        private static List<RoutingPreferenceRuleDescription> DescribeRoutingPreferenceRules(Document doc, ElementType curveType, string fittingKind)
        {
            var result = new List<RoutingPreferenceRuleDescription>();
            try
            {
                var rpm = curveType.GetType().GetProperty("RoutingPreferenceManager", BindingFlags.Instance | BindingFlags.Public)?.GetValue(curveType);
                if (rpm == null) return result;
                var enumType = rpm.GetType().Assembly.GetType("Autodesk.Revit.DB.RoutingPreferenceRuleGroupType");
                if (enumType == null || !enumType.IsEnum) return result;
                var getCount = rpm.GetType().GetMethod("GetNumberOfRules", new[] { enumType });
                var getRule = rpm.GetType().GetMethod("GetRule", new[] { enumType, typeof(int) });
                if (getCount == null || getRule == null) return result;

                foreach (var groupValue in Enum.GetValues(enumType))
                {
                    var groupName = groupValue?.ToString() ?? "";
                    if (!RoutingPreferenceGroupMatches(groupName, fittingKind)) continue;
                    var countObj = getCount.Invoke(rpm, new[] { groupValue });
                    var count = Convert.ToInt32(countObj);
                    for (var i = 0; i < count; i++)
                    {
                        var rule = getRule.Invoke(rpm, new[] { groupValue, i });
                        if (rule == null) continue;
                        var partIdObj = rule.GetType().GetProperty("MEPPartId")?.GetValue(rule)
                            ?? rule.GetType().GetProperty("PartId")?.GetValue(rule);
                        if (!(partIdObj is ElementId partId) || partId == ElementId.InvalidElementId) continue;
                        var part = doc.GetElement(partId);
                        result.Add(new RoutingPreferenceRuleDescription
                        {
                            GroupName = groupName,
                            RuleIndex = i,
                            PartId = ElementIdCompat.GetValue(partId),
                            PartName = part?.Name,
                            CategoryName = part?.Category?.Name,
                            FamilyName = TryGetFamilyName(part),
                            TypeName = part?.Name
                        });
                    }
                }
            }
            catch { }
            return result;
        }

        private static bool RoutingPreferenceGroupMatches(string groupName, string fittingKind)
        {
            var g = (groupName ?? "").ToLowerInvariant();
            var k = (fittingKind ?? "").ToLowerInvariant();
            if (k == "explicittakeoff") return g.Contains("tap") || g.Contains("takeoff");
            if (k == "takeoff") return g.Contains("junction") || g.Contains("tap") || g.Contains("takeoff");
            if (k == "transition") return g.Contains("transition");
            if (k == "elbow") return g.Contains("elbow");
            return true;
        }

        private static object? DescribeFittingElement(Document doc, Element? fitting)
        {
            if (fitting == null) return null;
            var typeId = ElementId.InvalidElementId;
            try { typeId = fitting.GetTypeId(); } catch { }
            var type = typeId == ElementId.InvalidElementId ? null : doc.GetElement(typeId);
            return new
            {
                id = ElementIdCompat.GetValue(fitting.Id),
                categoryName = fitting.Category?.Name,
                name = fitting.Name,
                typeId = typeId == ElementId.InvalidElementId ? (long?)null : ElementIdCompat.GetValue(typeId),
                typeName = type?.Name,
                familyName = TryGetFamilyName(type) ?? TryGetFamilyName(fitting)
            };
        }

        private static bool TakeoffMatchesRequest(Element? fitting, string? requestedFamilyName, string? requestedTypeName, out string? mismatch)
        {
            mismatch = null;
            var family = (requestedFamilyName ?? "").Trim();
            var type = (requestedTypeName ?? "").Trim();
            if (family.Length == 0 && type.Length == 0) return true;
            if (fitting == null)
            {
                mismatch = "Requested takeoff family/type could not be verified because Revit did not return a fitting.";
                return false;
            }

            var doc = fitting.Document;
            Element? typeElement = null;
            try
            {
                var typeId = fitting.GetTypeId();
                if (typeId != ElementId.InvalidElementId) typeElement = doc.GetElement(typeId);
            }
            catch { }
            var actualFamily = TryGetFamilyName(typeElement) ?? TryGetFamilyName(fitting) ?? "";
            var actualType = typeElement?.Name ?? fitting.Name ?? "";
            if (!MatchesText(actualFamily, family))
            {
                mismatch = $"Created takeoff family '{actualFamily}' did not match requested family '{family}'.";
                return false;
            }
            if (!MatchesText(actualType, type))
            {
                mismatch = $"Created takeoff type '{actualType}' did not match requested type '{type}'.";
                return false;
            }
            return true;
        }

        private static string? TryGetFamilyName(Element? element)
        {
            try
            {
                if (element is FamilySymbol fs) return fs.FamilyName;
                var p = element?.LookupParameter("Family") ?? element?.LookupParameter("Family Name");
                return p?.AsString() ?? p?.AsValueString();
            }
            catch { return null; }
        }

        private static bool MatchesText(string? actual, string requested)
        {
            if (string.IsNullOrWhiteSpace(requested)) return true;
            var a = (actual ?? "").Trim();
            return a.Equals(requested.Trim(), StringComparison.OrdinalIgnoreCase)
                || a.IndexOf(requested.Trim(), StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string NormalizeConnectionMode(string? mode)
        {
            var m = (mode ?? "").Trim().ToLowerInvariant();
            if (m == "tap" || m == "takeoff") return "tap";
            return "tee";
        }

        private static object? TryBuildConnectedNetworkAudit(UIApplication app, long branchStartId, long fallbackStartId, List<string> warnings)
        {
            var startId = branchStartId > 0 ? branchStartId : fallbackStartId;
            if (startId <= 0) return null;
            try
            {
                var req = new TraceConnectedNetworkHandler.Params
                {
                    startElementId = startId,
                    inferSystemFromStart = true,
                    includeSystemAudit = true,
                    maxHops = 12,
                    maxElements = 500
                };
                return new TraceConnectedNetworkHandler().Handle(app, JsonSerializer.Serialize(req)).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                warnings.Add($"Connected-network audit failed: {ex.Message}");
                return new { status = "Failed", error = ex.Message };
            }
        }

        private static object TryExportFocusedCapture(UIApplication app, Params p, List<long> splitMainSegmentIds, List<long> createdBranchIds, List<long> createdFittingIds)
        {
            try
            {
                var allIds = splitMainSegmentIds.Concat(createdBranchIds).Concat(createdFittingIds).Where(x => x > 0).Distinct().ToList();
                var groups = new List<HighlightAndExportHandler.HighlightGroup>();
                if (splitMainSegmentIds.Count > 0)
                {
                    groups.Add(new HighlightAndExportHandler.HighlightGroup
                    {
                        name = "split_main_segments",
                        elementIds = splitMainSegmentIds,
                        overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 7, r = 80, g = 180, b = 80 }
                    });
                }
                if (createdBranchIds.Count > 0)
                {
                    groups.Add(new HighlightAndExportHandler.HighlightGroup
                    {
                        name = "branch_segments",
                        elementIds = createdBranchIds,
                        overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 8, r = 0, g = 180, b = 255 }
                    });
                }
                if (createdFittingIds.Count > 0)
                {
                    groups.Add(new HighlightAndExportHandler.HighlightGroup
                    {
                        name = "branch_fittings",
                        elementIds = createdFittingIds,
                        overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 9, r = 255, g = 140, b = 0 }
                    });
                }

                var req = new HighlightAndExportHandler.Params
                {
                    viewId = p.visualViewId ?? p.viewId,
                    elementIds = allIds,
                    focusElementIds = createdBranchIds.Count > 0 ? createdBranchIds : allIds,
                    imageSize = Math.Max(512, Math.Min(4096, p.imageSize)),
                    focusPaddingFt = Math.Max(0.5, Math.Min(100.0, p.focusPaddingFt)),
                    highlightGroups = groups
                };
                var capture = new HighlightAndExportHandler().Handle(app, JsonSerializer.Serialize(req)).GetAwaiter().GetResult();
                return new { status = "CaptureReadyForAIReview", capture };
            }
            catch (Exception ex)
            {
                return new { status = "CaptureFailed", error = ex.Message };
            }
        }

        private static ElementId ResolveMainSystemTypeId(Document doc, Element main, string kind)
        {
            try
            {
                ElementId? id = null;
                if (main is Duct duct) id = duct.MEPSystem?.GetTypeId();
                if (main is Pipe pipe) id = pipe.MEPSystem?.GetTypeId();
                if (id != null && id != ElementId.InvalidElementId) return id;
            }
            catch { }

            var fallback = MepRoutingUtil.FindSystemType(doc, null, kind);
            return fallback?.Id ?? ElementId.InvalidElementId;
        }

        private static ElementId ResolveLevelId(Document doc, Element main, Level? contextLevel, double z)
        {
            try
            {
                if (main is MEPCurve curve && curve.ReferenceLevel != null) return curve.ReferenceLevel.Id;
            }
            catch { }

            if (contextLevel != null) return contextLevel.Id;
            return MepRoutingUtil.ResolveLevelFromZ(doc, z)?.Id ?? ElementId.InvalidElementId;
        }

        private static object DescribeElementType(Document doc, Element main)
        {
            try
            {
                ElementId id = ElementId.InvalidElementId;
                if (main is Duct duct) id = duct.DuctType.Id;
                if (main is Pipe pipe) id = pipe.PipeType.Id;
                var type = id == ElementId.InvalidElementId ? null : doc.GetElement(id);
                return new { id = id == ElementId.InvalidElementId ? (long?)null : ElementIdCompat.GetValue(id), name = type?.Name };
            }
            catch { return new { id = (long?)null, name = (string?)null }; }
        }

        private static ElementId GetMepCurveTypeId(Element main, string kind)
        {
            try
            {
                if (kind == "duct" && main is Duct duct) return duct.DuctType.Id;
                if (kind == "pipe" && main is Pipe pipe) return pipe.PipeType.Id;
            }
            catch { }
            return ElementId.InvalidElementId;
        }

        private static ElementType? GetMepCurveType(Element main, string kind)
        {
            try
            {
                var id = GetMepCurveTypeId(main, kind);
                return id == ElementId.InvalidElementId ? null : main.Document.GetElement(id) as ElementType;
            }
            catch { return null; }
        }

        private static object DescribeSystemType(Document doc, Element main, string kind)
        {
            try
            {
                var id = ResolveMainSystemTypeId(doc, main, kind);
                var type = id == ElementId.InvalidElementId ? null : doc.GetElement(id);
                return new { id = id == ElementId.InvalidElementId ? (long?)null : ElementIdCompat.GetValue(id), name = type?.Name };
            }
            catch { return new { id = (long?)null, name = (string?)null }; }
        }

        private static object DescribeLevel(Document doc, Element main, Level? contextLevel, double z)
        {
            try
            {
                var id = ResolveLevelId(doc, main, contextLevel, z);
                var level = id == ElementId.InvalidElementId ? null : doc.GetElement(id) as Level;
                return new { id = id == ElementId.InvalidElementId ? (long?)null : ElementIdCompat.GetValue(id), name = level?.Name, elevation = level?.Elevation };
            }
            catch { return new { id = (long?)null, name = (string?)null, elevation = (double?)null }; }
        }

        private static bool TryReadConnected(object value)
        {
            try
            {
                var prop = value.GetType().GetProperty("connected");
                return prop?.GetValue(value) is bool b && b;
            }
            catch
            {
                return false;
            }
        }

        private static object ToPointObject(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
    }

    public sealed class BranchSplitPrecheck
    {
        public bool ApplySupported { get; private set; }
        public string Mode { get; private set; } = "tee";
        public string ExpectedFitting { get; private set; } = "tee";
        public string BlockCode { get; private set; } = "";
        public string BlockReason { get; private set; } = "";
        public XYZ? SplitPoint { get; private set; }
        public XYZ? MainSegmentAStart { get; private set; }
        public XYZ? MainSegmentAEnd { get; private set; }
        public XYZ? MainSegmentBStart { get; private set; }
        public XYZ? MainSegmentBEnd { get; private set; }
        public double? DistanceToMainFt { get; private set; }
        public double? DistanceFromMainStartFt { get; private set; }
        public double? DistanceFromMainEndFt { get; private set; }

        public static BranchSplitPrecheck Blocked(string code, string reason) => new BranchSplitPrecheck
        {
            ApplySupported = false,
            BlockCode = code,
            BlockReason = reason
        };

        public static BranchSplitPrecheck Supported(XYZ splitPoint, XYZ mainStart, XYZ mainEnd, double distanceToMain, double distanceFromStart, double distanceFromEnd, string mode = "tee") => new BranchSplitPrecheck
        {
            ApplySupported = true,
            Mode = mode == "tap" ? "tap" : "tee",
            ExpectedFitting = mode == "tap" ? "takeoff" : "tee",
            SplitPoint = splitPoint,
            MainSegmentAStart = mainStart,
            MainSegmentAEnd = splitPoint,
            MainSegmentBStart = splitPoint,
            MainSegmentBEnd = mainEnd,
            DistanceToMainFt = distanceToMain,
            DistanceFromMainStartFt = distanceFromStart,
            DistanceFromMainEndFt = distanceFromEnd
        };

        public object ToResponse() => new
        {
            applySupported = ApplySupported,
            mode = Mode,
            expectedFitting = ExpectedFitting,
            blockCode = string.IsNullOrWhiteSpace(BlockCode) ? null : BlockCode,
            blockReason = string.IsNullOrWhiteSpace(BlockReason) ? null : BlockReason,
            projectedSplitPoint = SplitPoint == null ? null : Point(SplitPoint),
            mainSegments = SplitPoint == null || MainSegmentAStart == null || MainSegmentAEnd == null || MainSegmentBStart == null || MainSegmentBEnd == null
                ? null
                : new[]
                {
                    new { start = Point(MainSegmentAStart), end = Point(MainSegmentAEnd) },
                    new { start = Point(MainSegmentBStart), end = Point(MainSegmentBEnd) }
                },
            distanceToMainFt = DistanceToMainFt,
            distanceFromMainStartFt = DistanceFromMainStartFt,
            distanceFromMainEndFt = DistanceFromMainEndFt
        };

        private static object Point(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
    }

    public static class BranchSplitPlanner
    {
        public static BranchSplitPrecheck PlanDuctLineSplit(string kind, Element main, Curve? mainCurve, XYZ branchStart, List<XYZ> branchPoints, XYZ? projectedPoint, double? distanceToMainFt, string connectionMode = "tee")
        {
            var mainStart = mainCurve?.IsBound == true ? mainCurve.GetEndPoint(0) : null;
            var mainEnd = mainCurve?.IsBound == true ? mainCurve.GetEndPoint(1) : null;
            return PlanLineSplitGeometry(
                kind,
                (kind == "duct" && main is Duct) || (kind == "pipe" && main is Pipe),
                mainCurve is Line,
                mainStart,
                mainEnd,
                branchStart,
                branchPoints,
                projectedPoint,
                distanceToMainFt,
                connectionMode);
        }

        public static BranchSplitPrecheck PlanLineSplitGeometry(string kind, bool isDuctMain, bool isLineMain, XYZ? mainStart, XYZ? mainEnd, XYZ branchStart, List<XYZ> branchPoints, XYZ? projectedPoint, double? distanceToMainFt, string connectionMode = "tee")
        {
            var plan = MepBranchSplitGeometryPlanner.PlanLineSplit(
                kind,
                isDuctMain,
                isLineMain,
                mainStart == null ? null : ToBranchPoint(mainStart),
                mainEnd == null ? null : ToBranchPoint(mainEnd),
                (branchPoints ?? new List<XYZ>()).Select(ToBranchPoint).ToList(),
                projectedPoint == null ? null : ToBranchPoint(projectedPoint),
                distanceToMainFt,
                connectionMode);

            if (!plan.ApplySupported)
                return BranchSplitPrecheck.Blocked(plan.BlockCode, plan.BlockReason);

            return BranchSplitPrecheck.Supported(
                ToXyz(plan.SplitPoint!.Value),
                ToXyz(plan.MainSegmentAStart!.Value),
                ToXyz(plan.MainSegmentBEnd!.Value),
                plan.DistanceToMainFt.GetValueOrDefault(),
                plan.DistanceFromMainStartFt.GetValueOrDefault(),
                plan.DistanceFromMainEndFt.GetValueOrDefault(),
                plan.Mode);
        }

        private static BranchPoint3d ToBranchPoint(XYZ p) => new BranchPoint3d(p.X, p.Y, p.Z);
        private static XYZ ToXyz(BranchPoint3d p) => new XYZ(p.X, p.Y, p.Z);
    }
}

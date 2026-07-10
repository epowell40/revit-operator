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

            var connectors = MepRoutingUtil.GetConnectors(main);
            var nearestConnector = MepRoutingUtil.FindClosestConnector(connectors, branchStart, 0.5);
            var nearestConnectorDistance = nearestConnector == null ? (double?)null : nearestConnector.Origin.DistanceTo(branchStart);
            var nearestConnectorOpen = false;
            if (nearestConnector != null)
            {
                try { nearestConnectorOpen = !nearestConnector.IsConnected; } catch { nearestConnectorOpen = false; }
            }

            var feasibleExistingConnector = nearestConnector != null && nearestConnectorOpen && nearestConnectorDistance.GetValueOrDefault(999) <= 0.25;
            var feasibleTap = splitPrecheck.ApplySupported && requestedConnectionMode == "tap" && pipeTapHasExplicitTakeoffPreference;
            var feasibleSplitTee = splitPrecheck.ApplySupported && requestedConnectionMode != "tap";
            var status = p.dryRun ? "Dry Run" : (feasibleExistingConnector ? "CreatedWithOpenConnectors" : (feasibleTap ? "CreatedWithTapTakeoff" : (feasibleSplitTee ? "CreatedWithSplitTee" : "Blocked")));
            var nextStep = splitPrecheck.BlockReason;
            if (feasibleExistingConnector)
                nextStep = "Safe apply path is available because the branch starts at an existing open main connector.";
            else if (feasibleTap)
                nextStep = $"Safe {kind} tap/takeoff apply path is available for this projected non-connector branch point.";
            else if (requestedConnectionMode == "tap" && splitPrecheck.ApplySupported && kind == "pipe" && !pipeTapHasExplicitTakeoffPreference)
                nextStep = "Pipe tap/takeoff apply is blocked because the selected pipe type does not expose an explicit tap/takeoff routing preference. Use connectionMode:\"tee\" for a split tee, or choose a pipe type with a takeoff/tap routing preference.";
            else if (feasibleSplitTee)
                nextStep = $"Safe {kind} split/tee apply path is available for this projected non-connector branch point.";

            if (!p.dryRun && !feasibleExistingConnector && !feasibleTap && !feasibleSplitTee)
            {
                warnings.Add($"Apply mode is guarded for this case: {nextStep}");
            }

            var createdBranchIds = new List<long>();
            var createdFittingIds = new List<long>();
            var splitMainSegmentIds = new List<long>();
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
                                var pipeTypeId = main is Pipe mainPipe ? mainPipe.PipeType.Id : (MepRoutingUtil.FindPipeType(doc, null)?.Id ?? ElementId.InvalidElementId);
                                var systemTypeId = ResolveMainSystemTypeId(doc, main, "pipe");
                                var levelId = ResolveLevelId(doc, main, ctx.Level, a.Z);
                                if (pipeTypeId == ElementId.InvalidElementId || systemTypeId == ElementId.InvalidElementId || levelId == ElementId.InvalidElementId)
                                    throw new InvalidOperationException("Could not resolve pipe branch system/type/level from the main element.");

                                var pipe = Pipe.Create(doc, systemTypeId, pipeTypeId, levelId, a, b);
                                MepRoutingUtil.TryApplyPipeSize(pipe, size, out sizeApplied);
                                curve = pipe;
                            }
                            else
                            {
                                var ductTypeId = main is Duct mainDuct ? mainDuct.DuctType.Id : (MepRoutingUtil.FindDuctType(doc, null)?.Id ?? ElementId.InvalidElementId);
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
                            var ok = MepRoutingUtil.TryCreateTransitionElbowOrConnect(doc, a, b, expectTransition, out var fittingId, out var method, out var err);
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

                        tx.Commit();
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
                        snapped[0] = splitPrecheck.SplitPoint;

                        ElementId curveTypeId;
                        if (kind == "pipe")
                        {
                            if (!(main is Pipe mainPipe)) throw new InvalidOperationException("Safe split/tee apply for kind 'pipe' requires a pipe main.");
                            curveTypeId = mainPipe.PipeType.Id;
                        }
                        else
                        {
                            if (!(main is Duct mainDuct)) throw new InvalidOperationException("Safe split/tee apply for kind 'duct' requires a duct main.");
                            curveTypeId = mainDuct.DuctType.Id;
                        }
                        var systemTypeId = ResolveMainSystemTypeId(doc, main, kind);
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
                                var duct = Duct.Create(doc, systemTypeId, curveTypeId, levelId, a, b);
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
                        var branchConnector = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[0]), splitPrecheck.SplitPoint, 0.25);
                        var teeOk = TryCreateTeeFitting(doc, mainA, mainB, branchConnector, out var teeFittingId, out var teeMethod, out var teeError);
                        if (teeFittingId.HasValue) createdFittingIds.Add(teeFittingId.Value);
                        connectionAttempts.Add(new
                        {
                            connection = "split_main_to_branch_tee",
                            mainSegmentIds = splitMainSegmentIds.ToList(),
                            branchElementId = createdBranchIds.FirstOrDefault(),
                            connected = teeOk,
                            method = teeMethod,
                            fittingId = teeFittingId,
                            error = teeError
                        });
                        if (!teeOk)
                            throw new InvalidOperationException($"Could not create tee fitting at split point: {teeError ?? teeMethod}");

                        for (var i = 0; i < branchElements.Count - 1; i++)
                        {
                            var shared = snapped[i + 1];
                            var a = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[i]), shared, 0.25);
                            var b = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(branchElements[i + 1]), shared, 0.25);
                            var jointPlan = branchJointPlans.FirstOrDefault(j => j.JointIndex == i);
                            var expectTransition = string.Equals(jointPlan?.ExpectedFitting, "transition", StringComparison.OrdinalIgnoreCase);
                            var ok = MepRoutingUtil.TryCreateTransitionElbowOrConnect(doc, a, b, expectTransition, out var fittingId, out var method, out var err);
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

                        openConnectorCount = MepRoutingUtil.CountOpenConnectors(branchElements.Concat(new Element[] { firstMainSegment, secondMainSegment }));
                        tx.Commit();
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
                                var duct = Duct.Create(doc, systemTypeId, curveTypeId, levelId, a, b);
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
                            var ok = MepRoutingUtil.TryCreateTransitionElbowOrConnect(doc, a, b, expectTransition, out var fittingId, out var method, out var err);
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
                        tx.Commit();
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
                selected = new
                {
                    type = DescribeElementType(doc, main),
                    system = DescribeSystemType(doc, main, kind),
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
                createdBranchElementIds = createdBranchIds,
                createdFittingIds,
                connectionAttempts,
                openConnectorCount,
                connectedNetworkAudit,
                focusedCapture,
                applyStatus = p.dryRun ? "NotAppliedDryRun" : (feasibleExistingConnector ? "AppliedExistingOpenConnectorOnly" : (feasibleTap ? "AppliedTapTakeoff" : (feasibleSplitTee ? "AppliedSplitTee" : "GuardedScaffoldOnly"))),
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

        private static bool TryCreateTeeFitting(Document doc, Connector? a, Connector? b, Connector? c, out long? fittingId, out string method, out string? error)
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
            method = "failed";
            return false;
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

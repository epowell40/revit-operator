using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.Electrical;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Skills.DwellingReceptacles;

namespace RevitBridge.Logic.Handlers
{
    public sealed class RoomReceptacleAnalogParams
    {
        public string targetRoomNumber { get; set; } = string.Empty;
        public string? sourceRoomNumber { get; set; }
        public long? viewId { get; set; }
        public bool includePreviewImage { get; set; } = true;
        public string circuitMode { get; set; } = CircuitMatchPolicy.None;
        public string? planHash { get; set; }
    }

    public sealed class PlanRoomReceptaclesFromAnalogHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) => Task.FromResult(RoomReceptacleAnalogNative.Execute(app, jsonData, apply: false));
    }

    public sealed class ApplyRoomReceptaclesFromAnalogHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) => Task.FromResult(RoomReceptacleAnalogNative.Execute(app, jsonData, apply: true));
    }

    internal static class RoomReceptacleAnalogNative
    {
        internal const string PlanPath = "/revit/plan-room-receptacles-from-analog";
        internal const string ApplyPath = "/revit/apply-room-receptacles-from-analog";
        private const double SemanticDistanceFt = 6.0;
        private const double PlacementToleranceFt = 0.10;

        private sealed class AnchorRecord
        {
            public DwellingReceptacleAnalogAnchor Value { get; set; } = new DwellingReceptacleAnalogAnchor();
            public RevitLinkInstance? Link { get; set; }
            public ElementId LinkedElementId { get; set; } = ElementId.InvalidElementId;
            public Element? Element { get; set; }
        }

        private sealed class DeviceRecord
        {
            public FamilyInstance Instance { get; set; } = null!;
            public DwellingReceptacleReferenceDevice PlannerDevice { get; set; } = new DwellingReceptacleReferenceDevice();
            public RevitLinkInstance PhysicalLink { get; set; } = null!;
            public ElementId PhysicalLinkedElementId { get; set; } = ElementId.InvalidElementId;
            public string PhysicalCategory { get; set; } = string.Empty;
            public string PhysicalBuiltInCategory { get; set; } = string.Empty;
            public string PhysicalUniqueId { get; set; } = string.Empty;
            public Element PhysicalElement { get; set; } = null!;
            public string SourceHostStableReference { get; set; } = string.Empty;
            public string SourceCircuitPanel { get; set; } = string.Empty;
            public string SourceCircuitNumber { get; set; } = string.Empty;
            public ElectricalSystem? SourcePowerSystem { get; set; }
            public CircuitSnapshot? SourceCircuitSnapshot { get; set; }
            public XYZ PreferredDirection { get; set; } = XYZ.BasisX;
            public bool SemanticHostIsExactPhysical { get; set; }
        }

        private sealed class SpatialRecord
        {
            public ResolvedSpatialContext Spatial { get; set; } = null!;
            public DwellingReceptacleAnalogRoomFrame Frame { get; set; } = new DwellingReceptacleAnalogRoomFrame();
            public List<AnchorRecord> Anchors { get; set; } = new List<AnchorRecord>();
            public List<FamilyInstance> Receptacles { get; set; } = new List<FamilyInstance>();
            public double AreaFt2 { get; set; }
            public double BoundaryLengthFt { get; set; }
            public XYZ Centroid { get; set; } = XYZ.Zero;
            public string LevelScopedId { get; set; } = string.Empty;
        }

        private sealed class PreparedPlacement
        {
            public DeviceRecord Source { get; set; } = null!;
            public DwellingReceptacleAnalogPlacement Planned { get; set; } = null!;
            public RevitLinkInstance Link { get; set; } = null!;
            public ElementId LinkedElementId { get; set; } = ElementId.InvalidElementId;
            public string PhysicalMappingBasis { get; set; } = string.Empty;
            public LinkedFaceReferenceResolution Face { get; set; } = null!;
        }

        private sealed class PreparedContext
        {
            public Document Document { get; set; } = null!;
            public View PlanView { get; set; } = null!;
            public View3D ReferenceView { get; set; } = null!;
            public IReadOnlyList<View3D> ReferenceViews { get; set; } = Array.Empty<View3D>();
            public SpatialRecord Source { get; set; } = null!;
            public SpatialRecord Target { get; set; } = null!;
            public List<DeviceRecord> Devices { get; set; } = new List<DeviceRecord>();
            public DwellingReceptacleAnalogPlan AnalogPlan { get; set; } = null!;
            public List<PreparedPlacement> Placements { get; set; } = new List<PreparedPlacement>();
            public DwellingReceptacleAnalogCandidateSelection Selection { get; set; } = new DwellingReceptacleAnalogCandidateSelection();
            public string PlanHash { get; set; } = string.Empty;
            public string CircuitMode { get; set; } = CircuitMatchPolicy.None;
        }

        private sealed class CircuitSnapshot
        {
            public long SystemId { get; set; }
            public string SystemType { get; set; } = string.Empty;
            public long? PanelElementId { get; set; }
            public string PanelName { get; set; } = string.Empty;
            public string CircuitNumber { get; set; } = string.Empty;
            public double? VoltageInternal { get; set; }
            public string VoltageDisplay { get; set; } = string.Empty;
            public int? Poles { get; set; }
            public string LoadClassifications { get; set; } = string.Empty;
            public double? TrueLoadInternal { get; set; }
            public string TrueLoadDisplay { get; set; } = string.Empty;
            public double? ApparentLoadInternal { get; set; }
            public string ApparentLoadDisplay { get; set; } = string.Empty;
        }

        private sealed class CreationReceipt
        {
            public List<long> CreatedIds { get; } = new List<long>();
            public List<object> Readback { get; } = new List<object>();
            public List<object> CircuitSystems { get; } = new List<object>();
            public List<object> CircuitAssignments { get; } = new List<object>();
            public List<CapturedFailure> Failures { get; } = new List<CapturedFailure>();
        }

        internal static object Execute(UIApplication app, string jsonData, bool apply)
        {
            var stopwatch = Stopwatch.StartNew();
            var request = string.IsNullOrWhiteSpace(jsonData)
                ? new RoomReceptacleAnalogParams()
                : JsonSerializer.Deserialize<RoomReceptacleAnalogParams>(jsonData, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new RoomReceptacleAnalogParams();
            request.targetRoomNumber = (request.targetRoomNumber ?? string.Empty).Trim();
            request.sourceRoomNumber = string.IsNullOrWhiteSpace(request.sourceRoomNumber) ? null : request.sourceRoomNumber.Trim();
            request.circuitMode = CircuitMatchPolicy.NormalizeMode(request.circuitMode);
            if (request.targetRoomNumber.Length == 0) throw new ArgumentException("targetRoomNumber is required.");
            if (apply && string.IsNullOrWhiteSpace(request.planHash)) throw new ArgumentException("planHash is required for apply.");

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active Revit document.");
            var context = Prepare(uidoc.Document, uidoc.ActiveView, request);
            if (apply && !string.Equals(request.planHash, context.PlanHash, StringComparison.Ordinal))
                throw new InvalidOperationException("analog_plan_hash_stale");

            var warnings = new List<string>();
            CreationReceipt receipt;
            (string? path, int? widthPx, int? heightPx) preview = (null, null, null);
            if (!apply)
            {
                using var group = new TransactionGroup(context.Document, "Preview Room Receptacle Analog Layout");
                if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("analog_preview_group_start_failed");
                Exception? primaryFailure = null;
                try
                {
                    receipt = CreateAndVerify(context, "Temporary Room Receptacle Analog Layout");
                    if (request.includePreviewImage)
                        preview = ExportPreview(context, receipt.CreatedIds, warnings);
                }
                catch (Exception ex)
                {
                    primaryFailure = ex;
                    throw;
                }
                finally
                {
                    try
                    {
                        if (group.GetStatus() == TransactionStatus.Started && group.RollBack() != TransactionStatus.RolledBack)
                            throw new InvalidOperationException("analog_preview_group_rollback_failed");
                    }
                    catch (Exception rollbackFailure)
                    {
                        if (primaryFailure != null) throw new AggregateException(primaryFailure, rollbackFailure);
                        throw;
                    }
                }
            }
            else
            {
                using (var group = new TransactionGroup(context.Document, "Apply Room Receptacle Analog Layout"))
                {
                    if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("analog_apply_group_start_failed");
                    try
                    {
                        receipt = CreateAndVerify(context, "Create Room Receptacle Analog Layout");
                        // The committed inner transaction remains rollbackable until the group is
                        // assimilated. Keep every deterministic inventory check inside that boundary.
                        VerifyPersistentInventory(context, receipt.CreatedIds);
                        if (group.Assimilate() != TransactionStatus.Committed) throw new InvalidOperationException("analog_apply_group_assimilate_failed");
                    }
                    catch
                    {
                        try { group.RollBack(); } catch { }
                        throw;
                    }
                }
                if (request.includePreviewImage)
                    preview = TryExportPostApplyPreview(context, receipt.CreatedIds, warnings);
            }

            stopwatch.Stop();
            return BuildResponse(context, receipt, preview, warnings, stopwatch.ElapsedMilliseconds, apply);
        }

        private static (string? path, int? widthPx, int? heightPx) TryExportPostApplyPreview(PreparedContext context, IList<long> createdIds, List<string> warnings)
        {
            TransactionGroup? previewGroup = null;
            var testFault = string.Equals(Environment.GetEnvironmentVariable("OPERATOR_ENABLE_DETERMINISTIC_TEST_HOOKS"), "1", StringComparison.Ordinal)
                ? (Environment.GetEnvironmentVariable("OPERATOR_TEST_ROOM_ANALOG_POST_COMMIT_PREVIEW_FAILURE") ?? string.Empty).Trim().ToLowerInvariant()
                : string.Empty;
            var outcome = DwellingReceptacleAnalogRuntime.CaptureOptionalPostCommitArtifact(
                capture: () =>
                {
                    if (testFault == "group_start") throw new InvalidOperationException("Injected post-commit preview group-start failure.");
                    previewGroup = new TransactionGroup(context.Document, "Room Receptacle Analog Preview Decorations");
                    if (previewGroup.Start() != TransactionStatus.Started) throw new InvalidOperationException("analog_preview_decoration_group_start_failed");
                    if (testFault == "export") throw new InvalidOperationException("Injected post-commit preview export failure.");
                    return ExportPreview(context, createdIds, warnings);
                },
                cleanup: () =>
                {
                    if (previewGroup == null) return true;
                    var cleanupProven = true;
                    if (previewGroup.GetStatus() == TransactionStatus.Started)
                        cleanupProven = previewGroup.RollBack() == TransactionStatus.RolledBack;
                    previewGroup.Dispose();
                    // The live rollback-fault test still performs the real rollback;
                    // it only forces the receipt to prove the warning path.
                    return cleanupProven && testFault != "rollback";
                });

            if (!outcome.CaptureSucceeded)
            {
                warnings.Add("post_apply_preview_unavailable:" + (outcome.CaptureFailureKind ?? "unknown"));
            }
            if (!outcome.CleanupSucceeded)
            {
                warnings.Add("post_apply_preview_cleanup_failed:" + (outcome.CleanupFailureKind ?? "unknown"));
            }
            // The authoritative persistent inventory remains the receipt. Return the
            // optional image only when both capture and decoration cleanup are proven.
            return outcome.CaptureSucceeded && outcome.CleanupSucceeded ? outcome.Value : (null, null, null);
        }

        private static PreparedContext Prepare(Document document, View activeView, RoomReceptacleAnalogParams request)
        {
            var targetSpatial = HostedPlacementUtil.FindSpatialElement(document, null, request.targetRoomNumber, "space")
                ?? throw new InvalidOperationException($"Target Room/Space '{request.targetRoomNumber}' was not found.");
            var planView = ResolvePowerPlanView(document, targetSpatial.element, request.viewId)
                ?? throw new InvalidOperationException("No same-level floor/power plan view was found for the target.");
            var referenceViews = LinkedFaceReferenceUtil.FindReferenceViews(document, activeView);
            var referenceView = referenceViews.FirstOrDefault() ?? throw new InvalidOperationException("linked_face_reference_view_missing");
            var target = BuildSpatialRecord(document, targetSpatial);
            if (target.Receptacles.Count != 0) throw new InvalidOperationException($"target_room_not_empty:{target.Receptacles.Count}");

            SpatialRecord source;
            DwellingReceptacleAnalogCandidateSelection selection;
            if (!string.IsNullOrWhiteSpace(request.sourceRoomNumber))
            {
                var explicitSpatial = HostedPlacementUtil.FindSpatialElement(document, null, request.sourceRoomNumber, "space")
                    ?? throw new InvalidOperationException($"Source Room/Space '{request.sourceRoomNumber}' was not found.");
                source = BuildSpatialRecord(document, explicitSpatial);
                if (source.Receptacles.Count == 0) throw new InvalidOperationException("source_room_has_no_receptacles");
                if (!string.Equals(source.LevelScopedId, target.LevelScopedId, StringComparison.Ordinal)) throw new InvalidOperationException("source_target_level_mismatch");
                selection = new DwellingReceptacleAnalogCandidateSelection
                {
                    Status = "selected",
                    SelectedRoomScopedId = source.Spatial.id.ToString(CultureInfo.InvariantCulture),
                    CandidateScores = new List<DwellingReceptacleAnalogCandidateScore>
                    {
                        new DwellingReceptacleAnalogCandidateScore { RoomScopedId = source.Spatial.id.ToString(CultureInfo.InvariantCulture), RoomNumber = source.Spatial.number, Score = 1, CuratedSignatureParity = true, ReceptacleCount = source.Receptacles.Count }
                    }
                };
            }
            else
            {
                var candidates = EnumerateCandidateSpatials(document, target).ToList();
                var eligibleCandidates = new List<SpatialRecord>();
                var candidateModels = new List<DwellingReceptacleAnalogCandidate>();
                foreach (var candidate in candidates)
                {
                    try
                    {
                        // A room is not a usable project analog unless every source
                        // device can prove its linked physical host. One incomplete
                        // nearby room must not prevent evaluation of other candidates.
                        candidateModels.Add(ToCandidate(document, candidate, target, usedSemanticOnly: true));
                        eligibleCandidates.Add(candidate);
                    }
                    catch
                    {
                        // Fail this candidate closed and continue deterministic search.
                    }
                }
                selection = DwellingReceptacleAnalogRuntime.SelectUniqueCandidate(ToCandidate(document, target, target, usedSemanticOnly: false), candidateModels);
                if (!string.Equals(selection.Status, "selected", StringComparison.Ordinal) || string.IsNullOrWhiteSpace(selection.SelectedRoomScopedId))
                    throw new InvalidOperationException("analog_source_selection_failed:" + selection.Blocker);
                source = eligibleCandidates.Single(candidate => string.Equals(candidate.Spatial.id.ToString(CultureInfo.InvariantCulture), selection.SelectedRoomScopedId, StringComparison.Ordinal));
            }

            var devices = BuildDeviceRecords(document, source, request.circuitMode);
            var usedSourceAnchorIds = new HashSet<string>(devices.Select(device => device.PlannerDevice.SourceHostScopedId).Where(id => !string.IsNullOrWhiteSpace(id))!, StringComparer.Ordinal);
            var sourcePlannerAnchors = source.Anchors.Where(anchor => usedSourceAnchorIds.Contains(anchor.Value.ScopedId)).ToList();
            if (sourcePlannerAnchors.Count != usedSourceAnchorIds.Count)
                throw new InvalidOperationException("source_used_semantic_anchor_missing");
            var requiredSignatures = new HashSet<string>(sourcePlannerAnchors.Select(anchor => DwellingReceptacleAnalogPlanner.NormalizedSignature(anchor.Value)), StringComparer.Ordinal);
            var targetPlannerAnchors = target.Anchors.Where(anchor => requiredSignatures.Contains(DwellingReceptacleAnalogPlanner.NormalizedSignature(anchor.Value))).ToList();
            var plannerInput = new DwellingReceptacleAnalogPlanInput
            {
                SourceRoom = source.Frame,
                TargetRoom = target.Frame,
                SourceAnchors = sourcePlannerAnchors.Select(anchor => anchor.Value).ToList(),
                TargetAnchors = targetPlannerAnchors.Select(anchor => anchor.Value).ToList(),
                ReferenceDevices = devices.Select(device => device.PlannerDevice).ToList(),
                SemanticAnchorMaxDistanceFt = ResolveSemanticDistanceThreshold(devices, source.Anchors),
                DuplicateTargetPointToleranceFt = 0.05
            };
            var analogPlan = DwellingReceptacleAnalogPlanner.Plan(plannerInput);
            if (!string.Equals(analogPlan.Status, "ready", StringComparison.Ordinal))
                throw new InvalidOperationException("analog_planner_not_ready:" + string.Join(",", analogPlan.ManualReviews.Select(review => review.Code + (string.IsNullOrWhiteSpace(review.AnchorSignature) ? string.Empty : "@" + review.AnchorSignature))));

            var context = new PreparedContext
            {
                Document = document,
                PlanView = planView,
                ReferenceView = referenceView,
                ReferenceViews = referenceViews,
                Source = source,
                Target = target,
                Devices = devices,
                AnalogPlan = analogPlan,
                Selection = selection,
                CircuitMode = request.circuitMode
            };
            context.Placements = PreparePhysicalPlacements(context);
            ValidatePreparedPlacements(context);
            context.PlanHash = ComputePlanHash(context);
            return context;
        }

        private static List<PreparedPlacement> PreparePhysicalPlacements(PreparedContext context)
        {
            var bySource = context.Devices.ToDictionary(device => device.PlannerDevice.ElementId, StringComparer.Ordinal);
            var targetAnchors = context.Target.Anchors.ToDictionary(anchor => anchor.Value.ScopedId, StringComparer.Ordinal);
            var sourceWalls = HostedPlacementUtil.ResolveRoomWalls(context.Document, context.Source.Spatial.element, context.PlanView, null, 128);
            var targetWalls = HostedPlacementUtil.ResolveRoomWalls(context.Document, context.Target.Spatial.element, context.PlanView, null, 128);
            var result = new List<PreparedPlacement>();
            foreach (var planned in context.AnalogPlan.ProposedPlacements)
            {
                var source = bySource[planned.SourceElementId];
                RevitLinkInstance? link = null;
                ElementId linkedId = ElementId.InvalidElementId;
                var physicalBasis = string.Empty;
                var targetPoint = ToXyz(planned.TargetPoint);
                var targetDirection = source.PreferredDirection;
                var sourceUsesNonWallHost = !IsWallCategory(source.PhysicalBuiltInCategory, source.PhysicalCategory);
                if (sourceUsesNonWallHost)
                {
                    if (planned.TargetHostAnchorScopedId == null || !targetAnchors.TryGetValue(planned.TargetHostAnchorScopedId, out var physicalAnchor) || physicalAnchor.Link == null || physicalAnchor.LinkedElementId == ElementId.InvalidElementId)
                        throw new InvalidOperationException("semantic_physical_host_unresolved:" + planned.SourceElementId);
                    link = physicalAnchor.Link;
                    linkedId = physicalAnchor.LinkedElementId;
                    physicalBasis = "corresponding_exact_semantic_host";
                    var sourcePoint = HostedPlacementUtil.TryGetElementPoint(source.Instance) ?? throw new InvalidOperationException("source_receptacle_point_missing");
                    if (TryMapPointBetweenLinkedFamilyInstances(source, physicalAnchor, sourcePoint, out var frameMappedPoint))
                    {
                        targetPoint = frameMappedPoint;
                        planned.TargetPoint = ToPoint3(targetPoint);
                        planned.MappingRuleTrace = "corresponding_linked_family_instance_local_frame_transform";
                        targetDirection = TryMapDirectionBetweenLinkedFamilyInstances(source, physicalAnchor, source.PreferredDirection) ?? source.PreferredDirection;
                    }
                }
                else
                {
                    var sourcePoint = HostedPlacementUtil.TryGetElementPoint(source.Instance) ?? throw new InvalidOperationException("source_receptacle_point_missing");
                    var sourceWall = ResolveSourceBoundaryForPhysicalHost(source, sourceWalls, sourcePoint, planned.SourceElementId);
                    if (sourceWall == null)
                    {
                        if (!TryResolveSourcePhysicalWall(source, sourcePoint, out var sourcePhysicalWall, out var sourceHostDiagnostic))
                            throw new InvalidOperationException("source_physical_wall_unresolved:" + planned.SourceElementId + ":" + sourceHostDiagnostic);
                        var sourceTangent = TryGetLinkedCurveDirection(source.PhysicalLink, sourcePhysicalWall);
                        XYZ? targetTangent = null;
                        var nonBoundaryResolutionDiagnostic = "not_attempted";
                        if (string.Equals(planned.MappingBasis, "semantic_anchor", StringComparison.Ordinal) && planned.TargetHostAnchorScopedId != null &&
                            targetAnchors.TryGetValue(planned.TargetHostAnchorScopedId, out var physicalAnchor) && physicalAnchor.Link != null &&
                            physicalAnchor.LinkedElementId != ElementId.InvalidElementId && physicalAnchor.Element != null)
                        {
                            link = physicalAnchor.Link;
                            linkedId = physicalAnchor.LinkedElementId;
                            targetTangent = TryGetLinkedCurveDirection(physicalAnchor.Link, physicalAnchor.Element);
                            physicalBasis = "corresponding_exact_semantic_nonboundary_wall_host";
                        }
                        else if (TryResolveCorrespondingNonBoundaryWall(source, sourcePhysicalWall, sourcePoint, context.Target.Spatial.element, targetPoint, out var resolvedLink, out var resolvedLinkedId, out var projected, out var resolvedTangent, out nonBoundaryResolutionDiagnostic))
                        {
                            link = resolvedLink;
                            linkedId = resolvedLinkedId;
                            targetTangent = resolvedTangent;
                            targetPoint = new XYZ(projected.X, projected.Y, targetPoint.Z);
                            planned.TargetPoint = ToPoint3(targetPoint);
                            planned.MappingBasis = "corresponding_nonboundary_wall";
                            planned.MappingRuleTrace = "mapped_room_frame_point_to_unique_nearest_parallel_linked_wall_with_type_tiebreak";
                            physicalBasis = "corresponding_nearest_parallel_nonboundary_wall";
                        }
                        if (sourceTangent == null || targetTangent == null || link == null || linkedId == ElementId.InvalidElementId)
                            throw new InvalidOperationException("source_boundary_host_not_in_room_boundary:" + planned.SourceElementId + ":" + nonBoundaryResolutionDiagnostic);
                        var signedOrientation = source.PreferredDirection.DotProduct(sourceTangent) >= 0 ? 1.0 : -1.0;
                        targetDirection = targetTangent.Multiply(signedOrientation);
                    }
                    else
                    {
                        if (!HostedPlacementUtil.TryProjectPointToRoomWallDetailed(sourceWall, sourcePoint, out _, out var sourceTangent, out _, out _, out _, out var normalizedChainage))
                            throw new InvalidOperationException("source_boundary_projection_failed:" + planned.SourceElementId);
                        var signedOrientation = source.PreferredDirection.DotProduct(sourceTangent) >= 0 ? 1.0 : -1.0;
                        RoomWallResolution best;
                        if (string.Equals(planned.MappingBasis, "semantic_anchor", StringComparison.Ordinal))
                        {
                            best = ResolveNearestTargetBoundaryWall(targetWalls, targetPoint, planned.SourceElementId, out var projected, out var targetTangent);
                            targetPoint = new XYZ(projected.X, projected.Y, targetPoint.Z);
                            planned.TargetPoint = ToPoint3(targetPoint);
                            targetDirection = targetTangent.Multiply(signedOrientation);
                            physicalBasis = "semantic_target_on_nearest_room_boundary_face";
                        }
                        else
                        {
                            best = ResolveCorrespondingBoundaryWall(context.Source, context.Target, sourceWall, targetWalls, planned.SourceElementId);
                            if (!TryPointAtNormalizedChainage(best, normalizedChainage, out var mappedPoint, out var targetTangent))
                                throw new InvalidOperationException("target_boundary_chainage_failed:" + planned.SourceElementId);
                            targetDirection = targetTangent.Multiply(signedOrientation);
                            targetPoint = new XYZ(mappedPoint.X, mappedPoint.Y, targetPoint.Z);
                            planned.TargetPoint = ToPoint3(targetPoint);
                            planned.MappingBasis = "actual_boundary_segment_chainage";
                            planned.MappingRuleTrace = "source_linked_boundary_host_to_corresponding_target_boundary_preserving_normalized_chainage_and_mounting_height";
                            physicalBasis = "corresponding_target_room_boundary_chainage";
                        }
                        link = context.Document.GetElement(ElementIdCompat.Create(best.hostElementId)) as RevitLinkInstance;
                        linkedId = ElementIdCompat.Create(best.linkedElementId!.Value);
                    }
                }
                if (link == null || linkedId == ElementId.InvalidElementId) throw new InvalidOperationException("target_linked_host_unavailable:" + planned.SourceElementId);
                LinkedFaceReferenceResolution? face = null;
                var resolutionErrors = new List<string>();
                foreach (var referenceView in context.ReferenceViews)
                {
                    if (LinkedFaceReferenceUtil.TryResolve(context.Document, referenceView, link, linkedId, targetPoint, targetDirection, out face, out var error,
                        sourceStableReferencePattern: source.SourceHostStableReference)) break;
                    resolutionErrors.Add(error);
                }
                if (face == null && sourceUsesNonWallHost)
                {
                    var fallbackWall = ResolveNearestTargetBoundaryWall(targetWalls, targetPoint, planned.SourceElementId, out var projected, out var targetTangent);
                    var fallbackDistance = projected.DistanceTo(targetPoint);
                    if (!IsFinite(fallbackDistance) || fallbackDistance > 6.0)
                    {
                        var physicalResolutionEvidence = string.Join("|", resolutionErrors.Where(value => !string.IsNullOrWhiteSpace(value)).Distinct(StringComparer.Ordinal));
                        throw new InvalidOperationException("semantic_anchor_wall_fallback_distance_exceeded:" + planned.SourceElementId +
                            (string.IsNullOrWhiteSpace(physicalResolutionEvidence) ? string.Empty : ":" + physicalResolutionEvidence));
                    }
                    link = context.Document.GetElement(ElementIdCompat.Create(fallbackWall.hostElementId)) as RevitLinkInstance;
                    linkedId = ElementIdCompat.Create(fallbackWall.linkedElementId!.Value);
                    targetPoint = new XYZ(projected.X, projected.Y, targetPoint.Z);
                    planned.TargetPoint = ToPoint3(targetPoint);
                    var sign = targetDirection.DotProduct(targetTangent) >= 0 ? 1.0 : -1.0;
                    targetDirection = targetTangent.Multiply(sign);
                    physicalBasis = "semantic_anchor_to_nearest_target_boundary_fallback";
                    resolutionErrors.Clear();
                    foreach (var referenceView in context.ReferenceViews)
                    {
                        if (LinkedFaceReferenceUtil.TryResolve(context.Document, referenceView, link!, linkedId, targetPoint, targetDirection, out face, out var error,
                            sourceStableReferencePattern: source.SourceHostStableReference)) break;
                        resolutionErrors.Add(error);
                    }
                }
                if (face == null) throw new InvalidOperationException(string.Join("|", resolutionErrors.Distinct(StringComparer.Ordinal)) + ":" + planned.SourceElementId);
                result.Add(new PreparedPlacement { Source = source, Planned = planned, Link = link, LinkedElementId = linkedId, PhysicalMappingBasis = physicalBasis, Face = face });
            }
            return result;
        }

        private static RoomWallResolution ResolveNearestTargetBoundaryWall(IEnumerable<RoomWallResolution> targetWalls, XYZ targetPoint, string sourceElementId, out XYZ projectedPoint, out XYZ tangent)
        {
            var ranked = targetWalls.Select(wall =>
            {
                var distance = double.PositiveInfinity;
                var projected = XYZ.Zero;
                var direction = XYZ.BasisX;
                if (wall.linkedElementId.HasValue && HostedPlacementUtil.TryProjectPointToRoomWall(wall, targetPoint, out projected, out direction, out _, out _)) distance = projected.DistanceTo(targetPoint);
                return new { Wall = wall, Distance = distance, Projected = projected, Tangent = direction };
            }).Where(item => item.Wall.linkedElementId.HasValue && IsFinite(item.Distance)).OrderBy(item => item.Distance).ThenBy(item => item.Wall.linkedElementId).ToList();
            if (ranked.Count == 0) throw new InvalidOperationException("semantic_target_boundary_unresolved:" + sourceElementId);
            if (ranked.Count > 1 && Math.Abs(ranked[1].Distance - ranked[0].Distance) <= 0.01 && ranked[1].Wall.linkedElementId != ranked[0].Wall.linkedElementId)
                throw new InvalidOperationException("semantic_target_boundary_ambiguous:" + sourceElementId);
            projectedPoint = ranked[0].Projected;
            tangent = ranked[0].Tangent;
            return ranked[0].Wall;
        }

        private static bool TryMapPointBetweenLinkedFamilyInstances(DeviceRecord source, AnchorRecord target, XYZ sourceWorldPoint, out XYZ targetWorldPoint)
        {
            targetWorldPoint = XYZ.Zero;
            if (!(source.PhysicalElement is FamilyInstance sourceFamily) || !(target.Element is FamilyInstance targetFamily) || target.Link == null) return false;
            try
            {
                var sourceInLink = GetLinkTransform(source.PhysicalLink).Inverse.OfPoint(sourceWorldPoint);
                var sourceLocal = sourceFamily.GetTransform().Inverse.OfPoint(sourceInLink);
                targetWorldPoint = GetLinkTransform(target.Link).OfPoint(targetFamily.GetTransform().OfPoint(sourceLocal));
                return IsFinite(targetWorldPoint.X) && IsFinite(targetWorldPoint.Y) && IsFinite(targetWorldPoint.Z);
            }
            catch { return false; }
        }

        private static XYZ? TryGetLinkedCurveDirection(RevitLinkInstance link, Element element)
        {
            if (!(element.Location is LocationCurve location) || location.Curve == null) return null;
            XYZ localDirection;
            try { localDirection = location.Curve.ComputeDerivatives(0.5, true).BasisX; }
            catch { localDirection = location.Curve.GetEndPoint(1) - location.Curve.GetEndPoint(0); }
            if (!IsFinite(localDirection.X) || !IsFinite(localDirection.Y) || !IsFinite(localDirection.Z) || localDirection.GetLength() <= 1e-9) return null;
            Transform transform;
            try { transform = link.GetTotalTransform(); }
            catch { transform = link.GetTransform(); }
            var worldDirection = transform.OfVector(localDirection);
            worldDirection = new XYZ(worldDirection.X, worldDirection.Y, 0);
            return IsFinite(worldDirection.X) && IsFinite(worldDirection.Y) && IsFinite(worldDirection.Z) && worldDirection.GetLength() > 1e-9 ? worldDirection.Normalize() : null;
        }

        private static bool TryResolveCorrespondingNonBoundaryWall(DeviceRecord source, Wall sourceWall, XYZ sourcePoint, SpatialElement targetSpatial, XYZ targetPoint, out RevitLinkInstance link,
            out ElementId linkedElementId, out XYZ projectedPoint, out XYZ tangent, out string diagnostic)
        {
            link = source.PhysicalLink;
            linkedElementId = ElementId.InvalidElementId;
            projectedPoint = XYZ.Zero;
            tangent = XYZ.Zero;
            diagnostic = "uninitialized";
            var linkDocument = link.GetLinkDocument();
            if (linkDocument == null) { diagnostic = "link_document_missing"; return false; }
            var sourceDirection = TryGetLinkedCurveDirection(link, sourceWall);
            if (sourceDirection == null) { diagnostic = "source_direction_missing"; return false; }
            if (!TryGetLinkedCurveChainage(link, sourceWall, sourcePoint, out var sourceChainage)) { diagnostic = "source_chainage_missing"; return false; }
            Transform transform;
            try { transform = link.GetTotalTransform(); }
            catch { transform = link.GetTransform(); }
            var localTarget = transform.Inverse.OfPoint(targetPoint);
            var sourceTypeId = sourceWall.GetTypeId();
            var targetBox = targetSpatial.get_BoundingBox(null);
            var targetDiagonal = targetBox == null ? 24.0 : new XYZ(targetBox.Max.X - targetBox.Min.X, targetBox.Max.Y - targetBox.Min.Y, 0).GetLength();
            var maximumMappingDistance = Math.Max(6.0, Math.Min(12.0, targetDiagonal * 0.25));
            var candidates = new List<(Wall wall, bool exactType, double distance, XYZ point, XYZ direction)>();
            var totalWalls = 0;
            var verticallyEligibleWalls = 0;
            var mappedWalls = 0;
            var parallelWalls = 0;
            var targetAdjacentWalls = 0;
            var closestParallelDistance = double.PositiveInfinity;
            foreach (var wall in new FilteredElementCollector(linkDocument).OfClass(typeof(Wall)).Cast<Wall>())
            {
                totalWalls++;
                if (wall.Id == sourceWall.Id || !(wall.Location is LocationCurve location) || location.Curve == null) continue;
                var boundingBox = wall.get_BoundingBox(null);
                if (boundingBox == null || localTarget.Z < boundingBox.Min.Z - 0.10 || localTarget.Z > boundingBox.Max.Z + 0.10) continue;
                verticallyEligibleWalls++;
                XYZ localDirection;
                try { localDirection = location.Curve.ComputeDerivatives(0.5, true).BasisX; }
                catch { localDirection = location.Curve.GetEndPoint(1) - location.Curve.GetEndPoint(0); }
                var worldDirection = transform.OfVector(localDirection);
                worldDirection = new XYZ(worldDirection.X, worldDirection.Y, 0);
                if (worldDirection.GetLength() <= 1e-9) continue;
                worldDirection = worldDirection.Normalize();
                if (Math.Abs(worldDirection.DotProduct(sourceDirection)) < 0.95) continue;
                parallelWalls++;
                var targetChainage = worldDirection.DotProduct(sourceDirection) >= 0 ? sourceChainage : 1.0 - sourceChainage;
                XYZ localMappedPoint;
                try { localMappedPoint = location.Curve.Evaluate(targetChainage, true); } catch { continue; }
                mappedWalls++;
                var worldPoint = transform.OfPoint(localMappedPoint);
                worldPoint = new XYZ(worldPoint.X, worldPoint.Y, targetPoint.Z);
                var wallNormal = new XYZ(-worldDirection.Y, worldDirection.X, 0).Normalize();
                var roomProbe = Math.Max(0.25, (wall.Width * 0.5) + 0.10);
                var plusProbe = worldPoint + wallNormal.Multiply(roomProbe);
                var minusProbe = worldPoint - wallNormal.Multiply(roomProbe);
                var centerInside = HostedPlacementUtil.TryIsPointInSpatial(targetSpatial, worldPoint);
                var plusInside = HostedPlacementUtil.TryIsPointInSpatial(targetSpatial, plusProbe);
                var minusInside = HostedPlacementUtil.TryIsPointInSpatial(targetSpatial, minusProbe);
                if (!centerInside && !plusInside && !minusInside) continue;
                targetAdjacentWalls++;
                var distance = worldPoint.DistanceTo(targetPoint);
                if (IsFinite(distance)) closestParallelDistance = Math.Min(closestParallelDistance, distance);
                if (!IsFinite(distance) || distance > maximumMappingDistance) continue;
                var roomSidePoint = centerInside ? worldPoint : plusInside && !minusInside ? plusProbe : minusInside && !plusInside ? minusProbe :
                    (plusProbe.DistanceTo(targetPoint) <= minusProbe.DistanceTo(targetPoint) ? plusProbe : minusProbe);
                candidates.Add((wall, wall.GetTypeId() == sourceTypeId, distance, roomSidePoint, worldDirection));
            }
            var ordered = candidates.OrderBy(candidate => candidate.distance).ThenByDescending(candidate => candidate.exactType).ThenBy(candidate => ElementIdCompat.GetValue(candidate.wall.Id)).ToList();
            var nearest = IsFinite(closestParallelDistance) ? closestParallelDistance.ToString("F3", CultureInfo.InvariantCulture) : "none";
            diagnostic = "walls=" + totalWalls + ",vertical=" + verticallyEligibleWalls + ",mapped=" + mappedWalls + ",parallel=" + parallelWalls + ",target_adjacent=" + targetAdjacentWalls + ",within_bound=" + ordered.Count + ",bound=" + maximumMappingDistance.ToString("F3", CultureInfo.InvariantCulture) + ",nearest=" + nearest + ",source_chainage=" + sourceChainage.ToString("F4", CultureInfo.InvariantCulture);
            if (ordered.Count == 0) return false;
            if (ordered.Count > 1 && Math.Abs(ordered[1].distance - ordered[0].distance) <= 0.10 && ordered[1].exactType == ordered[0].exactType)
            {
                diagnostic += ",ambiguous=" + ElementIdCompat.GetValue(ordered[0].wall.Id) + "@" + ordered[0].distance.ToString("F3", CultureInfo.InvariantCulture) + "|" + ElementIdCompat.GetValue(ordered[1].wall.Id) + "@" + ordered[1].distance.ToString("F3", CultureInfo.InvariantCulture);
                return false;
            }
            linkedElementId = ordered[0].wall.Id;
            projectedPoint = ordered[0].point;
            tangent = ordered[0].direction;
            return true;
        }

        private static bool TryGetLinkedCurveChainage(RevitLinkInstance link, Wall wall, XYZ worldPoint, out double chainage)
        {
            chainage = 0;
            if (!(wall.Location is LocationCurve location) || location.Curve == null) return false;
            Transform transform;
            try { transform = link.GetTotalTransform(); }
            catch { transform = link.GetTransform(); }
            var localPoint = transform.Inverse.OfPoint(worldPoint);
            IntersectionResult? projection;
            try { projection = location.Curve.Project(localPoint); } catch { return false; }
            if (projection == null) return false;
            var start = location.Curve.GetEndParameter(0);
            var end = location.Curve.GetEndParameter(1);
            if (!IsFinite(start) || !IsFinite(end) || Math.Abs(end - start) <= 1e-9) return false;
            chainage = Math.Max(0, Math.Min(1, (projection.Parameter - start) / (end - start)));
            return IsFinite(chainage);
        }

        private static XYZ? TryMapDirectionBetweenLinkedFamilyInstances(DeviceRecord source, AnchorRecord target, XYZ sourceWorldDirection)
        {
            if (!(source.PhysicalElement is FamilyInstance sourceFamily) || !(target.Element is FamilyInstance targetFamily) || target.Link == null) return null;
            try
            {
                var sourceInLink = GetLinkTransform(source.PhysicalLink).Inverse.OfVector(sourceWorldDirection);
                var sourceLocal = sourceFamily.GetTransform().Inverse.OfVector(sourceInLink);
                var targetWorld = GetLinkTransform(target.Link).OfVector(targetFamily.GetTransform().OfVector(sourceLocal));
                return targetWorld.GetLength() > 1e-9 ? targetWorld.Normalize() : null;
            }
            catch { return null; }
        }

        private static void ValidatePreparedPlacements(PreparedContext context)
        {
            if (context.Placements.Count != context.Devices.Count) throw new InvalidOperationException("prepared_placement_count_mismatch");
            for (var index = 0; index < context.Placements.Count; index++)
            {
                var placement = context.Placements[index];
                var planned = ToXyz(placement.Planned.TargetPoint);
                var resolved = placement.Face.PlacementPoint;
                if (planned.DistanceTo(resolved) > 0.75 || Math.Abs(planned.Z - resolved.Z) > 0.25)
                    throw new InvalidOperationException("resolved_face_displacement_exceeded:" + placement.Planned.SourceElementId);
                if (Math.Abs(placement.Face.FaceNormal.Z) > 0.25)
                    throw new InvalidOperationException("resolved_face_not_vertical:" + placement.Planned.SourceElementId);
                var touchesTargetRoom = HostedPlacementUtil.TryIsPointInSpatial(context.Target.Spatial.element, resolved) ||
                    HostedPlacementUtil.TryIsPointInSpatial(context.Target.Spatial.element, resolved + placement.Face.FaceNormal.Multiply(0.10)) ||
                    HostedPlacementUtil.TryIsPointInSpatial(context.Target.Spatial.element, resolved - placement.Face.FaceNormal.Multiply(0.10));
                if (!touchesTargetRoom)
                {
                    var targetHost = placement.Link.GetLinkDocument()?.GetElement(placement.LinkedElementId);
                    throw new InvalidOperationException("prepared_placement_outside_target_room:" + placement.Planned.SourceElementId + ":point=" + FormatPoint(resolved) + ",normal=" + FormatPoint(placement.Face.FaceNormal) +
                        ",anchor=" + (placement.Planned.TargetHostAnchorScopedId ?? "none") + ",linked=" + ElementIdCompat.GetValue(placement.LinkedElementId) +
                        ",category=" + (targetHost?.Category?.Name ?? "none") + ",name=" + (targetHost?.Name ?? "none") + ",basis=" + placement.PhysicalMappingBasis);
                }
                for (var other = 0; other < index; other++)
                {
                    var otherPoint = context.Placements[other].Face.PlacementPoint;
                    var separation = resolved.DistanceTo(otherPoint);
                    if (separation < 0.05)
                        throw new InvalidOperationException("prepared_placement_collision:" + placement.Planned.SourceElementId + ":other=" + context.Placements[other].Planned.SourceElementId +
                            ",point=" + FormatPoint(resolved) + ",other_point=" + FormatPoint(otherPoint) + ",distance=" + separation.ToString("F4", CultureInfo.InvariantCulture));
                }
                foreach (var opening in context.Target.Anchors.Where(anchor => anchor.Value.Category.Equals("Doors", StringComparison.OrdinalIgnoreCase)))
                    if (resolved.DistanceTo(ToXyz(opening.Value.Point)) < 0.25)
                        throw new InvalidOperationException("prepared_placement_opening_clearance:" + placement.Planned.SourceElementId);
            }
        }

        private static string FormatPoint(XYZ point)
        {
            return point.X.ToString("F3", CultureInfo.InvariantCulture) + "," + point.Y.ToString("F3", CultureInfo.InvariantCulture) + "," + point.Z.ToString("F3", CultureInfo.InvariantCulture);
        }

        private static RoomWallResolution ResolveCorrespondingBoundaryWall(SpatialRecord sourceRoom, SpatialRecord targetRoom, RoomWallResolution sourceWall, IEnumerable<RoomWallResolution> targetWalls, string sourceElementId)
        {
            var sourceMid = sourceWall.midpoint ?? sourceWall.geometrySegments.FirstOrDefault()?.midpoint ?? throw new InvalidOperationException("source_boundary_midpoint_missing:" + sourceElementId);
            var sourceNx = NormalizeCoordinate(sourceMid.X, sourceRoom.Frame.MinX, sourceRoom.Frame.WidthFt);
            var sourceNy = NormalizeCoordinate(sourceMid.Y, sourceRoom.Frame.MinY, sourceRoom.Frame.DepthFt);
            var sourceTangent = sourceWall.tangent ?? XYZ.BasisX;
            var ranked = targetWalls.Where(wall => wall.linkedElementId.HasValue && wall.midpoint != null).Select(wall =>
            {
                var targetMid = wall.midpoint!;
                var dx = NormalizeCoordinate(targetMid.X, targetRoom.Frame.MinX, targetRoom.Frame.WidthFt) - sourceNx;
                var dy = NormalizeCoordinate(targetMid.Y, targetRoom.Frame.MinY, targetRoom.Frame.DepthFt) - sourceNy;
                var positionCost = Math.Sqrt((dx * dx) + (dy * dy));
                var tangent = wall.tangent ?? XYZ.BasisX;
                var orientationCost = 1.0 - Math.Abs(sourceTangent.Normalize().DotProduct(tangent.Normalize()));
                var lengthCost = RatioDifference(sourceWall.boundaryLengthFt, wall.boundaryLengthFt);
                return new { Wall = wall, Cost = positionCost + (orientationCost * 2.0) + (lengthCost * 0.25) };
            }).OrderBy(item => item.Cost).ThenBy(item => item.Wall.linkedElementId).ToList();
            if (ranked.Count == 0) throw new InvalidOperationException("target_boundary_correspondence_missing:" + sourceElementId);
            if (ranked.Count > 1 && Math.Abs(ranked[1].Cost - ranked[0].Cost) <= 0.01 && ranked[1].Wall.linkedElementId != ranked[0].Wall.linkedElementId)
                throw new InvalidOperationException("target_boundary_correspondence_ambiguous:" + sourceElementId);
            return ranked[0].Wall;
        }

        private static RoomWallResolution? ResolveSourceBoundaryForPhysicalHost(DeviceRecord source, IEnumerable<RoomWallResolution> sourceWalls, XYZ sourcePoint, string sourceElementId)
        {
            var walls = sourceWalls.ToList();
            if (source.PhysicalBuiltInCategory.Equals("OST_Walls", StringComparison.OrdinalIgnoreCase) || source.PhysicalCategory.Equals("Walls", StringComparison.OrdinalIgnoreCase))
                return walls.SingleOrDefault(wall => wall.hostElementId == ElementIdCompat.GetValue(source.PhysicalLink.Id) && wall.linkedElementId == ElementIdCompat.GetValue(source.PhysicalLinkedElementId));
            if (!source.PhysicalBuiltInCategory.Equals("OST_Cornices", StringComparison.OrdinalIgnoreCase) && !source.PhysicalCategory.Equals("Wall Sweeps", StringComparison.OrdinalIgnoreCase))
                return null;
            if (source.PhysicalElement is WallSweep sweep)
            {
                var hostIds = new HashSet<long>(sweep.GetHostIds().Select(ElementIdCompat.GetValue));
                var exactHosts = walls.Where(wall => wall.hostElementId == ElementIdCompat.GetValue(source.PhysicalLink.Id) && wall.linkedElementId.HasValue && hostIds.Contains(wall.linkedElementId.Value)).ToList();
                if (exactHosts.Count == 1) return exactHosts[0];
                if (exactHosts.Count > 1) throw new InvalidOperationException("source_sweep_host_boundary_ambiguous:" + sourceElementId);
            }
            var ranked = walls.Select(wall =>
            {
                var distance = double.PositiveInfinity;
                if (HostedPlacementUtil.TryProjectPointToRoomWall(wall, sourcePoint, out var projected, out _, out _, out _)) distance = projected.DistanceTo(sourcePoint);
                return new { Wall = wall, Distance = distance };
            }).Where(item => IsFinite(item.Distance) && item.Distance <= 0.75).OrderBy(item => item.Distance).ThenBy(item => item.Wall.linkedElementId).ToList();
            if (ranked.Count == 0) return null;
            if (ranked.Count > 1 && Math.Abs(ranked[1].Distance - ranked[0].Distance) <= 0.01 && ranked[1].Wall.linkedElementId != ranked[0].Wall.linkedElementId)
                throw new InvalidOperationException("source_sweep_boundary_ambiguous:" + sourceElementId);
            return ranked[0].Wall;
        }

        private static bool TryResolveSourcePhysicalWall(DeviceRecord source, XYZ sourcePoint, out Wall wall, out string diagnostic)
        {
            wall = source.PhysicalElement as Wall;
            diagnostic = wall != null ? "direct_wall" : "uninitialized";
            if (wall != null) return true;
            if (!(source.PhysicalElement is WallSweep sweep)) { diagnostic = "source_not_wall_or_sweep"; return false; }
            var linkDocument = source.PhysicalLink.GetLinkDocument();
            if (linkDocument == null) { diagnostic = "link_document_missing"; return false; }
            Transform transform;
            try { transform = source.PhysicalLink.GetTotalTransform(); }
            catch { transform = source.PhysicalLink.GetTransform(); }
            var localPoint = transform.Inverse.OfPoint(sourcePoint);
            var candidates = new List<(Wall wall, double distance)>();
            foreach (var hostId in sweep.GetHostIds())
            {
                if (!(linkDocument.GetElement(hostId) is Wall hostWall) || !(hostWall.Location is LocationCurve location) || location.Curve == null) continue;
                var box = hostWall.get_BoundingBox(null);
                if (box == null || localPoint.Z < box.Min.Z - 0.10 || localPoint.Z > box.Max.Z + 0.10) continue;
                IntersectionResult? projection;
                try { projection = location.Curve.Project(localPoint); } catch { continue; }
                if (projection == null) continue;
                var projected = new XYZ(projection.XYZPoint.X, projection.XYZPoint.Y, localPoint.Z);
                var distance = projected.DistanceTo(localPoint);
                if (IsFinite(distance)) candidates.Add((hostWall, distance));
            }
            var ordered = candidates.OrderBy(candidate => candidate.distance).ThenBy(candidate => ElementIdCompat.GetValue(candidate.wall.Id)).ToList();
            diagnostic = "sweep_hosts=" + sweep.GetHostIds().Count + ",level_candidates=" + ordered.Count + (ordered.Count > 0 ? ",nearest=" + ordered[0].distance.ToString("F3", CultureInfo.InvariantCulture) : string.Empty);
            if (ordered.Count == 0) return false;
            if (ordered.Count > 1 && Math.Abs(ordered[1].distance - ordered[0].distance) <= 0.10)
            {
                diagnostic += ",ambiguous=" + ElementIdCompat.GetValue(ordered[0].wall.Id) + "|" + ElementIdCompat.GetValue(ordered[1].wall.Id);
                return false;
            }
            wall = ordered[0].wall;
            return true;
        }

        private static bool TryPointAtNormalizedChainage(RoomWallResolution wall, double normalizedChainage, out XYZ point, out XYZ tangent)
        {
            point = XYZ.Zero;
            tangent = XYZ.BasisX;
            if (!IsFinite(normalizedChainage) || wall.geometrySegments == null || wall.geometrySegments.Count == 0 || wall.boundaryLengthFt <= 1e-9) return false;
            var remaining = Math.Max(0.0, Math.Min(1.0, normalizedChainage)) * wall.boundaryLengthFt;
            foreach (var segment in wall.geometrySegments)
            {
                if (segment == null || segment.lengthFt <= 1e-9) continue;
                if (remaining <= segment.lengthFt + 1e-9)
                {
                    tangent = segment.direction.GetLength() > 1e-9 ? segment.direction.Normalize() : XYZ.BasisX;
                    point = segment.start + tangent.Multiply(Math.Max(0.0, Math.Min(segment.lengthFt, remaining)));
                    return true;
                }
                remaining -= segment.lengthFt;
            }
            var last = wall.geometrySegments.LastOrDefault(segment => segment != null && segment.lengthFt > 1e-9);
            if (last == null) return false;
            point = last.end;
            tangent = last.direction.GetLength() > 1e-9 ? last.direction.Normalize() : XYZ.BasisX;
            return true;
        }

        private static CreationReceipt CreateAndVerify(PreparedContext context, string transactionName)
        {
            var receipt = new CreationReceipt();
            using var transaction = new Transaction(context.Document, transactionName);
            if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("analog_create_transaction_start_failed");
            transaction.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(transaction, receipt.Failures, rollbackOnErrors: true, deleteWarnings: true));
            try
            {
                foreach (var placement in context.Placements)
                {
                    var symbol = placement.Source.Instance.Symbol ?? throw new InvalidOperationException("source_symbol_missing");
                    if (!symbol.IsActive) { symbol.Activate(); context.Document.Regenerate(); }
                    var created = context.Document.Create.NewFamilyInstance(placement.Face.FaceReference, placement.Face.PlacementPoint, placement.Face.ReferenceDirection, symbol);
                    receipt.CreatedIds.Add(ElementIdCompat.GetValue(created.Id));
                }
                context.Document.Regenerate();
                AssignRequestedCircuits(context, receipt);
                for (var index = 0; index < receipt.CreatedIds.Count; index++)
                {
                    var placement = context.Placements[index];
                    var created = context.Document.GetElement(ElementIdCompat.Create(receipt.CreatedIds[index])) as FamilyInstance ?? throw new InvalidOperationException("created_instance_missing");
                    var point = HostedPlacementUtil.TryGetElementPoint(created) ?? throw new InvalidOperationException("created_point_missing");
                    if (created.GetTypeId() != placement.Source.Instance.GetTypeId()) throw new InvalidOperationException("created_type_mismatch");
                    if (!HostedPlacementUtil.TryIsPointInSpatial(context.Target.Spatial.element, point)) throw new InvalidOperationException("created_outside_target_room");
                    var hostFace = created.HostFace;
                    if (hostFace == null || hostFace.LinkedElementId != placement.LinkedElementId) throw new InvalidOperationException("created_linked_host_mismatch");
                    if (point.DistanceTo(placement.Face.PlacementPoint) > PlacementToleranceFt) throw new InvalidOperationException("created_position_mismatch");
                    var hand = SafeDirection(created.HandOrientation);
                    var orientationAgreement = hand.DotProduct(placement.Face.ReferenceDirection);
                    if (!IsFinite(orientationAgreement) || orientationAgreement < 0.98) throw new InvalidOperationException("created_orientation_mismatch");
                    var facingAgreement = Math.Abs(SafeDirection(created.GetTransform().BasisZ).DotProduct(placement.Face.FaceNormal));
                    if (!IsFinite(facingAgreement) || facingAgreement < 0.95) throw new InvalidOperationException("created_facing_mismatch");
                    var actualPowerSystems = GetPowerSystems(created);
                    var expectedPowerSystem = placement.Source.SourcePowerSystem;
                    if (context.CircuitMode == CircuitMatchPolicy.MatchSourceSystem)
                    {
                        var actualIds = actualPowerSystems.Select(system => ElementIdCompat.GetValue(system.Id)).ToList();
                        var expectedId = expectedPowerSystem == null ? (long?)null : ElementIdCompat.GetValue(expectedPowerSystem.Id);
                        var exactMatch = expectedId.HasValue
                            ? CircuitMatchPolicy.HasExactMembership(expectedId.Value, actualIds)
                            : actualIds.Count == 0 && !HasCircuit(created);
                        if (!exactMatch) throw new InvalidOperationException("created_power_system_membership_mismatch:" + receipt.CreatedIds[index]);
                        receipt.CircuitAssignments.Add(new
                        {
                            sourceElementId = ElementIdCompat.GetValue(placement.Source.Instance.Id),
                            createdElementId = receipt.CreatedIds[index],
                            expectedSystemId = expectedId,
                            actualPowerSystemIds = actualIds,
                            exactMatch = true,
                            status = expectedId.HasValue ? "matched_exact_source_power_system" : "source_unassigned_state_preserved",
                            engineeringReviewRequired = !expectedId.HasValue
                        });
                    }
                    else if (actualPowerSystems.Count != 0 || HasCircuit(created))
                    {
                        throw new InvalidOperationException("created_unexpected_circuit_membership");
                    }
                    receipt.Readback.Add(new
                    {
                        id = receipt.CreatedIds[index],
                        family = created.Symbol?.FamilyName,
                        type = created.Symbol?.Name,
                        point = HostedPlacementUtil.BuildVector(point),
                        targetRoomNumber = context.Target.Spatial.number,
                        orientation = new { hand = HostedPlacementUtil.BuildVector(hand), expected = HostedPlacementUtil.BuildVector(placement.Face.ReferenceDirection), agreement = orientationAgreement, facingAgreement, created.HandFlipped, created.FacingFlipped, created.Mirrored },
                        physicalHost = new { linkInstanceId = ElementIdCompat.GetValue(placement.Link.Id), linkedElementId = ElementIdCompat.GetValue(placement.LinkedElementId), placement.PhysicalMappingBasis, faceFingerprint = placement.Face.FaceFingerprint },
                        semanticAnchor = new { source = placement.Planned.SourceAnchorScopedId, target = placement.Planned.TargetHostAnchorScopedId },
                        circuit = HostedPlacementUtil.BuildElectricalCircuitAuditPayload(created)
                    });
                }
                if (transaction.Commit() != TransactionStatus.Committed || FailureHandlingUtil.HasErrors(receipt.Failures)) throw new InvalidOperationException("analog_create_transaction_commit_failed");
                return receipt;
            }
            catch
            {
                try { transaction.RollBack(); } catch { }
                throw;
            }
        }

        private static void AssignRequestedCircuits(PreparedContext context, CreationReceipt receipt)
        {
            if (context.CircuitMode != CircuitMatchPolicy.MatchSourceSystem) return;
            var indexed = context.Placements.Select((placement, index) => new { placement, index }).ToList();
            foreach (var group in indexed.Where(item => item.placement.Source.SourcePowerSystem != null).GroupBy(item => ElementIdCompat.GetValue(item.placement.Source.SourcePowerSystem!.Id)).OrderBy(group => group.Key))
            {
                if (group.Key <= 0) throw new InvalidOperationException("source_power_system_invalid_for_assignment");
                var system = group.First().placement.Source.SourcePowerSystem ?? throw new InvalidOperationException("source_power_system_missing_for_assignment");
                var before = CaptureCircuitSnapshot(system);
                var components = new ElementSet();
                foreach (var item in group)
                {
                    var created = context.Document.GetElement(ElementIdCompat.Create(receipt.CreatedIds[item.index]));
                    if (created == null || !components.Insert(created)) throw new InvalidOperationException("created_circuit_component_set_failed");
                }
                if (!system.AddToCircuit(components)) throw new InvalidOperationException("source_power_system_add_failed:" + group.Key);
                context.Document.Regenerate();
                var after = CaptureCircuitSnapshot(system);
                receipt.CircuitSystems.Add(new
                {
                    systemId = group.Key,
                    addedElementIds = group.Select(item => receipt.CreatedIds[item.index]).ToList(),
                    before,
                    after,
                    factualLoadDelta = new
                    {
                        unitBasis = "Revit internal electrical units",
                        trueLoad = CircuitMatchPolicy.FactualDelta(before.TrueLoadInternal, after.TrueLoadInternal),
                        apparentLoad = CircuitMatchPolicy.FactualDelta(before.ApparentLoadInternal, after.ApparentLoadInternal)
                    },
                    complianceDetermination = (string?)null
                });
            }
        }

        private static void VerifyPersistentInventory(PreparedContext context, IReadOnlyCollection<long> createdIds)
        {
            var actual = FindReceptacles(context.Document, context.Target.Spatial.element);
            if (actual.Count != createdIds.Count || actual.Any(instance => !createdIds.Contains(ElementIdCompat.GetValue(instance.Id))))
                throw new InvalidOperationException("post_commit_target_inventory_mismatch");
            var expectedTypes = context.Devices.GroupBy(device => FamilyTypeKey(device.Instance), StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal);
            var actualTypes = actual.GroupBy(FamilyTypeKey, StringComparer.Ordinal).ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal);
            if (expectedTypes.Count != actualTypes.Count || expectedTypes.Any(pair => !actualTypes.TryGetValue(pair.Key, out var count) || count != pair.Value))
                throw new InvalidOperationException("post_commit_type_inventory_mismatch");
            for (var index = 0; index < context.Placements.Count; index++)
            {
                var created = context.Document.GetElement(ElementIdCompat.Create(createdIds.ElementAt(index))) as FamilyInstance
                    ?? throw new InvalidOperationException("post_commit_created_instance_missing");
                var powerSystemIds = GetPowerSystems(created).Select(system => ElementIdCompat.GetValue(system.Id)).ToList();
                if (context.CircuitMode == CircuitMatchPolicy.MatchSourceSystem)
                {
                    var expectedSystem = context.Placements[index].Source.SourcePowerSystem;
                    var exactMatch = expectedSystem != null
                        ? CircuitMatchPolicy.HasExactMembership(ElementIdCompat.GetValue(expectedSystem.Id), powerSystemIds)
                        : powerSystemIds.Count == 0 && !HasCircuit(created);
                    if (!exactMatch)
                        throw new InvalidOperationException("post_commit_power_system_membership_mismatch:" + ElementIdCompat.GetValue(created.Id));
                }
                else if (powerSystemIds.Count != 0 || HasCircuit(created))
                {
                    throw new InvalidOperationException("post_commit_unexpected_circuit_membership:" + ElementIdCompat.GetValue(created.Id));
                }
            }
        }

        private static (string? path, int? widthPx, int? heightPx) ExportPreview(PreparedContext context, IList<long> ids, List<string> warnings)
        {
            var labels = context.Placements.Select(placement => new PlacementPreviewLabel
            {
                text = placement.Source.Instance.Symbol?.Name ?? "receptacle",
                point = placement.Face.PlacementPoint,
                // Keep the review image legible: the full physical mapping receipt is
                // already returned as structured JSON for audit/debugging.
                secondaryText = null,
                direction = placement.Face.ReferenceDirection,
                directionLengthFt = 1.0
            }).ToList();
            return HostedPlacementUtil.ExportPlacementPreview(context.Document, context.PlanView, ids, labels, 2200, 6.0, warnings);
        }

        private static object BuildResponse(PreparedContext context, CreationReceipt receipt, (string? path, int? widthPx, int? heightPx) preview, List<string> warnings, long elapsedMs, bool applied)
        {
            return new
            {
                schema = DwellingReceptacleAnalogRuntime.PlanSchema,
                status = applied ? "applied" : "ready",
                ready = true,
                applied,
                planHash = context.PlanHash,
                source = SpatialPayload(context.Source),
                target = SpatialPayload(context.Target),
                view = new { id = ElementIdCompat.GetValue(context.PlanView.Id), name = context.PlanView.Name, referenceViewId = ElementIdCompat.GetValue(context.ReferenceView.Id) },
                candidateSelection = context.Selection,
                typeCounts = context.Devices.GroupBy(device => FamilyTypeKey(device.Instance), StringComparer.Ordinal).OrderBy(group => group.Key, StringComparer.Ordinal).Select(group => new { familyType = group.Key, count = group.Count() }).ToList(),
                mappings = context.Placements.Select(placement => new
                {
                    sourceElementId = ElementIdCompat.GetValue(placement.Source.Instance.Id),
                    family = placement.Source.Instance.Symbol?.FamilyName,
                    type = placement.Source.Instance.Symbol?.Name,
                    sourcePoint = HostedPlacementUtil.BuildVector(HostedPlacementUtil.TryGetElementPoint(placement.Source.Instance)),
                    targetPoint = HostedPlacementUtil.BuildVector(placement.Face.PlacementPoint),
                    mappingBasis = placement.Planned.MappingBasis,
                    semanticAnchor = new { source = placement.Planned.SourceAnchorScopedId, target = placement.Planned.TargetHostAnchorScopedId, signature = placement.Planned.TargetAnchorSignature },
                    physicalHost = new { sourceLinkedElementId = ElementIdCompat.GetValue(placement.Source.PhysicalLinkedElementId), targetLinkedElementId = ElementIdCompat.GetValue(placement.LinkedElementId), linkInstanceId = ElementIdCompat.GetValue(placement.Link.Id), placement.PhysicalMappingBasis, faceFingerprint = placement.Face.FaceFingerprint },
                    sourceCircuit = new
                    {
                        panel = EmptyToNull(placement.Source.SourceCircuitPanel),
                        circuitNumber = EmptyToNull(placement.Source.SourceCircuitNumber),
                        systemId = placement.Source.SourceCircuitSnapshot?.SystemId,
                        system = placement.Source.SourceCircuitSnapshot,
                        policy = context.CircuitMode == CircuitMatchPolicy.MatchSourceSystem ? "match_exact_source_power_system" : "record_source_do_not_copy"
                    }
                }).ToList(),
                circuitValidation = new
                {
                    mode = context.CircuitMode,
                    attempted = context.CircuitMode == CircuitMatchPolicy.MatchSourceSystem,
                    verified = context.CircuitMode == CircuitMatchPolicy.MatchSourceSystem
                        ? receipt.CircuitAssignments.Count == context.Placements.Count
                        : receipt.CircuitAssignments.Count == 0,
                    assignments = receipt.CircuitAssignments,
                    systems = receipt.CircuitSystems,
                    assignedCount = context.Placements.Count(placement => placement.Source.SourcePowerSystem != null),
                    unassignedCount = context.Placements.Count(placement => placement.Source.SourcePowerSystem == null),
                    engineeringReviewRequired = context.Placements.Any(placement => placement.Source.SourcePowerSystem == null),
                    scope = "Factual Revit system membership and before/after panel-circuit-load readback only; no capacity, breaker, conductor, demand, code, or AHJ compliance determination."
                },
                readback = applied ? receipt.Readback : new List<object>(),
                previewVerification = applied ? null : new { temporaryCount = receipt.Readback.Count, verified = receipt.Readback.Count == context.Placements.Count, idsPersisted = false },
                createdIds = applied ? receipt.CreatedIds : new List<long>(),
                preview = preview.path == null ? null : new { preview.path, preview.widthPx, preview.heightPx },
                necAdvisory = new { profile = "DWELLING-RECEPTACLES-V1", authoritative = false, note = "The verified project analog controls exact count/type/semantic placement; NEC-derived spacing remains advisory." },
                timings = new { totalMs = elapsedMs },
                nativeFailures = receipt.Failures,
                warnings
            };
        }

        private static object SpatialPayload(SpatialRecord record) => new
        {
            id = record.Spatial.id,
            number = record.Spatial.number,
            name = record.Spatial.name,
            kind = record.Spatial.kind,
            record.AreaFt2,
            record.BoundaryLengthFt,
            receptacleCount = record.Receptacles.Count,
            curatedAnchorCount = record.Anchors.Count
        };

        private static SpatialRecord BuildSpatialRecord(Document document, ResolvedSpatialContext spatial)
        {
            var bbox = spatial.element.get_BoundingBox(null) ?? throw new InvalidOperationException("spatial_bounding_box_missing:" + spatial.number);
            var frame = new DwellingReceptacleAnalogRoomFrame
            {
                RoomScopedId = spatial.id.ToString(CultureInfo.InvariantCulture),
                MinX = bbox.Min.X,
                MinY = bbox.Min.Y,
                WidthFt = bbox.Max.X - bbox.Min.X,
                DepthFt = bbox.Max.Y - bbox.Min.Y,
                FloorZ = ResolveFloorZ(document, spatial.element, bbox.Min.Z)
            };
            var record = new SpatialRecord
            {
                Spatial = spatial,
                Frame = frame,
                Receptacles = FindReceptacles(document, spatial.element),
                AreaFt2 = ResolveArea(spatial.element),
                BoundaryLengthFt = ResolveBoundaryLength(spatial.element),
                Centroid = (bbox.Min + bbox.Max).Multiply(0.5),
                LevelScopedId = ElementIdCompat.GetValue(spatial.element.LevelId).ToString(CultureInfo.InvariantCulture)
            };
            record.Anchors = FindCuratedAnchors(document, spatial.element);
            UnionExactReferencedNonWallHosts(document, record);
            return record;
        }

        private static void UnionExactReferencedNonWallHosts(Document document, SpatialRecord record)
        {
            var known = new HashSet<string>(record.Anchors.Where(anchor => anchor.Link != null).Select(anchor => AnchorKey(anchor.Link!.Id, anchor.LinkedElementId)), StringComparer.Ordinal);
            foreach (var instance in record.Receptacles)
            {
                var hostFace = instance.HostFace;
                if (hostFace == null || hostFace.LinkedElementId == ElementId.InvalidElementId) continue;
                var link = document.GetElement(hostFace.ElementId) as RevitLinkInstance ?? instance.Host as RevitLinkInstance;
                var linkedDocument = link?.GetLinkDocument();
                var element = linkedDocument?.GetElement(hostFace.LinkedElementId);
                if (link == null || linkedDocument == null || element?.Category == null) continue;
                var builtIn = BuiltInCategoryName(element.Category.Id);
                if (IsWallCategory(builtIn, element.Category.Name ?? string.Empty)) continue;
                var exactWallSweep = builtIn.Equals("OST_Cornices", StringComparison.OrdinalIgnoreCase);
                if (!DwellingReceptacleAnalogRuntime.IsCuratedAnchorCategory(element.Category.Name, exactWallSweep)) continue;
                var key = AnchorKey(link.Id, element.Id);
                if (!known.Add(key)) continue;
                var local = TryElementPoint(element);
                if (local == null) throw new InvalidOperationException("referenced_curated_host_point_missing:" + ElementIdCompat.GetValue(element.Id));
                var world = GetLinkTransform(link).OfPoint(local);
                var (family, type) = FamilyAndType(linkedDocument, element);
                var scopedId = $"link:{ElementIdCompat.GetValue(link.Id)}:{ElementIdCompat.GetValue(element.Id)}";
                record.Anchors.Add(new AnchorRecord
                {
                    Link = link,
                    LinkedElementId = element.Id,
                    Element = element,
                    Value = new DwellingReceptacleAnalogAnchor { ScopedId = scopedId, HostScopedId = scopedId, Category = element.Category.Name ?? string.Empty, Family = family, Type = type, Point = ToPoint3(world) }
                });
            }
            record.Anchors = record.Anchors.OrderBy(anchor => anchor.Value.ScopedId, StringComparer.Ordinal).ToList();
        }

        private static IEnumerable<SpatialRecord> EnumerateCandidateSpatials(Document document, SpatialRecord target)
        {
            // Room and Space are managed wrapper types that Revit does not accept in
            // ElementClassFilter/OfClass after a clean add-in load. Collect their
            // native categories, then postprocess as SpatialElement instead.
            var category = target.Spatial.element is Space ? BuiltInCategory.OST_MEPSpaces : BuiltInCategory.OST_Rooms;
            foreach (var element in new FilteredElementCollector(document).WhereElementIsNotElementType().OfCategory(category).OfType<SpatialElement>().OrderBy(element => ElementIdCompat.GetValue(element.Id)))
            {
                if (element.Id == target.Spatial.element.Id || element.LevelId != target.Spatial.element.LevelId) continue;
                var resolved = HostedPlacementUtil.FindSpatialElement(document, ElementIdCompat.GetValue(element.Id), null);
                if (resolved == null) continue;
                SpatialRecord candidate;
                try { candidate = BuildSpatialRecord(document, resolved); } catch { continue; }
                if (candidate.Receptacles.Count > 0) yield return candidate;
            }
        }

        private static DwellingReceptacleAnalogCandidate ToCandidate(Document document, SpatialRecord record, SpatialRecord target, bool usedSemanticOnly)
        {
            var signatures = usedSemanticOnly
                ? BuildDeviceRecords(document, record, CircuitMatchPolicy.None).Select(device => device.PlannerDevice.SourceHostSignature).Where(signature => !string.IsNullOrWhiteSpace(signature)).Cast<string>().OrderBy(signature => signature, StringComparer.Ordinal).ToList()
                : record.Anchors.Select(anchor => DwellingReceptacleAnalogPlanner.NormalizedSignature(anchor.Value)).ToList();
            return new DwellingReceptacleAnalogCandidate
            {
                RoomScopedId = record.Spatial.id.ToString(CultureInfo.InvariantCulture),
                RoomNumber = record.Spatial.number,
                RoomName = record.Spatial.name,
                LevelScopedId = record.LevelScopedId,
                AreaFt2 = record.AreaFt2,
                BoundaryLengthFt = record.BoundaryLengthFt,
                CentroidDistanceFt = record.Centroid.DistanceTo(target.Centroid),
                ReceptacleCount = record.Receptacles.Count,
                AnchorLayoutSimilarity = usedSemanticOnly ? ComputeAnchorLayoutSimilarity(record, target, signatures) : 1.0,
                CuratedAnchorSignatures = signatures
            };
        }

        private static double ComputeAnchorLayoutSimilarity(SpatialRecord source, SpatialRecord target, IEnumerable<string> usedSignatures)
        {
            var signatures = new HashSet<string>(usedSignatures.Where(signature => !string.IsNullOrWhiteSpace(signature)), StringComparer.Ordinal);
            if (signatures.Count == 0) return 0.0;
            var sourceBySignature = source.Anchors.Where(anchor => signatures.Contains(DwellingReceptacleAnalogPlanner.NormalizedSignature(anchor.Value)))
                .GroupBy(anchor => DwellingReceptacleAnalogPlanner.NormalizedSignature(anchor.Value), StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.ToList(), StringComparer.Ordinal);
            var targetBySignature = target.Anchors.Where(anchor => signatures.Contains(DwellingReceptacleAnalogPlanner.NormalizedSignature(anchor.Value)))
                .GroupBy(anchor => DwellingReceptacleAnalogPlanner.NormalizedSignature(anchor.Value), StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.ToList(), StringComparer.Ordinal);
            var similarities = new List<double>();
            foreach (var signature in signatures.OrderBy(value => value, StringComparer.Ordinal))
            {
                if (!sourceBySignature.TryGetValue(signature, out var sourceAnchors) || !targetBySignature.TryGetValue(signature, out var targetAnchors)) return 0.0;
                foreach (var sourceAnchor in sourceAnchors)
                {
                    var sx = NormalizeCoordinate(sourceAnchor.Value.Point.X, source.Frame.MinX, source.Frame.WidthFt);
                    var sy = NormalizeCoordinate(sourceAnchor.Value.Point.Y, source.Frame.MinY, source.Frame.DepthFt);
                    var nearest = targetAnchors.Min(targetAnchor =>
                    {
                        var tx = NormalizeCoordinate(targetAnchor.Value.Point.X, target.Frame.MinX, target.Frame.WidthFt);
                        var ty = NormalizeCoordinate(targetAnchor.Value.Point.Y, target.Frame.MinY, target.Frame.DepthFt);
                        var dx = sx - tx;
                        var dy = sy - ty;
                        return Math.Sqrt((dx * dx) + (dy * dy));
                    });
                    similarities.Add(Math.Max(0.0, 1.0 - (nearest / Math.Sqrt(2.0))));
                }
            }
            return similarities.Count == 0 ? 0.0 : similarities.Average();
        }

        private static List<AnchorRecord> FindCuratedAnchors(Document document, SpatialElement spatial)
        {
            var result = new List<AnchorRecord>();
            var categories = new[] { BuiltInCategory.OST_Casework, BuiltInCategory.OST_PlumbingFixtures, BuiltInCategory.OST_Doors, BuiltInCategory.OST_GenericModel, BuiltInCategory.OST_Cornices };
            foreach (var link in new FilteredElementCollector(document).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>().OrderBy(link => ElementIdCompat.GetValue(link.Id)))
            {
                var linkDocument = link.GetLinkDocument();
                if (linkDocument == null) continue;
                var transform = GetLinkTransform(link);
                foreach (var element in new FilteredElementCollector(linkDocument).WhereElementIsNotElementType().WherePasses(new ElementMulticategoryFilter(categories)))
                {
                    var local = TryElementPoint(element);
                    if (local == null) continue;
                    var world = transform.OfPoint(local);
                    var category = element.Category?.Name ?? string.Empty;
                    var exactWallSweep = element.Category != null && BuiltInCategoryName(element.Category.Id).Equals("OST_Cornices", StringComparison.OrdinalIgnoreCase);
                    if (!HostedPlacementUtil.TryIsPointInSpatial(spatial, world) && !(exactWallSweep && DoesLinkedElementIntersectSpatialBounds(element, transform, spatial, 1.0))) continue;
                    if (!DwellingReceptacleAnalogRuntime.IsCuratedAnchorCategory(category, exactWallSweep)) continue;
                    var (family, type) = FamilyAndType(linkDocument, element);
                    var scopedId = $"link:{ElementIdCompat.GetValue(link.Id)}:{ElementIdCompat.GetValue(element.Id)}";
                    result.Add(new AnchorRecord
                    {
                        Link = link,
                        LinkedElementId = element.Id,
                        Element = element,
                        Value = new DwellingReceptacleAnalogAnchor
                        {
                            ScopedId = scopedId,
                            HostScopedId = scopedId,
                            Category = category,
                            Family = family,
                            Type = type,
                            Point = ToPoint3(world)
                        }
                    });
                }
            }
            foreach (var element in new FilteredElementCollector(document).OfCategory(BuiltInCategory.OST_ElectricalEquipment).WhereElementIsNotElementType())
            {
                var point = TryElementPoint(element);
                if (point == null || !HostedPlacementUtil.TryIsPointInSpatial(spatial, point)) continue;
                var (family, type) = FamilyAndType(document, element);
                var scopedId = $"host:{ElementIdCompat.GetValue(element.Id)}";
                result.Add(new AnchorRecord
                {
                    Element = element,
                    Value = new DwellingReceptacleAnalogAnchor { ScopedId = scopedId, HostScopedId = scopedId, Category = "Electrical Equipment", Family = family, Type = type, Point = ToPoint3(point) }
                });
            }
            return result.OrderBy(anchor => anchor.Value.ScopedId, StringComparer.Ordinal).ToList();
        }

        private static List<DeviceRecord> BuildDeviceRecords(Document document, SpatialRecord source, string circuitMode)
        {
            var byPhysicalHost = source.Anchors.Where(anchor => anchor.Link != null).ToDictionary(anchor => AnchorKey(anchor.Link!.Id, anchor.LinkedElementId), StringComparer.Ordinal);
            var semanticCandidates = source.Anchors.Where(anchor => !IsWallCategory(anchor.Value.Category, anchor.Value.Category)).ToList();
            var result = new List<DeviceRecord>();
            foreach (var instance in source.Receptacles.OrderBy(instance => ElementIdCompat.GetValue(instance.Id)))
            {
                var hostFace = instance.HostFace ?? throw new InvalidOperationException("source_receptacle_host_face_missing:" + ElementIdCompat.GetValue(instance.Id));
                var link = document.GetElement(hostFace.ElementId) as RevitLinkInstance ?? instance.Host as RevitLinkInstance;
                if (link == null || hostFace.LinkedElementId == ElementId.InvalidElementId) throw new InvalidOperationException("source_receptacle_linked_host_missing:" + ElementIdCompat.GetValue(instance.Id));
                var physical = link.GetLinkDocument()?.GetElement(hostFace.LinkedElementId) ?? throw new InvalidOperationException("source_receptacle_linked_element_missing");
                var physicalCategory = physical.Category?.Name ?? string.Empty;
                var physicalBuiltIn = physical.Category == null ? string.Empty : BuiltInCategoryName(physical.Category.Id);
                AnchorRecord? semantic = null;
                var semanticHostIsExactPhysical = false;
                if (!IsWallCategory(physicalBuiltIn, physicalCategory) && byPhysicalHost.TryGetValue(AnchorKey(link.Id, hostFace.LinkedElementId), out semantic)) semanticHostIsExactPhysical = true;
                if (semantic == null && !IsWallCategory(physicalBuiltIn, physicalCategory) && IsSemanticDeviceType(instance))
                {
                    var point = HostedPlacementUtil.TryGetElementPoint(instance) ?? XYZ.Zero;
                    semantic = semanticCandidates.Select(anchor => new { Anchor = anchor, Distance = ToXyz(anchor.Value.Point).DistanceTo(point) }).Where(item => item.Distance <= SemanticDistanceFt).OrderBy(item => item.Distance).ThenBy(item => item.Anchor.Value.ScopedId, StringComparer.Ordinal).Select(item => item.Anchor).FirstOrDefault();
                }
                var planner = new DwellingReceptacleReferenceDevice
                {
                    ElementId = ElementIdCompat.GetValue(instance.Id).ToString(CultureInfo.InvariantCulture),
                    FamilyTypeKey = FamilyTypeKey(instance),
                    Point = ToPoint3(HostedPlacementUtil.TryGetElementPoint(instance) ?? throw new InvalidOperationException("source_receptacle_point_missing"))
                };
                if (semantic != null)
                {
                    planner.SourceHostScopedId = semantic.Value.ScopedId;
                    planner.SourceHostSignature = DwellingReceptacleAnalogPlanner.NormalizedSignature(semantic.Value);
                    planner.SourceHostCategory = semantic.Value.Category;
                }
                var sourcePowerSystem = circuitMode == CircuitMatchPolicy.MatchSourceSystem
                    ? ResolveSourcePowerSystemState(instance)
                    : null;
                var sourceCircuitSnapshot = sourcePowerSystem == null ? null : CaptureCircuitSnapshot(sourcePowerSystem);
                if (sourceCircuitSnapshot != null && (!sourceCircuitSnapshot.PanelElementId.HasValue || string.IsNullOrWhiteSpace(sourceCircuitSnapshot.PanelName) || string.IsNullOrWhiteSpace(sourceCircuitSnapshot.CircuitNumber)))
                    throw new InvalidOperationException("source_power_system_not_panel_assigned:" + ElementIdCompat.GetValue(instance.Id));
                result.Add(new DeviceRecord
                {
                    Instance = instance,
                    PlannerDevice = planner,
                    PhysicalLink = link,
                    PhysicalLinkedElementId = hostFace.LinkedElementId,
                    PhysicalCategory = physicalCategory,
                    PhysicalBuiltInCategory = physicalBuiltIn,
                    PhysicalUniqueId = physical.UniqueId ?? string.Empty,
                    PhysicalElement = physical,
                    SourceHostStableReference = SafeStableReference(document, hostFace),
                    SourceCircuitPanel = ReadParameter(instance, "Panel"),
                    SourceCircuitNumber = ReadParameter(instance, "Circuit Number"),
                    SourcePowerSystem = sourcePowerSystem,
                    SourceCircuitSnapshot = sourceCircuitSnapshot,
                    PreferredDirection = SafeDirection(instance.HandOrientation),
                    SemanticHostIsExactPhysical = semanticHostIsExactPhysical
                });
            }
            return result;
        }

        private static double ResolveSemanticDistanceThreshold(IEnumerable<DeviceRecord> devices, IEnumerable<AnchorRecord> anchors)
        {
            var byId = anchors.ToDictionary(anchor => anchor.Value.ScopedId, StringComparer.Ordinal);
            var threshold = SemanticDistanceFt;
            foreach (var device in devices.Where(device => device.SemanticHostIsExactPhysical && !string.IsNullOrWhiteSpace(device.PlannerDevice.SourceHostScopedId)))
            {
                if (!byId.TryGetValue(device.PlannerDevice.SourceHostScopedId!, out var anchor)) throw new InvalidOperationException("exact_semantic_host_missing:" + device.PlannerDevice.ElementId);
                var distance = ToXyz(device.PlannerDevice.Point).DistanceTo(ToXyz(anchor.Value.Point));
                if (!IsFinite(distance) || distance > 50.0) throw new InvalidOperationException("exact_semantic_host_offset_invalid:" + device.PlannerDevice.ElementId);
                threshold = Math.Max(threshold, distance + 0.01);
            }
            return threshold;
        }

        private static List<FamilyInstance> FindReceptacles(Document document, SpatialElement spatial) => new FilteredElementCollector(document)
            .OfCategory(BuiltInCategory.OST_ElectricalFixtures)
            .WhereElementIsNotElementType()
            .OfType<FamilyInstance>()
            .Where(instance => IsReceptacle(instance) && HostedPlacementUtil.TryGetElementPoint(instance) is XYZ point && HostedPlacementUtil.TryIsPointInSpatial(spatial, point))
            .OrderBy(instance => ElementIdCompat.GetValue(instance.Id))
            .ToList();

        private static string ComputePlanHash(PreparedContext context)
        {
            var fields = new List<KeyValuePair<string, string>>
            {
                Pair("schema", DwellingReceptacleAnalogRuntime.PlanSchema),
                Pair("document.title", context.Document.Title ?? string.Empty),
                Pair("document.path", context.Document.PathName ?? string.Empty),
                Pair("document.project", context.Document.ProjectInformation?.UniqueId ?? string.Empty),
                Pair("source.room", context.Source.Spatial.id.ToString(CultureInfo.InvariantCulture)),
                Pair("target.room", context.Target.Spatial.id.ToString(CultureInfo.InvariantCulture)),
                Pair("view", ElementIdCompat.GetValue(context.PlanView.Id).ToString(CultureInfo.InvariantCulture)),
                Pair("circuit.mode", context.CircuitMode)
            };
            foreach (var anchor in context.Source.Anchors.OrderBy(anchor => anchor.Value.ScopedId, StringComparer.Ordinal)) fields.Add(Pair("source.anchor." + anchor.Value.ScopedId, AnchorFingerprint(anchor)));
            foreach (var anchor in context.Target.Anchors.OrderBy(anchor => anchor.Value.ScopedId, StringComparer.Ordinal)) fields.Add(Pair("target.anchor." + anchor.Value.ScopedId, AnchorFingerprint(anchor)));
            foreach (var placement in context.Placements.OrderBy(placement => placement.Source.PlannerDevice.ElementId, StringComparer.Ordinal))
            {
                var prefix = "placement." + placement.Source.PlannerDevice.ElementId;
                fields.Add(Pair(prefix + ".symbol", placement.Source.Instance.Symbol?.UniqueId ?? string.Empty));
                fields.Add(Pair(prefix + ".point", PointFingerprint(placement.Face.PlacementPoint)));
                fields.Add(Pair(prefix + ".semantic", (placement.Planned.TargetHostAnchorScopedId ?? string.Empty) + "|" + (placement.Planned.TargetAnchorSignature ?? string.Empty)));
                fields.Add(Pair(prefix + ".physical", placement.Face.LinkedElementUniqueId + "|" + placement.Face.FaceFingerprint));
                fields.Add(Pair(prefix + ".source_circuit", placement.Source.SourceCircuitPanel + "|" + placement.Source.SourceCircuitNumber));
                fields.Add(Pair(prefix + ".source_system", CircuitFingerprint(placement.Source.SourceCircuitSnapshot)));
            }
            return DwellingReceptacleAnalogRuntime.ComputePlanHash(fields);
        }

        private static string AnchorFingerprint(AnchorRecord anchor) => string.Join("|", new[] { DwellingReceptacleAnalogPlanner.NormalizedSignature(anchor.Value), anchor.Element?.UniqueId ?? string.Empty, PointFingerprint(ToXyz(anchor.Value.Point)) });
        private static string PointFingerprint(XYZ point) => string.Join(",", new[] { DwellingReceptacleAnalogRuntime.CanonicalNumber(point.X), DwellingReceptacleAnalogRuntime.CanonicalNumber(point.Y), DwellingReceptacleAnalogRuntime.CanonicalNumber(point.Z) });
        private static KeyValuePair<string, string> Pair(string key, string value) => new KeyValuePair<string, string>(key, value ?? string.Empty);
        private static List<string> Signatures(IEnumerable<AnchorRecord> anchors) => anchors.Select(anchor => DwellingReceptacleAnalogPlanner.NormalizedSignature(anchor.Value)).OrderBy(value => value, StringComparer.Ordinal).ToList();

        private static View? ResolvePowerPlanView(Document document, SpatialElement spatial, long? requestedViewId)
        {
            if (requestedViewId.HasValue && requestedViewId.Value > 0)
            {
                var requested = document.GetElement(ElementIdCompat.Create(requestedViewId.Value)) as ViewPlan;
                if (requested != null && !requested.IsTemplate && requested.GenLevel != null && requested.GenLevel.Id == spatial.LevelId) return requested;
                throw new InvalidOperationException("requested_view_must_be_same_level_plan");
            }
            return new FilteredElementCollector(document).OfClass(typeof(ViewPlan)).Cast<ViewPlan>().Where(view => !view.IsTemplate && view.GenLevel != null && view.GenLevel.Id == spatial.LevelId)
                .OrderByDescending(view => view.Name.IndexOf("power", StringComparison.OrdinalIgnoreCase) >= 0)
                .ThenBy(view => ElementIdCompat.GetValue(view.Id)).FirstOrDefault();
        }

        private static double ResolveFloorZ(Document document, SpatialElement spatial, double fallback) => (document.GetElement(spatial.LevelId) as Level)?.Elevation ?? fallback;
        private static double ResolveArea(SpatialElement spatial) { try { return spatial.Area; } catch { return 0; } }
        private static double ResolveBoundaryLength(SpatialElement spatial)
        {
            try { return (spatial.GetBoundarySegments(new SpatialElementBoundaryOptions()) ?? new List<IList<BoundarySegment>>()).SelectMany(loop => loop).Sum(segment => segment.GetCurve()?.Length ?? 0); }
            catch { return 0; }
        }

        private static XYZ? TryElementPoint(Element element)
        {
            if (element.Location is LocationPoint point) return point.Point;
            if (element.Location is LocationCurve curve) return curve.Curve?.Evaluate(0.5, true);
            var bbox = element.get_BoundingBox(null);
            return bbox == null ? null : (bbox.Min + bbox.Max).Multiply(0.5);
        }

        private static bool IsNearSpatialBoundary(SpatialElement spatial, XYZ point, double toleranceFt)
        {
            try
            {
                var loops = spatial.GetBoundarySegments(new SpatialElementBoundaryOptions { SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish });
                if (loops == null) return false;
                foreach (var segment in loops.SelectMany(loop => loop))
                {
                    var curve = segment.GetCurve();
                    if (curve == null) continue;
                    var projection = curve.Project(point);
                    if (projection != null && projection.XYZPoint.DistanceTo(point) <= toleranceFt) return true;
                }
            }
            catch { }
            return false;
        }

        private static bool DoesLinkedElementIntersectSpatialBounds(Element element, Transform transform, SpatialElement spatial, double toleranceFt)
        {
            try
            {
                var elementBox = element.get_BoundingBox(null);
                var spatialBox = spatial.get_BoundingBox(null);
                if (elementBox == null || spatialBox == null) return false;
                var corners = new[]
                {
                    new XYZ(elementBox.Min.X, elementBox.Min.Y, elementBox.Min.Z), new XYZ(elementBox.Min.X, elementBox.Max.Y, elementBox.Min.Z),
                    new XYZ(elementBox.Max.X, elementBox.Min.Y, elementBox.Min.Z), new XYZ(elementBox.Max.X, elementBox.Max.Y, elementBox.Min.Z),
                    new XYZ(elementBox.Min.X, elementBox.Min.Y, elementBox.Max.Z), new XYZ(elementBox.Min.X, elementBox.Max.Y, elementBox.Max.Z),
                    new XYZ(elementBox.Max.X, elementBox.Min.Y, elementBox.Max.Z), new XYZ(elementBox.Max.X, elementBox.Max.Y, elementBox.Max.Z)
                }.Select(transform.OfPoint).ToList();
                var minX = corners.Min(point => point.X); var maxX = corners.Max(point => point.X);
                var minY = corners.Min(point => point.Y); var maxY = corners.Max(point => point.Y);
                var minZ = corners.Min(point => point.Z); var maxZ = corners.Max(point => point.Z);
                return maxX >= spatialBox.Min.X - toleranceFt && minX <= spatialBox.Max.X + toleranceFt &&
                       maxY >= spatialBox.Min.Y - toleranceFt && minY <= spatialBox.Max.Y + toleranceFt &&
                       maxZ >= spatialBox.Min.Z - toleranceFt && minZ <= spatialBox.Max.Z + toleranceFt;
            }
            catch { return false; }
        }

        private static (string Family, string Type) FamilyAndType(Document document, Element element)
        {
            if (element is FamilyInstance instance) return (instance.Symbol?.FamilyName ?? element.Category?.Name ?? element.GetType().Name, instance.Symbol?.Name ?? instance.Name ?? string.Empty);
            var type = document.GetElement(element.GetTypeId());
            return (element.Category?.Name ?? element.GetType().Name, type?.Name ?? element.Name ?? string.Empty);
        }

        private static bool IsReceptacle(FamilyInstance instance) => (FamilyTypeKey(instance)).IndexOf("receptacle", StringComparison.OrdinalIgnoreCase) >= 0 || FamilyTypeKey(instance).IndexOf("outlet", StringComparison.OrdinalIgnoreCase) >= 0;
        private static string FamilyTypeKey(FamilyInstance instance) => (instance.Symbol?.FamilyName ?? string.Empty) + "|" + (instance.Symbol?.Name ?? instance.Name ?? string.Empty);
        private static bool IsSemanticDeviceType(FamilyInstance instance)
        {
            var text = FamilyTypeKey(instance).ToLowerInvariant();
            return text.Contains("gfci") || text.Contains("gfi") || text.Contains("counter") || text.Contains("high voltage");
        }

        private static bool IsWallCategory(string builtIn, string category) => builtIn.Equals("OST_Walls", StringComparison.OrdinalIgnoreCase) || category.Equals("Walls", StringComparison.OrdinalIgnoreCase) || builtIn.Equals("OST_Cornices", StringComparison.OrdinalIgnoreCase) || category.Equals("Wall Sweeps", StringComparison.OrdinalIgnoreCase);
        private static bool HasCircuit(FamilyInstance instance) => ReadParameter(instance, "Panel").Length > 0 || ReadParameter(instance, "Circuit Number").Length > 0;
        private static List<ElectricalSystem> GetPowerSystems(FamilyInstance instance)
        {
            try
            {
                return (instance.MEPModel?.GetElectricalSystems() ?? new HashSet<ElectricalSystem>())
                    .Where(system => system != null && CircuitMatchPolicy.IsPowerSystemType(system.SystemType.ToString()))
                    .OrderBy(system => ElementIdCompat.GetValue(system.Id))
                    .ToList();
            }
            catch { return new List<ElectricalSystem>(); }
        }

        private static ElectricalSystem? ResolveSourcePowerSystemState(FamilyInstance instance)
        {
            var systems = GetPowerSystems(instance);
            if (systems.Count > 1)
                throw new InvalidOperationException("source_device_has_ambiguous_power_systems:" + ElementIdCompat.GetValue(instance.Id) + ":found=" + systems.Count);
            return systems.SingleOrDefault();
        }

        private static CircuitSnapshot CaptureCircuitSnapshot(ElectricalSystem system)
        {
            Element? panel = null;
            try { panel = system.BaseEquipment; } catch { }
            return new CircuitSnapshot
            {
                SystemId = ElementIdCompat.GetValue(system.Id),
                SystemType = SafeCircuitString(() => system.SystemType.ToString()),
                PanelElementId = panel == null ? (long?)null : ElementIdCompat.GetValue(panel.Id),
                PanelName = SafeCircuitString(() => system.PanelName),
                CircuitNumber = SafeCircuitString(() => system.CircuitNumber),
                VoltageInternal = SafeCircuitDouble(() => system.Voltage),
                VoltageDisplay = ReadDisplayParameter(system, "Voltage"),
                Poles = SafeCircuitInt(() => system.PolesNumber),
                LoadClassifications = SafeCircuitString(() => system.LoadClassifications),
                TrueLoadInternal = SafeCircuitDouble(() => system.TrueLoad),
                TrueLoadDisplay = ReadDisplayParameter(system, "True Load"),
                ApparentLoadInternal = SafeCircuitDouble(() => system.ApparentLoad),
                ApparentLoadDisplay = ReadDisplayParameter(system, "Apparent Load")
            };
        }

        private static string CircuitFingerprint(CircuitSnapshot? snapshot)
        {
            if (snapshot == null) return string.Empty;
            return string.Join("|", new[]
            {
                snapshot.SystemId.ToString(CultureInfo.InvariantCulture), snapshot.SystemType,
                snapshot.PanelElementId?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                snapshot.PanelName, snapshot.CircuitNumber,
                snapshot.VoltageInternal?.ToString("R", CultureInfo.InvariantCulture) ?? string.Empty,
                snapshot.Poles?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                snapshot.LoadClassifications,
                snapshot.TrueLoadInternal?.ToString("R", CultureInfo.InvariantCulture) ?? string.Empty,
                snapshot.ApparentLoadInternal?.ToString("R", CultureInfo.InvariantCulture) ?? string.Empty
            });
        }

        private static string SafeCircuitString(Func<string> getter) { try { return (getter() ?? string.Empty).Trim(); } catch { return string.Empty; } }
        private static double? SafeCircuitDouble(Func<double> getter) { try { var value = getter(); return IsFinite(value) ? value : (double?)null; } catch { return null; } }
        private static int? SafeCircuitInt(Func<int> getter) { try { return getter(); } catch { return null; } }
        private static string ReadDisplayParameter(Element element, string name) { try { return (element.LookupParameter(name)?.AsValueString() ?? string.Empty).Trim(); } catch { return string.Empty; } }
        private static string SafeStableReference(Document document, Reference reference) { try { return reference.ConvertToStableRepresentation(document) ?? string.Empty; } catch { return string.Empty; } }
        private static string ReadParameter(Element element, string name) => (element.LookupParameter(name)?.AsString() ?? element.LookupParameter(name)?.AsValueString() ?? string.Empty).Trim();
        private static string? EmptyToNull(string value) => string.IsNullOrWhiteSpace(value) ? null : value;
        private static string AnchorKey(ElementId linkId, ElementId linkedId) => ElementIdCompat.GetValue(linkId) + ":" + ElementIdCompat.GetValue(linkedId);
        private static XYZ SafeDirection(XYZ value) => value != null && value.GetLength() > 1e-9 ? value.Normalize() : XYZ.BasisX;
        private static Point3 ToPoint3(XYZ value) => new Point3 { X = value.X, Y = value.Y, Z = value.Z };
        private static XYZ ToXyz(Point3 value) => new XYZ(value.X, value.Y, value.Z);
        private static string BuiltInCategoryName(ElementId id) { try { return ((BuiltInCategory)(int)ElementIdCompat.GetValue(id)).ToString(); } catch { return string.Empty; } }
        private static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static double NormalizeCoordinate(double value, double minimum, double span) => span > 1e-9 ? (value - minimum) / span : 0.5;
        private static double RatioDifference(double left, double right) => left > 1e-9 && right > 1e-9 ? 1.0 - (Math.Min(left, right) / Math.Max(left, right)) : 1.0;
        private static Transform GetLinkTransform(RevitLinkInstance link) { try { return link.GetTotalTransform(); } catch { } try { return link.GetTransform(); } catch { } return Transform.Identity; }
    }
}

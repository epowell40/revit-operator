using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Geometry;

namespace RevitBridge.Common.LowVoltage.Skills.DwellingReceptacles
{
    public sealed class DwellingReceptacleAnalogRoomFrame
    {
        public string RoomScopedId { get; set; } = string.Empty;
        public double MinX { get; set; }
        public double MinY { get; set; }
        public double WidthFt { get; set; }
        public double DepthFt { get; set; }
        public double FloorZ { get; set; }
    }

    public sealed class DwellingReceptacleAnalogAnchor
    {
        public string ScopedId { get; set; } = string.Empty;
        public string Category { get; set; } = string.Empty;
        public string Family { get; set; } = string.Empty;
        public string Type { get; set; } = string.Empty;
        public Point3 Point { get; set; } = new Point3();
        public string? HostScopedId { get; set; }
    }

    public sealed class DwellingReceptacleReferenceDevice
    {
        public string ElementId { get; set; } = string.Empty;
        public string FamilyTypeKey { get; set; } = string.Empty;
        public Point3 Point { get; set; } = new Point3();
        public string? SourceHostCategory { get; set; }
        public string? SourceHostScopedId { get; set; }
        public string? SourceHostSignature { get; set; }
    }

    public sealed class DwellingReceptacleAnalogPlanInput
    {
        public DwellingReceptacleAnalogRoomFrame SourceRoom { get; set; } = new DwellingReceptacleAnalogRoomFrame();
        public DwellingReceptacleAnalogRoomFrame TargetRoom { get; set; } = new DwellingReceptacleAnalogRoomFrame();
        public List<DwellingReceptacleAnalogAnchor> SourceAnchors { get; set; } = new List<DwellingReceptacleAnalogAnchor>();
        public List<DwellingReceptacleAnalogAnchor> TargetAnchors { get; set; } = new List<DwellingReceptacleAnalogAnchor>();
        public List<DwellingReceptacleReferenceDevice> ReferenceDevices { get; set; } = new List<DwellingReceptacleReferenceDevice>();
        public double SemanticAnchorMaxDistanceFt { get; set; } = 6.0;
        public double DuplicateTargetPointToleranceFt { get; set; } = 0.05;
    }

    public sealed class DwellingReceptacleAnalogPlacement
    {
        public string SourceElementId { get; set; } = string.Empty;
        public string FamilyTypeKey { get; set; } = string.Empty;
        public Point3 TargetPoint { get; set; } = new Point3();
        public double MountingHeightAffFt { get; set; }
        public string MappingBasis { get; set; } = string.Empty;
        public string MappingRuleTrace { get; set; } = string.Empty;
        public string? SourceAnchorScopedId { get; set; }
        public string? TargetHostAnchorScopedId { get; set; }
        public string? SourceAnchorSignature { get; set; }
        public string? TargetAnchorSignature { get; set; }
        public string? TargetHostScopedId { get; set; }
        public string? BoundarySide { get; set; }
        public double? NormalizedBoundaryChainage { get; set; }
    }

    public sealed class DwellingReceptacleAnalogReviewItem
    {
        public string Code { get; set; } = string.Empty;
        public string Message { get; set; } = string.Empty;
        public string? SourceElementId { get; set; }
        public string? AnchorSignature { get; set; }
    }

    public sealed class DwellingReceptacleAnalogPlan
    {
        public string Schema { get; set; } = "revit-operator.dwelling-receptacle-analog-plan.v1";
        public string Status { get; set; } = "ready";
        public string SourceRoomScopedId { get; set; } = string.Empty;
        public string TargetRoomScopedId { get; set; } = string.Empty;
        public bool InvokedTools { get; set; }
        public List<DwellingReceptacleAnalogPlacement> ProposedPlacements { get; set; } = new List<DwellingReceptacleAnalogPlacement>();
        public List<DwellingReceptacleAnalogReviewItem> ManualReviews { get; set; } = new List<DwellingReceptacleAnalogReviewItem>();
    }

    /// <summary>
    /// Pure, tool-free analog mapper. Declared semantic hosts are mandatory; only hostless devices map by boundary chainage.
    /// </summary>
    public static class DwellingReceptacleAnalogPlanner
    {
        private const double Tolerance = 0.000001;
        private const double MinimumPhysicalDuplicateToleranceFt = 0.05;
        private const double AssignmentCostMargin = 0.0001;
        private const int MaximumExactAssignmentGroupSize = 8;

        private sealed class SemanticPair
        {
            public DwellingReceptacleAnalogAnchor Target { get; set; } = new DwellingReceptacleAnalogAnchor();
            public string MatchSignature { get; set; } = string.Empty;
            public bool UsesFamilyRoleFallback { get; set; }
        }

        public static DwellingReceptacleAnalogPlan Plan(DwellingReceptacleAnalogPlanInput input)
        {
            if (input == null) throw new ArgumentNullException(nameof(input));

            var plan = new DwellingReceptacleAnalogPlan
            {
                SourceRoomScopedId = input.SourceRoom?.RoomScopedId ?? string.Empty,
                TargetRoomScopedId = input.TargetRoom?.RoomScopedId ?? string.Empty,
                InvokedTools = false
            };
            if (!TryValidate(input, plan)) return FailClosed(plan);

            var sourceAnchors = input.SourceAnchors.ToList();
            var targetAnchors = input.TargetAnchors.ToList();
            var sourceById = sourceAnchors.ToDictionary(anchor => anchor.ScopedId, StringComparer.Ordinal);
            var pairsBySourceId = BuildAllPairs(sourceAnchors, targetAnchors, input.SourceRoom, input.TargetRoom, plan);
            if (pairsBySourceId == null || plan.ManualReviews.Count > 0) return FailClosed(plan);

            var placements = new List<DwellingReceptacleAnalogPlacement>();
            foreach (var device in input.ReferenceDevices.OrderBy(x => x.ElementId, StringComparer.Ordinal))
            {
                if (DeclaresSemanticHost(device))
                {
                    var semantic = ResolveSemanticHost(device, sourceAnchors, sourceById, pairsBySourceId, input, plan);
                    if (semantic == null) continue;
                    if (!TryBuildSemanticPlacement(device, semantic.Value.Source, semantic.Value.Pair, input, out var placement))
                    {
                        AddReview(plan, "nonfinite_semantic_placement", "Semantic mapping produced a nonfinite mounting height, local offset, or target point.", device.ElementId, semantic.Value.Signature);
                        continue;
                    }
                    placements.Add(placement);
                }
                else
                {
                    if (!TryBuildBoundaryPlacement(device, input, out var placement))
                    {
                        AddReview(plan, "nonfinite_boundary_placement", "Boundary mapping produced a nonfinite derived placement.", device.ElementId, null);
                        continue;
                    }
                    placements.Add(placement);
                }
            }

            if (plan.ManualReviews.Count > 0) return FailClosed(plan);
            if (placements.Count != input.ReferenceDevices.Count)
            {
                AddReview(plan, "device_mapping_lost", "One or more reference devices did not produce an analog placement.", null, null);
                return FailClosed(plan);
            }
            if (HasDuplicateTargets(placements, input.DuplicateTargetPointToleranceFt))
            {
                AddReview(plan, "physical_target_collision", "Two or more target placements are within the physical collision tolerance.", null, null);
                return FailClosed(plan);
            }

            plan.ProposedPlacements = placements;
            return plan;
        }

        public static string NormalizedSignature(DwellingReceptacleAnalogAnchor anchor)
        {
            if (!TryNormalizedSignature(anchor, out var signature)) throw new ArgumentException("Anchor signature is malformed.", nameof(anchor));
            return signature;
        }

        private static (DwellingReceptacleAnalogAnchor Source, SemanticPair Pair, string Signature)? ResolveSemanticHost(
            DwellingReceptacleReferenceDevice device,
            IReadOnlyCollection<DwellingReceptacleAnalogAnchor> sourceAnchors,
            IReadOnlyDictionary<string, DwellingReceptacleAnalogAnchor> sourceById,
            IReadOnlyDictionary<string, SemanticPair> pairsBySourceId,
            DwellingReceptacleAnalogPlanInput input,
            DwellingReceptacleAnalogPlan plan)
        {
            DwellingReceptacleAnalogAnchor? source = null;
            string? declaredSignature = null;
            if (!string.IsNullOrWhiteSpace(device.SourceHostSignature) && !TryNormalizeDeclaredSignature(device.SourceHostSignature!, out declaredSignature))
            {
                AddReview(plan, "malformed_source_host_signature", "Declared source host signature must contain exactly three nonblank pipe-free components.", device.ElementId, null);
                return null;
            }
            if (!string.IsNullOrWhiteSpace(device.SourceHostScopedId))
            {
                if (!sourceById.TryGetValue(device.SourceHostScopedId!, out source))
                {
                    AddReview(plan, "source_host_anchor_missing", "The declared source host identity is absent from the source anchor inventory.", device.ElementId, declaredSignature);
                    return null;
                }
            }
            if (source == null && declaredSignature != null)
            {
                var candidates = sourceAnchors.Where(x => string.Equals(NormalizedSignature(x), declaredSignature, StringComparison.Ordinal))
                    .Select(x => new { Anchor = x, Distance = Distance2d(device.Point, x.Point) }).OrderBy(x => x.Distance).ToList();
                if (candidates.Count == 0)
                {
                    AddReview(plan, "source_semantic_anchor_missing", "The declared semantic host signature is absent from the source anchor inventory.", device.ElementId, declaredSignature);
                    return null;
                }
                if (candidates.Count > 1 && Math.Abs(candidates[0].Distance - candidates[1].Distance) <= Tolerance)
                {
                    AddReview(plan, "source_semantic_anchor_ambiguous", "The declared signature resolves to equally near source anchors.", device.ElementId, declaredSignature);
                    return null;
                }
                source = candidates[0].Anchor;
            }
            if (source == null)
            {
                AddReview(plan, "semantic_host_unresolved", "A declared semantic host could not be resolved.", device.ElementId, declaredSignature);
                return null;
            }

            var signature = NormalizedSignature(source);
            if (declaredSignature != null && !string.Equals(signature, declaredSignature, StringComparison.Ordinal))
            {
                AddReview(plan, "source_host_signature_mismatch", "Declared source host identity and signature disagree.", device.ElementId, declaredSignature);
                return null;
            }
            if (!string.IsNullOrWhiteSpace(device.SourceHostCategory) && (!TryNormalizeComponent(device.SourceHostCategory!, out var category) || !string.Equals(category, NormalizeComponent(source.Category), StringComparison.Ordinal)))
            {
                AddReview(plan, "source_host_category_mismatch", "Declared source host category disagrees with the resolved source anchor.", device.ElementId, signature);
                return null;
            }
            if (Distance2d(device.Point, source.Point) > input.SemanticAnchorMaxDistanceFt + Tolerance)
            {
                AddReview(plan, "semantic_host_distance_exceeded", "A declared semantic host exceeds the semantic anchor distance threshold.", device.ElementId, signature);
                return null;
            }
            if (!pairsBySourceId.TryGetValue(source.ScopedId, out var pair))
            {
                AddReview(plan, "semantic_anchor_pair_missing", "The resolved semantic source anchor has no deterministic target pair.", device.ElementId, signature);
                return null;
            }
            return (source, pair, signature);
        }

        private static Dictionary<string, SemanticPair>? BuildAllPairs(
            IReadOnlyCollection<DwellingReceptacleAnalogAnchor> sourceAnchors,
            IReadOnlyCollection<DwellingReceptacleAnalogAnchor> targetAnchors,
            DwellingReceptacleAnalogRoomFrame sourceRoom,
            DwellingReceptacleAnalogRoomFrame targetRoom,
            DwellingReceptacleAnalogPlan plan)
        {
            var sourceGroups = sourceAnchors.GroupBy(NormalizedSignature).ToDictionary(x => x.Key, x => x.OrderBy(anchor => anchor.ScopedId, StringComparer.Ordinal).ToList(), StringComparer.Ordinal);
            var targetGroups = targetAnchors.GroupBy(NormalizedSignature).ToDictionary(x => x.Key, x => x.OrderBy(anchor => anchor.ScopedId, StringComparer.Ordinal).ToList(), StringComparer.Ordinal);
            var usesFamilyRoleFallback = !TargetCoversSourceSignatureMultiset(sourceGroups, targetGroups);
            if (usesFamilyRoleFallback)
            {
                sourceGroups = sourceAnchors.GroupBy(SemanticRoleSignature).ToDictionary(x => x.Key, x => x.OrderBy(anchor => anchor.ScopedId, StringComparer.Ordinal).ToList(), StringComparer.Ordinal);
                targetGroups = targetAnchors.GroupBy(SemanticRoleSignature).ToDictionary(x => x.Key, x => x.OrderBy(anchor => anchor.ScopedId, StringComparer.Ordinal).ToList(), StringComparer.Ordinal);
            }
            if (!TargetCoversSourceSignatureMultiset(sourceGroups, targetGroups))
            {
                AddReview(plan, "anchor_signature_multiset_mismatch", "Every used normalized source anchor signature must have at least the same target count.", null, null);
                foreach (var pair in sourceGroups.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                {
                    var available = targetGroups.TryGetValue(pair.Key, out var candidates) ? candidates.Count : 0;
                    if (available < pair.Value.Count)
                        AddReview(plan, "anchor_signature_target_count_insufficient", "The target has " + available + " matching anchor(s) for " + pair.Value.Count + " used source anchor(s).", null, pair.Key);
                }
                return null;
            }

            var result = new Dictionary<string, SemanticPair>(StringComparer.Ordinal);
            foreach (var signature in sourceGroups.Keys.OrderBy(x => x, StringComparer.Ordinal))
            {
                var source = sourceGroups[signature];
                var target = targetGroups[signature];
                if (source.Count > MaximumExactAssignmentGroupSize || target.Count > MaximumExactAssignmentGroupSize)
                {
                    AddReview(plan, "assignment_group_too_large", "Repeated anchor signature exceeds the bounded exact assignment limit.", null, signature);
                    return null;
                }
                var assignment = FindMinimumCostAssignment(source, target, sourceRoom, targetRoom);
                if (assignment == null)
                {
                    AddReview(plan, "ambiguous_anchor_assignment", "Repeated anchor signature has an ambiguous or inadequately separated minimum-cost normalized-XY assignment.", null, signature);
                    return null;
                }
                for (var index = 0; index < source.Count; index++)
                {
                    result[source[index].ScopedId] = new SemanticPair
                    {
                        Target = target[assignment[index]],
                        MatchSignature = signature,
                        UsesFamilyRoleFallback = usesFamilyRoleFallback
                    };
                }
            }
            return result;
        }

        private static int[]? FindMinimumCostAssignment(
            IReadOnlyList<DwellingReceptacleAnalogAnchor> source,
            IReadOnlyList<DwellingReceptacleAnalogAnchor> target,
            DwellingReceptacleAnalogRoomFrame sourceRoom,
            DwellingReceptacleAnalogRoomFrame targetRoom)
        {
            var search = new AssignmentSearch(source, target, sourceRoom, targetRoom);
            search.Search(0, 0);
            return search.HasUnambiguousBest ? search.BestAssignment : null;
        }

        private static bool TryBuildSemanticPlacement(DwellingReceptacleReferenceDevice device, DwellingReceptacleAnalogAnchor source, SemanticPair pair, DwellingReceptacleAnalogPlanInput input, out DwellingReceptacleAnalogPlacement placement)
        {
            placement = new DwellingReceptacleAnalogPlacement();
            var target = pair.Target;
            var mountingHeight = device.Point.Z - input.SourceRoom.FloorZ;
            var offsetX = device.Point.X - source.Point.X;
            var offsetY = device.Point.Y - source.Point.Y;
            var point = new Point3 { X = target.Point.X + offsetX, Y = target.Point.Y + offsetY, Z = input.TargetRoom.FloorZ + mountingHeight };
            if (!IsFinite(mountingHeight) || !IsFinite(offsetX) || !IsFinite(offsetY) || !IsFinite(point)) return false;
            placement = new DwellingReceptacleAnalogPlacement
            {
                SourceElementId = device.ElementId,
                FamilyTypeKey = device.FamilyTypeKey,
                TargetPoint = point,
                MountingHeightAffFt = mountingHeight,
                MappingBasis = "semantic_anchor",
                MappingRuleTrace = pair.UsesFamilyRoleFallback ? "paired_anchor_family_role_translation_preserving_local_offset_and_mounting_height" : "paired_anchor_translation_preserving_local_offset_and_mounting_height",
                SourceAnchorScopedId = source.ScopedId,
                TargetHostAnchorScopedId = target.ScopedId,
                SourceAnchorSignature = pair.MatchSignature,
                TargetAnchorSignature = pair.MatchSignature,
                TargetHostScopedId = target.HostScopedId
            };
            return IsValidDerivedPlacement(placement);
        }

        private static bool TryBuildBoundaryPlacement(DwellingReceptacleReferenceDevice device, DwellingReceptacleAnalogPlanInput input, out DwellingReceptacleAnalogPlacement placement)
        {
            placement = new DwellingReceptacleAnalogPlacement();
            var mountingHeight = device.Point.Z - input.SourceRoom.FloorZ;
            if (!IsFinite(mountingHeight)) return false;
            var boundary = MapBoundary(device.Point, input.SourceRoom, input.TargetRoom, mountingHeight);
            if (!IsFinite(boundary.Point) || !IsFinite(boundary.Chainage)) return false;
            placement = new DwellingReceptacleAnalogPlacement
            {
                SourceElementId = device.ElementId,
                FamilyTypeKey = device.FamilyTypeKey,
                TargetPoint = boundary.Point,
                MountingHeightAffFt = mountingHeight,
                MappingBasis = "boundary_chainage",
                MappingRuleTrace = "nearest_source_boundary_side_with_normalized_chainage_to_corresponding_target_side:" + boundary.Side,
                BoundarySide = boundary.Side,
                NormalizedBoundaryChainage = boundary.Chainage
            };
            return IsValidDerivedPlacement(placement);
        }

        private static bool TryValidate(DwellingReceptacleAnalogPlanInput input, DwellingReceptacleAnalogPlan plan)
        {
            if (!IsValidRoom(input.SourceRoom) || !IsValidRoom(input.TargetRoom)) AddReview(plan, "malformed_room_frame", "Both room frames need stable identities, finite extrema, positive finite dimensions, and a finite floor elevation.", null, null);
            else if (string.Equals(input.SourceRoom.RoomScopedId, input.TargetRoom.RoomScopedId, StringComparison.Ordinal)) AddReview(plan, "source_target_same_room", "Source and target room identities must be distinct.", null, null);
            if (!IsFinite(input.SemanticAnchorMaxDistanceFt) || input.SemanticAnchorMaxDistanceFt < 0 || !IsFinite(input.DuplicateTargetPointToleranceFt) || input.DuplicateTargetPointToleranceFt < MinimumPhysicalDuplicateToleranceFt)
                AddReview(plan, "malformed_threshold", "Semantic threshold must be finite and physical collision tolerance must be finite and at least 0.05 ft.", null, null);
            if (input.ReferenceDevices == null || input.ReferenceDevices.Count == 0) AddReview(plan, "no_reference_devices", "At least one reference device is required.", null, null);
            foreach (var device in input.ReferenceDevices ?? Enumerable.Empty<DwellingReceptacleReferenceDevice>())
                if (string.IsNullOrWhiteSpace(device.ElementId) || string.IsNullOrWhiteSpace(device.FamilyTypeKey) || !IsFinite(device.Point)) AddReview(plan, "malformed_reference_device", "Each reference device needs a stable string identity, exact family/type key, and finite point.", device.ElementId, null);
            if ((input.ReferenceDevices ?? new List<DwellingReceptacleReferenceDevice>()).GroupBy(x => x.ElementId, StringComparer.Ordinal).Any(x => x.Count() > 1)) AddReview(plan, "duplicate_source_element_id", "Reference device identities must be unique string values.", null, null);
            ValidateAnchors(input.SourceAnchors, plan, "source");
            ValidateAnchors(input.TargetAnchors, plan, "target");
            return plan.ManualReviews.Count == 0;
        }

        private static void ValidateAnchors(IEnumerable<DwellingReceptacleAnalogAnchor>? anchors, DwellingReceptacleAnalogPlan plan, string scope)
        {
            var materialized = (anchors ?? Enumerable.Empty<DwellingReceptacleAnalogAnchor>()).ToList();
            foreach (var anchor in materialized)
            {
                if (string.IsNullOrWhiteSpace(anchor.ScopedId) || !TryNormalizedSignature(anchor, out _ ) || !IsFinite(anchor.Point))
                    AddReview(plan, "malformed_" + scope + "_anchor", "Each anchor needs a stable identity, nonblank pipe-free category/family/type components, and a finite point.", null, null);
            }
            if (materialized.GroupBy(x => x.ScopedId, StringComparer.Ordinal).Any(x => x.Count() > 1)) AddReview(plan, "duplicate_" + scope + "_anchor_id", "Anchor identities must be unique within a room.", null, null);
        }

        private static bool TargetCoversSourceSignatureMultiset(
            IReadOnlyDictionary<string, List<DwellingReceptacleAnalogAnchor>> source,
            IReadOnlyDictionary<string, List<DwellingReceptacleAnalogAnchor>> target)
            => source.All(pair => target.TryGetValue(pair.Key, out var candidates) && candidates.Count >= pair.Value.Count);

        private static (Point3 Point, string Side, double Chainage) MapBoundary(Point3 point, DwellingReceptacleAnalogRoomFrame source, DwellingReceptacleAnalogRoomFrame target, double mountingHeight)
        {
            var candidates = new[]
            {
                (Side: "south", Distance: Math.Abs(point.Y - source.MinY), Chainage: Clamp((point.X - source.MinX) / source.WidthFt)),
                (Side: "east", Distance: Math.Abs(point.X - (source.MinX + source.WidthFt)), Chainage: Clamp((point.Y - source.MinY) / source.DepthFt)),
                (Side: "north", Distance: Math.Abs(point.Y - (source.MinY + source.DepthFt)), Chainage: Clamp((point.X - source.MinX) / source.WidthFt)),
                (Side: "west", Distance: Math.Abs(point.X - source.MinX), Chainage: Clamp((point.Y - source.MinY) / source.DepthFt))
            }.OrderBy(x => x.Distance).ThenBy(x => x.Side, StringComparer.Ordinal).First();
            var pointOnTarget = new Point3 { Z = target.FloorZ + mountingHeight };
            if (candidates.Side == "south") { pointOnTarget.X = target.MinX + (target.WidthFt * candidates.Chainage); pointOnTarget.Y = target.MinY; }
            else if (candidates.Side == "east") { pointOnTarget.X = target.MinX + target.WidthFt; pointOnTarget.Y = target.MinY + (target.DepthFt * candidates.Chainage); }
            else if (candidates.Side == "north") { pointOnTarget.X = target.MinX + (target.WidthFt * candidates.Chainage); pointOnTarget.Y = target.MinY + target.DepthFt; }
            else { pointOnTarget.X = target.MinX; pointOnTarget.Y = target.MinY + (target.DepthFt * candidates.Chainage); }
            return (pointOnTarget, candidates.Side, candidates.Chainage);
        }

        private static bool HasDuplicateTargets(IReadOnlyList<DwellingReceptacleAnalogPlacement> placements, double tolerance)
        {
            for (var index = 0; index < placements.Count; index++)
            {
                for (var otherIndex = index + 1; otherIndex < placements.Count; otherIndex++)
                {
                    if (Distance2d(placements[index].TargetPoint, placements[otherIndex].TargetPoint) <= tolerance) return true;
                }
            }
            return false;
        }

        private static bool IsValidDerivedPlacement(DwellingReceptacleAnalogPlacement placement)
            => !string.IsNullOrWhiteSpace(placement.SourceElementId) && !string.IsNullOrWhiteSpace(placement.FamilyTypeKey) && IsFinite(placement.MountingHeightAffFt) && IsFinite(placement.TargetPoint)
                && (placement.NormalizedBoundaryChainage == null || (IsFinite(placement.NormalizedBoundaryChainage.Value) && placement.NormalizedBoundaryChainage.Value >= 0 && placement.NormalizedBoundaryChainage.Value <= 1));

        private static DwellingReceptacleAnalogPlan FailClosed(DwellingReceptacleAnalogPlan plan)
        {
            plan.Status = "manual_review";
            plan.ProposedPlacements = new List<DwellingReceptacleAnalogPlacement>();
            return plan;
        }

        private static void AddReview(DwellingReceptacleAnalogPlan plan, string code, string message, string? sourceElementId, string? signature)
            => plan.ManualReviews.Add(new DwellingReceptacleAnalogReviewItem { Code = code, Message = message, SourceElementId = sourceElementId, AnchorSignature = signature });

        private static bool IsValidRoom(DwellingReceptacleAnalogRoomFrame? room)
            => room != null && !string.IsNullOrWhiteSpace(room.RoomScopedId) && IsFinite(room.MinX) && IsFinite(room.MinY) && IsFinite(room.WidthFt) && IsFinite(room.DepthFt) && IsFinite(room.FloorZ)
                && IsFinite(room.MinX + room.WidthFt) && IsFinite(room.MinY + room.DepthFt) && room.WidthFt > Tolerance && room.DepthFt > Tolerance;

        private static bool TryNormalizedSignature(DwellingReceptacleAnalogAnchor? anchor, out string signature)
        {
            signature = string.Empty;
            return anchor != null && TryNormalizeComponent(anchor.Category, out var category) && TryNormalizeComponent(anchor.Family, out var family) && TryNormalizeComponent(anchor.Type, out var type)
                && AssignSignature(category, family, type, out signature);
        }

        private static bool TryNormalizeDeclaredSignature(string value, out string signature)
        {
            signature = string.Empty;
            var parts = (value ?? string.Empty).Split('|');
            return parts.Length == 3 && TryNormalizeComponent(parts[0], out var category) && TryNormalizeComponent(parts[1], out var family) && TryNormalizeComponent(parts[2], out var type)
                && AssignSignature(category, family, type, out signature);
        }

        private static bool AssignSignature(string category, string family, string type, out string signature)
        {
            signature = category + "|" + family + "|" + type;
            return true;
        }

        private static bool TryNormalizeComponent(string value, out string normalized)
        {
            normalized = string.Empty;
            if (string.IsNullOrWhiteSpace(value) || value.IndexOf('|') >= 0) return false;
            normalized = NormalizeComponent(value);
            return !string.IsNullOrWhiteSpace(normalized);
        }

        private static string NormalizeComponent(string value) => (value ?? string.Empty).Trim().ToLowerInvariant().Replace(' ', '_');
        private static string SemanticRoleSignature(DwellingReceptacleAnalogAnchor anchor)
        {
            if (!TryNormalizeComponent(anchor.Category, out var category) || !TryNormalizeComponent(anchor.Family, out var family))
                throw new ArgumentException("Anchor role signature is malformed.", nameof(anchor));
            var compact = family.Replace("_", string.Empty);
            var role = family;
            if (category == "casework" && compact.Contains("vanity") && compact.Contains("counter")) role = "vanity_counter";
            else if (category == "casework" && compact.Contains("counter")) role = "counter";
            else if (compact.Contains("kitchen") && compact.Contains("sink")) role = "kitchen_sink";
            else if (compact.Contains("vanity") && compact.Contains("sink")) role = "vanity_sink";
            else if (compact.Contains("shower")) role = "shower";
            else if (compact.Contains("washer")) role = "washer";
            return category + "|" + role + "|*";
        }
        private static bool DeclaresSemanticHost(DwellingReceptacleReferenceDevice device) => !string.IsNullOrWhiteSpace(device.SourceHostScopedId) || !string.IsNullOrWhiteSpace(device.SourceHostSignature);
        private static bool IsFinite(Point3 point) => point != null && IsFinite(point.X) && IsFinite(point.Y) && IsFinite(point.Z);
        private static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static double Distance2d(Point3 left, Point3 right) => Math.Sqrt(Math.Pow(left.X - right.X, 2) + Math.Pow(left.Y - right.Y, 2));
        private static double Clamp(double value) => Math.Max(0, Math.Min(1, value));
        private static double NormalizedX(Point3 point, DwellingReceptacleAnalogRoomFrame room) => Clamp((point.X - room.MinX) / room.WidthFt);
        private static double NormalizedY(Point3 point, DwellingReceptacleAnalogRoomFrame room) => Clamp((point.Y - room.MinY) / room.DepthFt);

        private sealed class AssignmentSearch
        {
            private readonly IReadOnlyList<DwellingReceptacleAnalogAnchor> source;
            private readonly IReadOnlyList<DwellingReceptacleAnalogAnchor> target;
            private readonly DwellingReceptacleAnalogRoomFrame sourceRoom;
            private readonly DwellingReceptacleAnalogRoomFrame targetRoom;
            private readonly int[] current;
            private readonly bool[] used;
            private int optimalCount;
            private double bestCost = double.PositiveInfinity;
            private double secondCost = double.PositiveInfinity;

            public AssignmentSearch(IReadOnlyList<DwellingReceptacleAnalogAnchor> source, IReadOnlyList<DwellingReceptacleAnalogAnchor> target, DwellingReceptacleAnalogRoomFrame sourceRoom, DwellingReceptacleAnalogRoomFrame targetRoom)
            {
                this.source = source;
                this.target = target;
                this.sourceRoom = sourceRoom;
                this.targetRoom = targetRoom;
                current = new int[source.Count];
                used = new bool[target.Count];
                BestAssignment = new int[source.Count];
            }

            public int[] BestAssignment { get; }
            public bool HasUnambiguousBest => optimalCount == 1 && secondCost - bestCost > AssignmentCostMargin;

            public void Search(int index, double cost)
            {
                if (cost > secondCost + AssignmentCostMargin) return;
                if (index == source.Count)
                {
                    if (cost < bestCost - AssignmentCostMargin)
                    {
                        secondCost = bestCost;
                        bestCost = cost;
                        optimalCount = 1;
                        Array.Copy(current, BestAssignment, current.Length);
                    }
                    else if (Math.Abs(cost - bestCost) <= AssignmentCostMargin)
                    {
                        optimalCount++;
                    }
                    else if (cost < secondCost)
                    {
                        secondCost = cost;
                    }
                    return;
                }
                for (var targetIndex = 0; targetIndex < target.Count; targetIndex++)
                {
                    if (used[targetIndex]) continue;
                    var dx = NormalizedX(source[index].Point, sourceRoom) - NormalizedX(target[targetIndex].Point, targetRoom);
                    var dy = NormalizedY(source[index].Point, sourceRoom) - NormalizedY(target[targetIndex].Point, targetRoom);
                    var nextCost = cost + (dx * dx) + (dy * dy);
                    if (!IsFinite(nextCost)) continue;
                    current[index] = targetIndex;
                    used[targetIndex] = true;
                    Search(index + 1, nextCost);
                    used[targetIndex] = false;
                }
            }
        }
    }
}

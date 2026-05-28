using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Candidates;
using RevitBridge.Common.LowVoltage.Core.Diagnostics;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Placement;
using RevitBridge.Common.LowVoltage.Core.Preview;
using RevitBridge.Common.LowVoltage.Core.Rules;

namespace RevitBridge.Logic.LowVoltage.Skills.NurseCall
{
    public class NurseCallRuleEngine : ILowVoltageRuleEngine
    {
        public LayoutResult Evaluate(LayoutContext context)
        {
            var profile = context.DisciplineProfile as NurseCallProfile ?? NurseCallProfile.CreateDefault();
            var result = new LayoutResult();
            var roomsById = context.State.Rooms.ToDictionary(room => room.Id);
            var roomBuckets = ClassifyRooms(context, profile);
            var anchors = DetectAnchors(context, profile, roomsById);
            var selectedActions = new List<PlacementAction>();

            foreach (var room in context.State.Rooms.OrderBy(room => room.Id))
            {
                var bucket = roomBuckets.TryGetValue(room.Id, out var resolvedBucket) ? resolvedBucket : "unknown";
                if (!profile.RoomTypeRequirements.TryGetValue(bucket, out var requirement))
                {
                    if (string.Equals(bucket, "unknown", StringComparison.OrdinalIgnoreCase))
                    {
                        AddReview(result, context.Diagnostics, "unknown_room_type", "warning", "Room " + (room.Number ?? room.Id.ToString()) + " could not be classified for nurse call layout.", room.Id, null);
                    }
                    continue;
                }

                var roomAnchors = anchors
                    .Where(anchor => anchor.RoomId == room.Id && requirement.RequiredAnchors.Contains(anchor.AnchorKind, StringComparer.OrdinalIgnoreCase))
                    .OrderBy(anchor => anchor.AnchorId, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                if (!roomAnchors.Any())
                {
                    if (TryBuildFallbackAnchor(context, room, requirement, profile, out var fallbackAnchor))
                    {
                        roomAnchors.Add(fallbackAnchor);
                        context.Diagnostics.AnchorsUsed.Add(new AnchorDiagnostic
                        {
                            AnchorId = fallbackAnchor.AnchorId,
                            AnchorKind = fallbackAnchor.AnchorKind,
                            SourceElementId = 0,
                            RoomId = room.Id,
                            HostPreference = fallbackAnchor.Preference.HostPreference,
                            ReviewRequired = false
                        });
                    }
                    else if (requirement.ReviewIfNoAnchor)
                    {
                        AddReview(result, context.Diagnostics, "missing_anchor", "warning", "Room " + (room.Number ?? room.Id.ToString()) + " is missing required nurse call anchors.", room.Id, "room:" + room.Id);
                    }
                }

                foreach (var anchor in roomAnchors)
                {
                    var familyType = ResolveFamilyType(context, profile, anchor.Preference.DeviceCategory);
                    if (familyType == null && !context.Diagnostics.MissingFamilyTypes.Contains("missing_family_symbol:" + anchor.Preference.DeviceCategory))
                    {
                        context.Diagnostics.MissingFamilyTypes.Add("missing_family_symbol:" + anchor.Preference.DeviceCategory);
                        AddReview(result, context.Diagnostics, "missing_family_symbol", "warning", "No nurse call family symbol matched device category " + anchor.Preference.DeviceCategory + ".", room.Id, "room:" + room.Id);
                    }

                    var candidates = BuildAnchorCandidates(context, room, anchor)
                        .Where(candidate => anchor.Preference.CandidateStrategies.Contains(candidate.Strategy, StringComparer.OrdinalIgnoreCase)
                            || (candidate.Meta.TryGetValue("baseStrategy", out var baseStrategy) && anchor.Preference.CandidateStrategies.Contains(baseStrategy, StringComparer.OrdinalIgnoreCase)))
                        .OrderBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                        .ToList();

                    if (!candidates.Any())
                    {
                        AddReview(result, context.Diagnostics, "host_ambiguity", "warning", "Anchor " + anchor.AnchorId + " has no valid host candidates.", room.Id, "room:" + room.Id);
                        continue;
                    }

                    var winner = SelectBestCandidate(context, room, anchor, candidates, selectedActions);
                    if (winner == null)
                    {
                        AddReview(result, context.Diagnostics, "host_ambiguity", "warning", "Anchor " + anchor.AnchorId + " could not be resolved to a valid nurse call placement.", room.Id, "room:" + room.Id);
                        continue;
                    }

                    selectedActions.Add(new PlacementAction
                    {
                        ActionId = "nc-" + anchor.AnchorId,
                        ActionType = "place_family_instance",
                        Discipline = "nurse_call",
                        DeviceCategory = anchor.Preference.DeviceCategory,
                        DeviceType = familyType?.TypeName ?? anchor.Preference.DeviceCategory,
                        FamilyTypeId = familyType?.Id,
                        HostPreference = anchor.Preference.HostPreference,
                        HostElementId = winner.HostElementId,
                        RoomId = room.Id,
                        GroupId = "room:" + room.Id,
                        Candidate = winner,
                        Approved = familyType != null,
                        Meta = new Dictionary<string, string>
                        {
                            ["run_module"] = "NurseCall",
                            ["device_kind"] = anchor.Preference.DeviceCategory,
                            ["anchor_id"] = anchor.AnchorId,
                            ["anchor_kind"] = anchor.AnchorKind,
                            ["tag_prefix"] = "RO_NC"
                        }
                    });
                }
            }

            result.ProposedActions = selectedActions
                .OrderBy(action => action.ActionId, StringComparer.OrdinalIgnoreCase)
                .ToList();
            result.Preview = BuildPreview(result, roomsById);
            result.Assumptions.Add("Nurse call layout used profile '" + profile.OccupancyProfile + "' with anchor-relative deterministic placement.");
            result.Assumptions.Add("Preview is generated before placement; unresolved family symbols remain unapproved and are reported in diagnostics.");
            return result;
        }

        private static Dictionary<long, string> ClassifyRooms(LayoutContext context, NurseCallProfile profile)
        {
            var classifications = new Dictionary<long, string>();
            foreach (var room in context.State.Rooms.OrderBy(room => room.Id))
            {
                var bucket = ResolveRoomBucket(profile, room.SemanticType, room.Name);
                classifications[room.Id] = bucket;
                context.Diagnostics.ClassifiedSpaces.Add(new ClassifiedSpaceDiagnostic
                {
                    RoomId = room.Id,
                    Bucket = bucket,
                    Source = string.IsNullOrWhiteSpace(room.SemanticType) ? "name" : "semantic:" + room.SemanticType,
                    OpenToCorridor = context.Graph.OpenToCorridorRooms.Contains(room.Id)
                });

                if (string.Equals(bucket, "unknown", StringComparison.OrdinalIgnoreCase))
                {
                    context.Diagnostics.UnknownRoomClassifications.Add("room:" + room.Id + ":" + (room.Name ?? string.Empty));
                }
            }

            return classifications;
        }

        private static List<NurseAnchor> DetectAnchors(LayoutContext context, NurseCallProfile profile, IReadOnlyDictionary<long, RoomState> roomsById)
        {
            var anchors = new List<NurseAnchor>();

            foreach (var fixture in context.State.Fixtures.OrderBy(fixture => fixture.Id))
            {
                var room = FindRoomContainingPoint(roomsById.Values, fixture.Location);
                context.Diagnostics.FixturesDetected.Add(new DetectedElementDiagnostic
                {
                    ElementId = fixture.Id,
                    ElementKind = "fixture",
                    SemanticType = fixture.SemanticType ?? "unknown",
                    RoomId = room?.Id
                });

                var anchorKind = ResolveAnchorKind(profile, fixture.SemanticType);
                if (string.IsNullOrWhiteSpace(anchorKind))
                {
                    context.Diagnostics.UnknownFixtureMappings.Add("fixture:" + fixture.Id + ":" + (fixture.SemanticType ?? string.Empty) + ":" + (fixture.FamilyName ?? string.Empty) + "/" + (fixture.TypeName ?? string.Empty));
                    continue;
                }

                var preference = profile.AnchorPreferences.TryGetValue(anchorKind, out var resolvedPreference) ? resolvedPreference : null;
                if (room == null || preference == null) continue;
                var anchor = new NurseAnchor
                {
                    AnchorId = "fixture:" + fixture.Id,
                    AnchorKind = anchorKind,
                    SourceElementId = fixture.Id,
                    RoomId = room.Id,
                    Location = fixture.Location,
                    Preference = preference
                };
                anchors.Add(anchor);
                context.Diagnostics.AnchorsUsed.Add(new AnchorDiagnostic
                {
                    AnchorId = anchor.AnchorId,
                    AnchorKind = anchor.AnchorKind,
                    SourceElementId = anchor.SourceElementId,
                    RoomId = anchor.RoomId,
                    HostPreference = anchor.Preference.HostPreference,
                    ReviewRequired = false
                });
            }

            foreach (var equipment in context.State.Equipment.OrderBy(equipment => equipment.Id))
            {
                var room = FindRoomContainingPoint(roomsById.Values, equipment.Location);
                context.Diagnostics.FixturesDetected.Add(new DetectedElementDiagnostic
                {
                    ElementId = equipment.Id,
                    ElementKind = "equipment",
                    SemanticType = equipment.SemanticType ?? "unknown",
                    RoomId = room?.Id
                });

                var anchorKind = ResolveAnchorKind(profile, equipment.SemanticType);
                if (string.IsNullOrWhiteSpace(anchorKind))
                {
                    context.Diagnostics.UnknownFixtureMappings.Add("equipment:" + equipment.Id + ":" + (equipment.SemanticType ?? string.Empty) + ":" + (equipment.FamilyName ?? string.Empty) + "/" + (equipment.TypeName ?? string.Empty));
                    continue;
                }

                var preference = profile.AnchorPreferences.TryGetValue(anchorKind, out var resolvedPreference) ? resolvedPreference : null;
                if (room == null || preference == null) continue;
                var anchor = new NurseAnchor
                {
                    AnchorId = "equipment:" + equipment.Id,
                    AnchorKind = anchorKind,
                    SourceElementId = equipment.Id,
                    RoomId = room.Id,
                    Location = equipment.Location,
                    Preference = preference
                };
                anchors.Add(anchor);
                context.Diagnostics.AnchorsUsed.Add(new AnchorDiagnostic
                {
                    AnchorId = anchor.AnchorId,
                    AnchorKind = anchor.AnchorKind,
                    SourceElementId = anchor.SourceElementId,
                    RoomId = anchor.RoomId,
                    HostPreference = anchor.Preference.HostPreference,
                    ReviewRequired = false
                });
            }

            return anchors;
        }

        private static bool TryBuildFallbackAnchor(LayoutContext context, RoomState room, NurseCallRoomRequirement requirement, NurseCallProfile profile, out NurseAnchor anchor)
        {
            anchor = null!;
            if (!requirement.FallbackAnchors.Any()) return false;

            foreach (var fallback in requirement.FallbackAnchors)
            {
                if (string.Equals(fallback, "room_entry", StringComparison.OrdinalIgnoreCase))
                {
                    var roomEntry = context.Candidates
                        .Where(candidate => string.Equals(candidate.Strategy, "room_entry", StringComparison.OrdinalIgnoreCase) && candidate.RoomId == room.Id)
                        .OrderBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                        .FirstOrDefault();
                    if (roomEntry != null)
                    {
                        anchor = new NurseAnchor
                        {
                            AnchorId = "fallback-room-entry:" + room.Id,
                            AnchorKind = "bed",
                            SourceElementId = 0,
                            RoomId = room.Id,
                            Location = roomEntry.Location,
                            Preference = profile.AnchorPreferences["bed"]
                        };
                        return true;
                    }
                }
                else if (string.Equals(fallback, "room_center", StringComparison.OrdinalIgnoreCase))
                {
                    anchor = new NurseAnchor
                    {
                        AnchorId = "fallback-room-center:" + room.Id,
                        AnchorKind = "staff_console",
                        SourceElementId = 0,
                        RoomId = room.Id,
                        Location = Geometry2D.GetCentroid(room.BoundaryPolygon),
                        Preference = profile.AnchorPreferences["staff_console"]
                    };
                    return true;
                }
            }

            return false;
        }

        private static List<CandidatePoint> BuildAnchorCandidates(LayoutContext context, RoomState room, NurseAnchor anchor)
        {
            var wallCandidates = context.Candidates.Where(candidate => string.Equals(candidate.Strategy, "wall_host", StringComparison.OrdinalIgnoreCase));
            var ceilingCandidates = context.Candidates.Where(candidate => string.Equals(candidate.Strategy, "ceiling_host", StringComparison.OrdinalIgnoreCase));
            var localCandidates = new List<CandidatePoint>();
            localCandidates.AddRange(CandidateGenerator.GenerateAnchorRelativeWallPoints(anchor.AnchorId, room.Id, anchor.Location, room.BoundaryPolygon, wallCandidates.ToList(), anchor.Preference.MinDistanceFt, anchor.Preference.MaxDistanceFt));
            localCandidates.AddRange(CandidateGenerator.GenerateAnchorRelativeCeilingPoints(anchor.AnchorId, room.Id, anchor.Location, room.BoundaryPolygon, ceilingCandidates.ToList(), anchor.Preference.MinDistanceFt, anchor.Preference.MaxDistanceFt));
            localCandidates.AddRange(context.Candidates
                .Where(candidate => candidate.RoomId == room.Id && (string.Equals(candidate.Strategy, "room_entry", StringComparison.OrdinalIgnoreCase) || string.Equals(candidate.Strategy, "room_center", StringComparison.OrdinalIgnoreCase)))
                .Where(candidate => Geometry2D.Distance(anchor.Location, candidate.Location) <= Math.Max(anchor.Preference.MaxDistanceFt, 8.0))
                .Select(candidate => CloneCandidate(candidate, anchor.AnchorId)));
            return localCandidates
                .GroupBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .OrderBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static CandidatePoint? SelectBestCandidate(LayoutContext context, RoomState room, NurseAnchor anchor, IReadOnlyCollection<CandidatePoint> candidates, IReadOnlyCollection<PlacementAction> selectedActions)
        {
            var validCandidates = new List<CandidatePoint>();
            foreach (var candidate in candidates)
            {
                var rejection = ValidateCandidate(context, room, anchor, candidate, selectedActions);
                if (rejection != null)
                {
                    context.Diagnostics.RejectedCandidates.Add(new CandidateRejectionDiagnostic
                    {
                        CandidateId = candidate.Id,
                        Reason = rejection,
                        RoomId = room.Id
                    });
                    continue;
                }

                candidate.Score = ScoreCandidate(anchor, candidate);
                validCandidates.Add(candidate);
            }

            return validCandidates
                .OrderByDescending(candidate => candidate.Score)
                .ThenBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        private static string? ValidateCandidate(
            LayoutContext context,
            RoomState room,
            NurseAnchor anchor,
            CandidatePoint candidate,
            IReadOnlyCollection<PlacementAction> selectedActions)
        {
            if (!Geometry2D.ContainsPoint(room.BoundaryPolygon, candidate.Location, 0.2))
            {
                return "outside_room";
            }

            if (!string.Equals(anchor.Preference.HostPreference, "any", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(anchor.Preference.HostPreference, candidate.HostType, StringComparison.OrdinalIgnoreCase)
                && !(string.Equals(anchor.Preference.HostPreference, "wall", StringComparison.OrdinalIgnoreCase) && string.Equals(candidate.Strategy, "room_entry", StringComparison.OrdinalIgnoreCase))
                && !(string.Equals(anchor.Preference.HostPreference, "wall", StringComparison.OrdinalIgnoreCase) && string.Equals(candidate.Strategy, "room_center", StringComparison.OrdinalIgnoreCase)))
            {
                return "host_mismatch";
            }

            var distance = Geometry2D.Distance(anchor.Location, candidate.Location);
            if (distance < anchor.Preference.MinDistanceFt || distance > Math.Max(anchor.Preference.MaxDistanceFt, 8.0))
            {
                return "distance_band";
            }

            if (context.State.Openings.Any(opening => Geometry2D.Distance(opening.Location, candidate.Location) < 1.0))
            {
                return "opening_clearance";
            }

            if (selectedActions.Any(existing => Geometry2D.Distance(existing.Candidate.Location, candidate.Location) < anchor.Preference.MinSeparationFt))
            {
                return "duplicate_global";
            }

            return null;
        }

        private static double ScoreCandidate(NurseAnchor anchor, CandidatePoint candidate)
        {
            var score = 0.0;
            if (string.Equals(candidate.Strategy, "anchor_wall_host", StringComparison.OrdinalIgnoreCase)) score += 40.0;
            if (string.Equals(candidate.Strategy, "anchor_ceiling_host", StringComparison.OrdinalIgnoreCase)) score += 15.0;
            if (string.Equals(candidate.Strategy, "room_entry", StringComparison.OrdinalIgnoreCase)) score += 10.0;
            if (string.Equals(candidate.HostType, anchor.Preference.HostPreference, StringComparison.OrdinalIgnoreCase)) score += 25.0;

            var distance = Geometry2D.Distance(anchor.Location, candidate.Location);
            var targetDistance = (anchor.Preference.MinDistanceFt + anchor.Preference.MaxDistanceFt) / 2.0;
            score -= Math.Abs(distance - targetDistance) * 3.0;

            var deltaX = candidate.Location.X - anchor.Location.X;
            var deltaY = candidate.Location.Y - anchor.Location.Y;
            var direction = Math.Abs(deltaX) >= Math.Abs(deltaY)
                ? (deltaX >= 0 ? "right" : "left")
                : (deltaY >= 0 ? "front" : "back");
            if (anchor.Preference.PreferredDirections.Contains(direction, StringComparer.OrdinalIgnoreCase))
            {
                score += 8.0;
            }

            candidate.RuleTrace.Add("anchor=" + anchor.AnchorId);
            candidate.RuleTrace.Add("direction=" + direction);
            return score;
        }

        private static FamilyTypeState? ResolveFamilyType(LayoutContext context, NurseCallProfile profile, string deviceCategory)
        {
            var tokens = new List<string>();
            if (profile.FamilySymbolPreferences.TryGetValue(deviceCategory, out var configured))
            {
                tokens.AddRange(configured);
            }
            tokens.AddRange(deviceCategory.Split(new[] { '_', ' ' }, StringSplitOptions.RemoveEmptyEntries));

            return context.State.FamilyTypes
                .Select(type => new { Type = type, Score = ScoreFamilyType(type, tokens) })
                .Where(item => item.Score > 0)
                .OrderByDescending(item => item.Score)
                .ThenBy(item => item.Type.FamilyName, StringComparer.OrdinalIgnoreCase)
                .ThenBy(item => item.Type.TypeName, StringComparer.OrdinalIgnoreCase)
                .Select(item => item.Type)
                .FirstOrDefault();
        }

        private static int ScoreFamilyType(FamilyTypeState type, IEnumerable<string> tokens)
        {
            var haystack = string.Join(" ", new[] { type.Category, type.FamilyName, type.TypeName }.Where(value => !string.IsNullOrWhiteSpace(value)));
            var score = 0;
            foreach (var token in tokens.Where(token => !string.IsNullOrWhiteSpace(token)))
            {
                if (haystack.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    score += 10;
                }
            }

            if (haystack.IndexOf("nurse", StringComparison.OrdinalIgnoreCase) >= 0) score += 5;
            if (haystack.IndexOf("call", StringComparison.OrdinalIgnoreCase) >= 0) score += 5;
            return score;
        }

        private static List<PreviewAnnotation> BuildPreview(LayoutResult result, IReadOnlyDictionary<long, RoomState> roomsById)
        {
            var preview = PreviewBuilder.FromActions(result.ProposedActions);
            foreach (var review in result.ManualReviews)
            {
                var location = review.RoomId.HasValue && roomsById.TryGetValue(review.RoomId.Value, out var room)
                    ? Geometry2D.GetCentroid(room.BoundaryPolygon)
                    : new Point3();
                preview.Add(new PreviewAnnotation
                {
                    AnnotationType = "manual_review",
                    Label = review.Code,
                    Location = location,
                    Color = "orange",
                    RoomId = review.RoomId,
                    GroupId = review.GroupId
                });
            }

            return preview;
        }

        private static RoomState? FindRoomContainingPoint(IEnumerable<RoomState> rooms, Point3 point)
        {
            return rooms
                .Where(room => room.BoundaryPolygon.Any() && Geometry2D.ContainsPoint(room.BoundaryPolygon, point, 0.2))
                .OrderBy(room => room.Id)
                .FirstOrDefault();
        }

        private static string ResolveRoomBucket(NurseCallProfile profile, string? semanticType, string? roomName)
        {
            var semantic = semanticType ?? string.Empty;
            if (!string.IsNullOrWhiteSpace(semantic))
            {
                if (profile.SpaceTypeMappings.ContainsKey(semantic)) return semantic;
                foreach (var mapping in profile.SpaceTypeMappings)
                {
                    if (mapping.Value.Any(value => semantic.IndexOf(value, StringComparison.OrdinalIgnoreCase) >= 0))
                    {
                        return mapping.Key;
                    }
                }
            }

            var name = roomName ?? string.Empty;
            foreach (var mapping in profile.SpaceTypeMappings)
            {
                if (mapping.Value.Any(value => name.IndexOf(value, StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    return mapping.Key;
                }
            }

            return "unknown";
        }

        private static string ResolveAnchorKind(NurseCallProfile profile, string? semanticType)
        {
            var semantic = semanticType ?? string.Empty;
            foreach (var mapping in profile.AnchorSemanticMappings)
            {
                if (mapping.Value.Any(value => string.Equals(value, semantic, StringComparison.OrdinalIgnoreCase)))
                {
                    return mapping.Key;
                }
            }

            return string.Empty;
        }

        private static CandidatePoint CloneCandidate(CandidatePoint candidate, string anchorId)
        {
            return new CandidatePoint
            {
                Id = "anchor-" + anchorId + "-" + candidate.Id,
                Strategy = candidate.Strategy,
                HostType = candidate.HostType,
                HostElementId = candidate.HostElementId,
                RoomId = candidate.RoomId,
                Location = candidate.Location,
                Meta = new Dictionary<string, string>(candidate.Meta)
                {
                    ["anchorId"] = anchorId,
                    ["baseStrategy"] = candidate.Strategy
                }
            };
        }

        private static void AddReview(LayoutResult result, DiagnosticReport diagnostics, string code, string severity, string message, long? roomId, string? groupId)
        {
            if (result.ManualReviews.Any(item => item.Code == code && item.RoomId == roomId && item.GroupId == groupId))
            {
                return;
            }

            var review = new ReviewItem
            {
                Code = code,
                Severity = severity,
                Message = message,
                RoomId = roomId,
                GroupId = groupId
            };
            result.ManualReviews.Add(review);
            diagnostics.ManualReviews.Add(review);
        }

        private sealed class NurseAnchor
        {
            public string AnchorId { get; set; } = string.Empty;
            public string AnchorKind { get; set; } = string.Empty;
            public long SourceElementId { get; set; }
            public long RoomId { get; set; }
            public Point3 Location { get; set; } = new Point3();
            public NurseCallAnchorPreference Preference { get; set; } = new NurseCallAnchorPreference();
        }
    }
}

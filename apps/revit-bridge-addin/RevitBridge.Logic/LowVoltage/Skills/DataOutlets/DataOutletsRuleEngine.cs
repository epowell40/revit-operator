using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Candidates;
using RevitBridge.Common.LowVoltage.Core.Diagnostics;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Placement;
using RevitBridge.Common.LowVoltage.Core.Preview;
using RevitBridge.Common.LowVoltage.Core.Rules;

namespace RevitBridge.Logic.LowVoltage.Skills.DataOutlets
{
    public class DataOutletsRuleEngine : ILowVoltageRuleEngine
    {
        public LayoutResult Evaluate(LayoutContext context)
        {
            var profile = context.DisciplineProfile as DataOutletsProfile ?? DataOutletsProfile.CreateDefault();
            var result = new LayoutResult();
            var roomsById = context.State.Rooms.ToDictionary(room => room.Id);
            var endpoints = DetectEndpoints(context, profile, roomsById, result);
            var selectedActions = new List<PlacementAction>();

            foreach (var endpoint in endpoints.OrderBy(item => item.RoomId).ThenBy(item => item.SourceElementId))
            {
                if (!profile.EndpointTypeRequirements.TryGetValue(endpoint.EndpointClass, out var requirement))
                {
                    AddSkippedEndpoint(context.Diagnostics, endpoint, "no_requirement_configured");
                    continue;
                }

                context.Diagnostics.RequiredEndpoints.Add(new EndpointRequirementDiagnostic
                {
                    ElementId = endpoint.SourceElementId,
                    ElementKind = endpoint.SourceKind,
                    EndpointClass = endpoint.EndpointClass,
                    RoomId = endpoint.RoomId,
                    DeviceCategory = requirement.DeviceCategory,
                    RequiresOutlet = requirement.RequiresOutlet
                });

                if (!requirement.RequiresOutlet)
                {
                    AddSkippedEndpoint(context.Diagnostics, endpoint, "profile_not_required");
                    continue;
                }

                if (selectedActions.Any(action =>
                        action.RoomId == endpoint.RoomId
                        && string.Equals(action.DeviceCategory, requirement.DeviceCategory, StringComparison.OrdinalIgnoreCase)
                        && TryGetEndpointLocation(action, out var existingEndpointLocation)
                        && Geometry2D.Distance(existingEndpointLocation, endpoint.Location) < requirement.ClusterDistanceFt))
                {
                    AddSkippedEndpoint(context.Diagnostics, endpoint, "clustered_with_existing_endpoint");
                    continue;
                }

                var familyType = ResolveFamilyType(context, profile, requirement.DeviceCategory);
                if (familyType == null)
                {
                    var missingKey = "missing_family_symbol:" + requirement.DeviceCategory;
                    if (!context.Diagnostics.MissingFamilyTypes.Contains(missingKey))
                    {
                        context.Diagnostics.MissingFamilyTypes.Add(missingKey);
                    }

                    if (profile.ReviewParameters.MissingFamilyRequiresReview)
                    {
                        AddReview(result, context.Diagnostics, "missing_family_symbol", "warning", "No data outlet family symbol matched device category " + requirement.DeviceCategory + ".", endpoint.RoomId, "endpoint:" + endpoint.SourceElementId);
                    }
                }

                if (!endpoint.RoomId.HasValue || !roomsById.TryGetValue(endpoint.RoomId.Value, out var room))
                {
                    AddSkippedEndpoint(context.Diagnostics, endpoint, "missing_room_context");
                    continue;
                }

                var candidates = BuildCandidates(context, endpoint, room, requirement)
                    .Where(candidate => requirement.CandidateStrategies.Contains(candidate.Strategy, StringComparer.OrdinalIgnoreCase)
                        || (candidate.Meta.TryGetValue("baseStrategy", out var baseStrategy) && requirement.CandidateStrategies.Contains(baseStrategy, StringComparer.OrdinalIgnoreCase)))
                    .OrderBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                if (!candidates.Any())
                {
                    AddSkippedEndpoint(context.Diagnostics, endpoint, "no_candidates_generated");
                    if (requirement.ReviewIfUnknownHost)
                    {
                        AddReview(result, context.Diagnostics, "host_ambiguity", "warning", "Endpoint " + endpoint.SourceElementId + " has no valid nearby host candidates.", endpoint.RoomId, "endpoint:" + endpoint.SourceElementId);
                    }
                    continue;
                }

                var winner = SelectBestCandidate(context, endpoint, room, requirement, candidates, selectedActions);
                if (winner == null)
                {
                    AddSkippedEndpoint(context.Diagnostics, endpoint, "no_valid_candidates");
                    if (requirement.ReviewIfUnknownHost)
                    {
                        AddReview(result, context.Diagnostics, "host_ambiguity", "warning", "Endpoint " + endpoint.SourceElementId + " could not be resolved to a valid data outlet placement.", endpoint.RoomId, "endpoint:" + endpoint.SourceElementId);
                    }
                    continue;
                }

                selectedActions.Add(new PlacementAction
                {
                    ActionId = "data-" + endpoint.SourceElementId,
                    ActionType = "place_family_instance",
                    Discipline = "data_outlets",
                    DeviceCategory = requirement.DeviceCategory,
                    DeviceType = familyType?.TypeName ?? requirement.DeviceCategory,
                    FamilyTypeId = familyType?.Id,
                    HostPreference = requirement.HostPreference,
                    HostElementId = winner.HostElementId,
                    RoomId = endpoint.RoomId,
                    GroupId = "endpoint:" + endpoint.SourceElementId,
                    Candidate = winner,
                    Approved = familyType != null,
                    Meta = new Dictionary<string, string>
                    {
                        ["run_module"] = "DataOutlets",
                        ["device_kind"] = requirement.DeviceCategory,
                        ["endpoint_id"] = endpoint.SourceElementId.ToString(),
                        ["endpoint_class"] = endpoint.EndpointClass,
                        ["source_kind"] = endpoint.SourceKind,
                        ["endpointX"] = endpoint.Location.X.ToString("0.###"),
                        ["endpointY"] = endpoint.Location.Y.ToString("0.###"),
                        ["endpointZ"] = endpoint.Location.Z.ToString("0.###"),
                        ["tag_prefix"] = "RO_DATA",
                        ["preferredElevationFt"] = requirement.PreferredElevationFt.ToString("0.###")
                    }
                });
            }

            result.ProposedActions = selectedActions
                .OrderBy(action => action.ActionId, StringComparer.OrdinalIgnoreCase)
                .ToList();
            result.Preview = BuildPreview(result, roomsById);
            result.Assumptions.Add("Data outlet layout used profile '" + profile.OccupancyProfile + "' with deterministic endpoint-driven placement.");
            result.Assumptions.Add("Endpoint normalization comes from the shared low-voltage normalization profile; unknown IT-like families are surfaced for profile expansion.");
            return result;
        }

        private static List<DataEndpoint> DetectEndpoints(
            LayoutContext context,
            DataOutletsProfile profile,
            IReadOnlyDictionary<long, RoomState> roomsById,
            LayoutResult result)
        {
            var endpoints = new List<DataEndpoint>();
            var equipmentItems = context.State.Equipment
                .OrderBy(item => item.Id)
                .Select(item => new DataEndpointSource
                {
                    SourceElementId = item.Id,
                    SourceKind = "equipment",
                    Category = item.Category,
                    FamilyName = item.FamilyName,
                    TypeName = item.TypeName,
                    SemanticType = item.SemanticType,
                    Location = item.Location
                });
            var fixtureItems = context.State.Fixtures
                .OrderBy(item => item.Id)
                .Select(item => new DataEndpointSource
                {
                    SourceElementId = item.Id,
                    SourceKind = "fixture",
                    Category = item.Category,
                    FamilyName = item.FamilyName,
                    TypeName = item.TypeName,
                    SemanticType = item.SemanticType,
                    Location = item.Location
                });

            foreach (var source in equipmentItems.Concat(fixtureItems).OrderBy(item => item.SourceElementId))
            {
                var room = FindRoomContainingPoint(roomsById.Values, source.Location);
                var endpointClass = ResolveEndpointClass(source.SemanticType);
                var searchableText = string.Join(" ", new[] { source.Category, source.FamilyName, source.TypeName, source.SemanticType }.Where(value => !string.IsNullOrWhiteSpace(value)));
                var isUnknown = string.Equals(endpointClass, "unknown_it_endpoint", StringComparison.OrdinalIgnoreCase);
                var shouldReviewUnknown = isUnknown && MatchesUnknownEndpointKeywords(profile, searchableText);
                var shouldInclude = !isUnknown || shouldReviewUnknown;

                if (!shouldInclude)
                {
                    continue;
                }

                context.Diagnostics.DetectedEndpoints.Add(new DetectedElementDiagnostic
                {
                    ElementId = source.SourceElementId,
                    ElementKind = source.SourceKind,
                    SemanticType = endpointClass,
                    RoomId = room?.Id
                });

                if (isUnknown)
                {
                    var unknownTag = source.SourceKind + ":" + source.SourceElementId + ":" + (source.FamilyName ?? string.Empty) + "/" + (source.TypeName ?? string.Empty);
                    context.Diagnostics.UnknownEndpointMappings.Add(unknownTag);
                    AddSkippedEndpoint(context.Diagnostics, new DataEndpoint
                    {
                        SourceElementId = source.SourceElementId,
                        SourceKind = source.SourceKind,
                        EndpointClass = endpointClass,
                        RoomId = room?.Id,
                        Location = source.Location
                    }, "unknown_mapping");

                    if (profile.ReviewParameters.UnknownEndpointRequiresReview)
                    {
                        AddReview(result, context.Diagnostics, "unknown_endpoint", "warning", "Endpoint family " + (source.FamilyName ?? "unknown") + " / " + (source.TypeName ?? "unknown") + " requires mapping review for data outlets.", room?.Id, "endpoint:" + source.SourceElementId);
                    }
                    continue;
                }

                if (room == null)
                {
                    AddSkippedEndpoint(context.Diagnostics, new DataEndpoint
                    {
                        SourceElementId = source.SourceElementId,
                        SourceKind = source.SourceKind,
                        EndpointClass = endpointClass,
                        RoomId = null,
                        Location = source.Location
                    }, "outside_room_scope");
                    continue;
                }

                endpoints.Add(new DataEndpoint
                {
                    SourceElementId = source.SourceElementId,
                    SourceKind = source.SourceKind,
                    EndpointClass = endpointClass,
                    RoomId = room.Id,
                    Location = source.Location
                });
            }

            return endpoints;
        }

        private static List<CandidatePoint> BuildCandidates(LayoutContext context, DataEndpoint endpoint, RoomState room, DataEndpointRequirement requirement)
        {
            var wallCandidates = context.Candidates.Where(candidate => string.Equals(candidate.Strategy, "wall_host", StringComparison.OrdinalIgnoreCase)).ToList();
            var localCandidates = new List<CandidatePoint>();
            localCandidates.AddRange(CandidateGenerator.GenerateNearestWallHostPoints(
                "endpoint:" + endpoint.SourceElementId,
                room.Id,
                endpoint.Location,
                room.BoundaryPolygon,
                wallCandidates,
                requirement.MinDistanceFt,
                requirement.MaxDistanceFt,
                maxResults: 4));

            localCandidates.AddRange(context.Candidates
                .Where(candidate => candidate.RoomId == room.Id && string.Equals(candidate.Strategy, "room_entry", StringComparison.OrdinalIgnoreCase))
                .Where(candidate => Geometry2D.Distance(endpoint.Location, candidate.Location) <= requirement.MaxDistanceFt)
                .Select(candidate => CloneCandidate(candidate, endpoint.SourceElementId)));

            localCandidates.AddRange(context.Candidates
                .Where(candidate => candidate.RoomId == room.Id && string.Equals(candidate.Strategy, "wall_host", StringComparison.OrdinalIgnoreCase))
                .Where(candidate => Geometry2D.Distance(endpoint.Location, candidate.Location) >= requirement.MinDistanceFt
                    && Geometry2D.Distance(endpoint.Location, candidate.Location) <= requirement.MaxDistanceFt)
                .Select(candidate => CloneCandidate(candidate, endpoint.SourceElementId)));

            foreach (var candidate in localCandidates)
            {
                candidate.Location = new Point3
                {
                    X = candidate.Location.X,
                    Y = candidate.Location.Y,
                    Z = requirement.PreferredElevationFt
                };
                candidate.Meta["preferredElevationFt"] = requirement.PreferredElevationFt.ToString("0.###");
                candidate.Meta["minElevationFt"] = requirement.MinElevationFt.ToString("0.###");
                candidate.Meta["maxElevationFt"] = requirement.MaxElevationFt.ToString("0.###");
            }

            return localCandidates
                .GroupBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .OrderBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static CandidatePoint? SelectBestCandidate(
            LayoutContext context,
            DataEndpoint endpoint,
            RoomState room,
            DataEndpointRequirement requirement,
            IReadOnlyCollection<CandidatePoint> candidates,
            IReadOnlyCollection<PlacementAction> selectedActions)
        {
            var validCandidates = new List<CandidatePoint>();
            foreach (var candidate in candidates)
            {
                var rejection = ValidateCandidate(context, endpoint, room, requirement, candidate, selectedActions);
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

                candidate.Score = ScoreCandidate(context, endpoint, requirement, candidate);
                validCandidates.Add(candidate);
            }

            return validCandidates
                .OrderByDescending(candidate => candidate.Score)
                .ThenBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        private static string? ValidateCandidate(
            LayoutContext context,
            DataEndpoint endpoint,
            RoomState room,
            DataEndpointRequirement requirement,
            CandidatePoint candidate,
            IReadOnlyCollection<PlacementAction> selectedActions)
        {
            if (!Geometry2D.ContainsPoint(room.BoundaryPolygon, candidate.Location, 0.2))
            {
                return "outside_room";
            }

            if (!string.Equals(requirement.HostPreference, "any", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(requirement.HostPreference, candidate.HostType, StringComparison.OrdinalIgnoreCase)
                && !(string.Equals(requirement.HostPreference, "wall", StringComparison.OrdinalIgnoreCase) && string.Equals(candidate.Strategy, "room_entry", StringComparison.OrdinalIgnoreCase)))
            {
                return "host_mismatch";
            }

            var distance = Geometry2D.Distance(endpoint.Location, candidate.Location);
            if (distance < requirement.MinDistanceFt || distance > requirement.MaxDistanceFt)
            {
                return "distance_band";
            }

            if (context.State.Openings.Any(opening => Geometry2D.Distance(opening.Location, candidate.Location) < 1.0))
            {
                return "opening_clearance";
            }

            if (selectedActions.Any(action =>
                    action.RoomId == room.Id
                    && Geometry2D.Distance(action.Candidate.Location, candidate.Location) < requirement.MinSeparationFt))
            {
                return "duplicate_global";
            }

            return null;
        }

        private static double ScoreCandidate(LayoutContext context, DataEndpoint endpoint, DataEndpointRequirement requirement, CandidatePoint candidate)
        {
            var profile = context.DisciplineProfile as DataOutletsProfile ?? DataOutletsProfile.CreateDefault();
            var score = 0.0;
            var strategyIndex = requirement.CandidateStrategies.FindIndex(strategy => string.Equals(strategy, candidate.Strategy, StringComparison.OrdinalIgnoreCase));
            if (strategyIndex >= 0)
            {
                score += profile.ScoringParameters.PreferredStrategyBonus / (strategyIndex + 1);
            }

            if (string.Equals(candidate.HostType, requirement.HostPreference, StringComparison.OrdinalIgnoreCase))
            {
                score += profile.ScoringParameters.HostMatchBonus;
            }

            if (string.Equals(candidate.Strategy, "room_entry", StringComparison.OrdinalIgnoreCase))
            {
                score += profile.ScoringParameters.RoomEntryBonus;
            }

            var distance = Geometry2D.Distance(endpoint.Location, candidate.Location);
            var targetDistance = (requirement.MinDistanceFt + requirement.MaxDistanceFt) / 2.0;
            score -= Math.Abs(distance - targetDistance) * profile.ScoringParameters.DistancePenaltyWeight;

            var direction = ResolveDirection(endpoint.Location, candidate.Location);
            if (requirement.PreferredDirections.Contains(direction, StringComparer.OrdinalIgnoreCase))
            {
                score += profile.ScoringParameters.PreferredDirectionBonus;
            }

            candidate.RuleTrace.Add("endpoint=" + endpoint.SourceElementId);
            candidate.RuleTrace.Add("direction=" + direction);
            return score;
        }

        private static FamilyTypeState? ResolveFamilyType(LayoutContext context, DataOutletsProfile profile, string deviceCategory)
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

            if (haystack.IndexOf("data", StringComparison.OrdinalIgnoreCase) >= 0) score += 5;
            if (haystack.IndexOf("communication", StringComparison.OrdinalIgnoreCase) >= 0) score += 5;
            if (haystack.IndexOf("telecom", StringComparison.OrdinalIgnoreCase) >= 0) score += 5;
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

        private static string ResolveEndpointClass(string? semanticType)
        {
            if (string.IsNullOrWhiteSpace(semanticType) || string.Equals(semanticType, "unknown", StringComparison.OrdinalIgnoreCase))
            {
                return "unknown_it_endpoint";
            }

            return semanticType.Trim();
        }

        private static bool MatchesUnknownEndpointKeywords(DataOutletsProfile profile, string searchableText)
        {
            return profile.ReviewParameters.UnknownEndpointKeywords.Any(keyword =>
                searchableText.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        private static string ResolveDirection(Point3 origin, Point3 target)
        {
            var deltaX = target.X - origin.X;
            var deltaY = target.Y - origin.Y;
            return Math.Abs(deltaX) >= Math.Abs(deltaY)
                ? (deltaX >= 0 ? "right" : "left")
                : (deltaY >= 0 ? "front" : "back");
        }

        private static CandidatePoint CloneCandidate(CandidatePoint candidate, long endpointId)
        {
            return new CandidatePoint
            {
                Id = "endpoint-" + endpointId + "-" + candidate.Id,
                Strategy = candidate.Strategy,
                HostType = candidate.HostType,
                HostElementId = candidate.HostElementId,
                RoomId = candidate.RoomId,
                Location = candidate.Location,
                Meta = new Dictionary<string, string>(candidate.Meta)
                {
                    ["endpointId"] = endpointId.ToString(),
                    ["baseStrategy"] = candidate.Strategy
                }
            };
        }

        private static bool TryGetEndpointLocation(PlacementAction action, out Point3 point)
        {
            point = new Point3();
            if (!action.Meta.TryGetValue("endpointX", out var xText)
                || !action.Meta.TryGetValue("endpointY", out var yText)
                || !action.Meta.TryGetValue("endpointZ", out var zText))
            {
                return false;
            }

            if (!double.TryParse(xText, out var x)
                || !double.TryParse(yText, out var y)
                || !double.TryParse(zText, out var z))
            {
                return false;
            }

            point = new Point3 { X = x, Y = y, Z = z };
            return true;
        }

        private static void AddSkippedEndpoint(DiagnosticReport diagnostics, DataEndpoint endpoint, string reason)
        {
            diagnostics.SkippedEndpoints.Add(new SkippedElementDiagnostic
            {
                ElementId = endpoint.SourceElementId,
                ElementKind = endpoint.SourceKind,
                SemanticType = endpoint.EndpointClass,
                RoomId = endpoint.RoomId,
                Reason = reason
            });
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

        private sealed class DataEndpointSource
        {
            public long SourceElementId { get; set; }
            public string SourceKind { get; set; } = string.Empty;
            public string? Category { get; set; }
            public string? FamilyName { get; set; }
            public string? TypeName { get; set; }
            public string? SemanticType { get; set; }
            public Point3 Location { get; set; } = new Point3();
        }

        private sealed class DataEndpoint
        {
            public long SourceElementId { get; set; }
            public string SourceKind { get; set; } = string.Empty;
            public string EndpointClass { get; set; } = string.Empty;
            public long? RoomId { get; set; }
            public Point3 Location { get; set; } = new Point3();
        }
    }
}

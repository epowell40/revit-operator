using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Diagnostics;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Placement;
using RevitBridge.Common.LowVoltage.Core.Preview;
using RevitBridge.Common.LowVoltage.Core.Rules;

namespace RevitBridge.Logic.LowVoltage.Skills.FireAlarm
{
    public class FireAlarmRuleEngine : ILowVoltageRuleEngine
    {
        public LayoutResult Evaluate(LayoutContext context)
        {
            var profile = context.DisciplineProfile as FireAlarmProfile ?? FireAlarmProfile.CreateDefault();
            var result = new LayoutResult();
            var roomsById = context.State.Rooms.ToDictionary(room => room.Id);
            var classifications = ClassifyRooms(context, profile);
            var subjects = BuildSubjects(context, profile, classifications, result, roomsById);
            var selectedActions = new List<PlacementAction>();
            var coveredRoomIds = new HashSet<long>();

            foreach (var subject in subjects.OrderBy(subject => subject.GroupId, StringComparer.OrdinalIgnoreCase))
            {
                coveredRoomIds.UnionWith(subject.RoomIds);
                if (!subject.RequireDevice)
                {
                    if (subject.ReviewRequired)
                    {
                        var reviewCode = string.Equals(subject.Bucket, "unknown", StringComparison.OrdinalIgnoreCase) ? "unknown_room_type" : "review_required";
                        AddReview(result, context.Diagnostics, reviewCode, "warning", subject.DisplayName + " requires manual review.", subject.RoomIds.FirstOrDefault(), subject.GroupId);
                    }
                    continue;
                }

                var candidates = GetCandidatesForSubject(context, subject, roomsById);
                if (!candidates.Any())
                {
                    context.Diagnostics.RejectedCandidates.Add(new CandidateRejectionDiagnostic
                    {
                        CandidateId = subject.GroupId,
                        Reason = "no_candidates_generated",
                        RoomId = subject.RoomIds.FirstOrDefault()
                    });
                    AddReview(result, context.Diagnostics, "no_valid_candidates", "warning", subject.DisplayName + " has no generated candidates.", subject.RoomIds.FirstOrDefault(), subject.GroupId);
                    continue;
                }

                foreach (var deviceCategory in subject.DeviceCategories.OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
                {
                    var familyType = ResolveFamilyType(context, profile, deviceCategory);
                    if (familyType == null && profile.NotificationDefaults.MissingFamilyRequiresReview)
                    {
                        var missingKey = "missing_family_symbol:" + deviceCategory;
                        if (!context.Diagnostics.MissingFamilyTypes.Contains(missingKey))
                        {
                            context.Diagnostics.MissingFamilyTypes.Add(missingKey);
                        }
                    }

                    var targetCount = DetermineTargetCount(subject);
                    var picks = SelectCandidates(context, profile, subject, deviceCategory, candidates, selectedActions, targetCount, roomsById);
                    if (!picks.Any())
                    {
                        AddReview(result, context.Diagnostics, "no_valid_candidates", "warning", subject.DisplayName + " has no valid " + deviceCategory + " candidates.", subject.RoomIds.FirstOrDefault(), subject.GroupId);
                        continue;
                    }

                    foreach (var selection in picks.Select((candidate, index) => new { candidate, index }))
                    {
                        selectedActions.Add(new PlacementAction
                        {
                            ActionId = "fa-" + subject.GroupId + "-" + deviceCategory + "-" + (selection.index + 1),
                            ActionType = "place_family_instance",
                            Discipline = "fire_alarm",
                            DeviceCategory = deviceCategory,
                            DeviceType = familyType?.TypeName ?? deviceCategory,
                            FamilyTypeId = familyType?.Id,
                            HostPreference = subject.HostPreference,
                            HostElementId = selection.candidate.HostElementId,
                            RoomId = selection.candidate.RoomId ?? subject.RoomIds.FirstOrDefault(),
                            GroupId = subject.GroupId,
                            Candidate = selection.candidate,
                            Approved = familyType != null,
                            Meta = new Dictionary<string, string>
                            {
                                ["run_module"] = "FireAlarm",
                                ["device_kind"] = deviceCategory,
                                ["subject_type"] = subject.SubjectType,
                                ["subject_bucket"] = subject.Bucket,
                                ["group_id"] = subject.GroupId,
                                ["tag_prefix"] = "RO_FA"
                            }
                        });
                    }

                    if (picks.Count < targetCount)
                    {
                        var violation = new RuleViolation
                        {
                            RuleId = "coverage_incomplete",
                            Severity = "warning",
                            Message = subject.DisplayName + " requested " + targetCount + " " + deviceCategory + " locations but only " + picks.Count + " were selected.",
                            RoomId = subject.RoomIds.FirstOrDefault(),
                            GroupId = subject.GroupId
                        };
                        result.Violations.Add(violation);
                    }
                }
            }

            foreach (var room in context.State.Rooms.Where(room => !coveredRoomIds.Contains(room.Id)).OrderBy(room => room.Id))
            {
                if (!classifications.TryGetValue(room.Id, out var classification)) continue;
                if (classification.Bucket == "unknown" && profile.NotificationDefaults.UnknownRequiresReview)
                {
                    AddReview(result, context.Diagnostics, "unknown_room_type", "warning", "Room " + (room.Number ?? room.Id.ToString()) + " could not be classified for fire alarm layout.", room.Id, null);
                }
            }

            result.ProposedActions = selectedActions
                .OrderBy(action => action.ActionId, StringComparer.OrdinalIgnoreCase)
                .ToList();
            result.Preview = BuildPreview(result, roomsById);
            result.Assumptions.Add("Fire alarm layout used profile '" + profile.OccupancyProfile + "' with deterministic candidate scoring.");
            result.Assumptions.Add("Preview is generated before placement; actions without a resolved family symbol remain unapproved.");
            return result;
        }

        private static Dictionary<long, FireAlarmClassification> ClassifyRooms(LayoutContext context, FireAlarmProfile profile)
        {
            var classifications = new Dictionary<long, FireAlarmClassification>();
            foreach (var room in context.State.Rooms.OrderBy(room => room.Id))
            {
                var bucket = "unknown";
                var source = "unknown";
                var semantic = (room.SemanticType ?? string.Empty).Trim();

                if (!string.IsNullOrWhiteSpace(semantic))
                {
                    if (profile.SpaceTypeMappings.ContainsKey(semantic))
                    {
                        bucket = semantic;
                        source = "semantic:" + semantic;
                    }
                    else
                    {
                        foreach (var mapping in profile.SpaceTypeMappings)
                        {
                            if (mapping.Value.Any(value => semantic.IndexOf(value, StringComparison.OrdinalIgnoreCase) >= 0))
                            {
                                bucket = mapping.Key;
                                source = "normalized:" + semantic;
                                break;
                            }
                        }
                    }
                }

                if (bucket == "unknown")
                {
                    foreach (var mapping in profile.SpaceTypeMappings)
                    {
                        if (mapping.Value.Any(value => (room.Name ?? string.Empty).IndexOf(value, StringComparison.OrdinalIgnoreCase) >= 0))
                        {
                            bucket = mapping.Key;
                            source = "name:" + (room.Name ?? string.Empty);
                            break;
                        }
                    }
                }

                classifications[room.Id] = new FireAlarmClassification
                {
                    Bucket = bucket,
                    Source = source,
                    OpenToCorridor = context.Graph.OpenToCorridorRooms.Contains(room.Id)
                };
                context.Diagnostics.ClassifiedSpaces.Add(new ClassifiedSpaceDiagnostic
                {
                    RoomId = room.Id,
                    Bucket = bucket,
                    Source = source,
                    OpenToCorridor = context.Graph.OpenToCorridorRooms.Contains(room.Id)
                });

                if (bucket == "unknown")
                {
                    context.Diagnostics.UnknownRoomClassifications.Add("room:" + room.Id + ":" + (room.Name ?? string.Empty));
                }
            }

            return classifications;
        }

        private static List<FireAlarmSubject> BuildSubjects(
            LayoutContext context,
            FireAlarmProfile profile,
            IReadOnlyDictionary<long, FireAlarmClassification> classifications,
            LayoutResult result,
            IReadOnlyDictionary<long, RoomState> roomsById)
        {
            var subjects = new List<FireAlarmSubject>();
            var groupedRoomIds = new HashSet<long>();

            foreach (var group in context.Graph.Groups.Where(group => group.GroupType == "corridor_group").OrderBy(group => group.GroupId, StringComparer.OrdinalIgnoreCase))
            {
                var roomIds = group.RoomIds
                    .Where(id => classifications.TryGetValue(id, out var classification) && classification.Bucket == "corridor")
                    .OrderBy(id => id)
                    .ToList();
                if (!roomIds.Any() || !profile.CorridorRules.Enabled) continue;

                groupedRoomIds.UnionWith(roomIds);
                context.Diagnostics.GroupsFormed.Add(new LayoutGroupDiagnostic
                {
                    GroupId = group.GroupId,
                    GroupType = group.GroupType,
                    RoomIds = roomIds.ToList()
                });
                subjects.Add(new FireAlarmSubject
                {
                    GroupId = group.GroupId,
                    SubjectType = "corridor",
                    Bucket = "corridor",
                    RoomIds = roomIds,
                    DeviceCategories = profile.CorridorRules.DeviceCategories.ToList(),
                    CandidateStrategies = profile.CorridorRules.CandidateStrategies.ToList(),
                    HostPreference = profile.CorridorRules.HostPreference,
                    RequireDevice = true,
                    ReviewRequired = false,
                    TotalAreaFt2 = roomIds.Where(roomsById.ContainsKey).Sum(id => roomsById[id].Area),
                    ApproximateLengthFt = roomIds.Where(roomsById.ContainsKey).Sum(id => GetRoomSpan(roomsById[id])),
                    MaxSpacingFt = profile.CorridorRules.MaxSpacingFt,
                    MinSeparationFt = profile.CorridorRules.MinSeparationFt,
                    MinClearanceFt = profile.CorridorRules.MinClearanceFt
                });
            }

            if (profile.OpenAreaRules.Enabled)
            {
                foreach (var group in context.Graph.Groups.Where(group => group.GroupType == "open_suite").OrderBy(group => group.GroupId, StringComparer.OrdinalIgnoreCase))
                {
                    if (group.RoomIds.Count < profile.OpenAreaRules.MinRoomsForGroup) continue;
                    var roomIds = group.RoomIds.Where(classifications.ContainsKey).OrderBy(id => id).ToList();
                    var buckets = roomIds.Select(roomId => classifications[roomId].Bucket).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                    if (!roomIds.Any()) continue;
                    if (buckets.Any(bucket => !profile.OpenAreaRules.EligibleBuckets.Contains(bucket, StringComparer.OrdinalIgnoreCase)))
                    {
                        continue;
                    }
                    if (buckets.Count > 1 && !profile.OpenAreaRules.AllowMixedBuckets)
                    {
                        AddReview(result, context.Diagnostics, "mixed_open_group", "warning", "Open group " + group.GroupId + " spans multiple fire alarm buckets.", roomIds.FirstOrDefault(), group.GroupId);
                        continue;
                    }

                    var dominantBucket = buckets.OrderBy(bucket => bucket, StringComparer.OrdinalIgnoreCase).FirstOrDefault() ?? "unknown";
                    if (!profile.RoomTypeRules.TryGetValue(dominantBucket, out var groupRule)) continue;
                    groupedRoomIds.UnionWith(roomIds);
                    context.Diagnostics.GroupsFormed.Add(new LayoutGroupDiagnostic
                    {
                        GroupId = group.GroupId,
                        GroupType = group.GroupType,
                        RoomIds = roomIds.ToList()
                    });
                    subjects.Add(new FireAlarmSubject
                    {
                        GroupId = group.GroupId,
                        SubjectType = "open_area",
                        Bucket = dominantBucket,
                        RoomIds = roomIds,
                        DeviceCategories = groupRule.DeviceCategories.ToList(),
                        CandidateStrategies = groupRule.CandidateStrategies.ToList(),
                        HostPreference = groupRule.HostPreference,
                        RequireDevice = groupRule.RequireDevice,
                        ReviewRequired = groupRule.ReviewRequired,
                        TotalAreaFt2 = roomIds.Where(roomsById.ContainsKey).Sum(id => roomsById[id].Area),
                        ApproximateLengthFt = roomIds.Where(roomsById.ContainsKey).Sum(id => GetRoomSpan(roomsById[id])),
                        MaxCoverageAreaFt2 = groupRule.MaxCoverageAreaFt2,
                        MaxSpacingFt = groupRule.MaxSpacingFt,
                        MinSeparationFt = groupRule.MinSeparationFt,
                        MinClearanceFt = groupRule.MinClearanceFt
                    });
                }
            }

            foreach (var room in context.State.Rooms.OrderBy(room => room.Id))
            {
                if (groupedRoomIds.Contains(room.Id)) continue;
                if (!classifications.TryGetValue(room.Id, out var classification)) continue;

                if (!profile.RoomTypeRules.TryGetValue(classification.Bucket, out var roomRule))
                {
                    roomRule = profile.RoomTypeRules.TryGetValue("unknown", out var unknownRule)
                        ? unknownRule
                        : new FireAlarmRoomTypeRule { ReviewRequired = true, CandidateStrategies = new List<string> { "room_center" }, HostPreference = "ceiling", MaxCoverageAreaFt2 = 400 };
                }

                subjects.Add(new FireAlarmSubject
                {
                    GroupId = "room:" + room.Id,
                    SubjectType = "room",
                    Bucket = classification.Bucket,
                    RoomIds = new List<long> { room.Id },
                    DeviceCategories = roomRule.DeviceCategories.ToList(),
                    CandidateStrategies = roomRule.CandidateStrategies.ToList(),
                    HostPreference = roomRule.HostPreference,
                    RequireDevice = roomRule.RequireDevice,
                    ReviewRequired = roomRule.ReviewRequired || (classification.Bucket == "unknown" && profile.NotificationDefaults.UnknownRequiresReview),
                    TotalAreaFt2 = room.Area,
                    ApproximateLengthFt = GetRoomSpan(room),
                    MaxCoverageAreaFt2 = roomRule.MaxCoverageAreaFt2,
                    MaxSpacingFt = roomRule.MaxSpacingFt,
                    MinSeparationFt = roomRule.MinSeparationFt,
                    MinClearanceFt = roomRule.MinClearanceFt
                });
            }

            return subjects;
        }

        private static List<CandidatePoint> GetCandidatesForSubject(LayoutContext context, FireAlarmSubject subject, IReadOnlyDictionary<long, RoomState> roomsById)
        {
            return context.Candidates
                .Where(candidate => subject.CandidateStrategies.Contains(candidate.Strategy, StringComparer.OrdinalIgnoreCase))
                .Where(candidate => CandidateMatchesSubject(candidate, subject, roomsById))
                .OrderBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static bool CandidateMatchesSubject(CandidatePoint candidate, FireAlarmSubject subject, IReadOnlyDictionary<long, RoomState> roomsById)
        {
            if (candidate.RoomId.HasValue && subject.RoomIds.Contains(candidate.RoomId.Value))
            {
                return true;
            }

            foreach (var roomId in subject.RoomIds)
            {
                if (!roomsById.TryGetValue(roomId, out var room)) continue;
                if (Geometry2D.ContainsPoint(room.BoundaryPolygon, candidate.Location, 0.2))
                {
                    return true;
                }
            }

            return false;
        }

        private static List<CandidatePoint> SelectCandidates(
            LayoutContext context,
            FireAlarmProfile profile,
            FireAlarmSubject subject,
            string deviceCategory,
            IReadOnlyCollection<CandidatePoint> candidates,
            IReadOnlyCollection<PlacementAction> selectedActions,
            int targetCount,
            IReadOnlyDictionary<long, RoomState> roomsById)
        {
            var validCandidates = new List<CandidatePoint>();
            foreach (var candidate in candidates)
            {
                var rejection = ValidateCandidate(context, subject, deviceCategory, candidate, validCandidates, selectedActions, roomsById);
                if (rejection != null)
                {
                    context.Diagnostics.RejectedCandidates.Add(new CandidateRejectionDiagnostic
                    {
                        CandidateId = candidate.Id,
                        Reason = rejection,
                        RoomId = candidate.RoomId ?? subject.RoomIds.FirstOrDefault()
                    });
                    continue;
                }

                candidate.Score = ScoreCandidate(context, profile, subject, deviceCategory, candidate, roomsById);
                candidate.RuleTrace.Add("score=" + candidate.Score.ToString("0.###"));
                validCandidates.Add(candidate);
            }

            return validCandidates
                .OrderByDescending(candidate => candidate.Score)
                .ThenBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                .Take(Math.Max(1, targetCount))
                .ToList();
        }

        private static string? ValidateCandidate(
            LayoutContext context,
            FireAlarmSubject subject,
            string deviceCategory,
            CandidatePoint candidate,
            IReadOnlyCollection<CandidatePoint> localSelections,
            IReadOnlyCollection<PlacementAction> selectedActions,
            IReadOnlyDictionary<long, RoomState> roomsById)
        {
            if (!CandidateMatchesSubject(candidate, subject, roomsById))
            {
                return "outside_subject";
            }

            if (!string.Equals(subject.HostPreference, "any", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(candidate.HostType, subject.HostPreference, StringComparison.OrdinalIgnoreCase)
                && !(string.Equals(subject.HostPreference, "wall", StringComparison.OrdinalIgnoreCase) && string.Equals(candidate.Strategy, "room_entry", StringComparison.OrdinalIgnoreCase))
                && !(string.Equals(subject.HostPreference, "ceiling", StringComparison.OrdinalIgnoreCase) && string.Equals(candidate.Strategy, "room_center", StringComparison.OrdinalIgnoreCase)))
            {
                return "host_mismatch";
            }

            if (context.State.Openings.Any(opening => Geometry2D.Distance(candidate.Location, opening.Location) < subject.MinClearanceFt))
            {
                return "opening_clearance";
            }
            if (context.State.Fixtures.Any(fixture => Geometry2D.Distance(candidate.Location, fixture.Location) < subject.MinClearanceFt))
            {
                return "fixture_clearance";
            }
            if (context.State.Equipment.Any(equipment => Geometry2D.Distance(candidate.Location, equipment.Location) < subject.MinClearanceFt))
            {
                return "equipment_clearance";
            }

            if (localSelections.Any(existing => Geometry2D.Distance(existing.Location, candidate.Location) < subject.MinSeparationFt))
            {
                return "local_spacing";
            }
            if (selectedActions.Any(action =>
                    string.Equals(action.DeviceCategory, deviceCategory, StringComparison.OrdinalIgnoreCase)
                    && Geometry2D.Distance(action.Candidate.Location, candidate.Location) < subject.MinSeparationFt))
            {
                return "duplicate_spacing";
            }

            return null;
        }

        private static double ScoreCandidate(
            LayoutContext context,
            FireAlarmProfile profile,
            FireAlarmSubject subject,
            string deviceCategory,
            CandidatePoint candidate,
            IReadOnlyDictionary<long, RoomState> roomsById)
        {
            var score = 0.0;
            var strategyIndex = subject.CandidateStrategies.FindIndex(strategy => string.Equals(strategy, candidate.Strategy, StringComparison.OrdinalIgnoreCase));
            if (strategyIndex >= 0)
            {
                score += profile.CandidateScoring.PreferredStrategyBonus / (strategyIndex + 1);
            }
            if (string.Equals(candidate.HostType, subject.HostPreference, StringComparison.OrdinalIgnoreCase))
            {
                score += profile.CandidateScoring.HostMatchBonus;
            }
            if (string.Equals(candidate.Strategy, "room_center", StringComparison.OrdinalIgnoreCase) || string.Equals(candidate.Strategy, "ceiling_host", StringComparison.OrdinalIgnoreCase))
            {
                score += profile.CandidateScoring.CenteredBonus;
            }
            if (string.Equals(candidate.Strategy, "room_entry", StringComparison.OrdinalIgnoreCase))
            {
                score += profile.CandidateScoring.EntryBonus;
            }
            if (candidate.Strategy.StartsWith("corridor_", StringComparison.OrdinalIgnoreCase))
            {
                score += profile.CandidateScoring.CorridorBonus;
            }

            var centroid = GetSubjectCentroid(subject, roomsById);
            score -= Geometry2D.Distance(candidate.Location, centroid);
            var nearestConflict = context.State.Openings.Select(opening => Geometry2D.Distance(candidate.Location, opening.Location))
                .Concat(context.State.Equipment.Select(item => Geometry2D.Distance(candidate.Location, item.Location)))
                .Concat(context.State.Fixtures.Select(item => Geometry2D.Distance(candidate.Location, item.Location)))
                .DefaultIfEmpty(5.0)
                .Min();
            score += Math.Min(nearestConflict, 10.0) * profile.CandidateScoring.ConflictPenaltyWeight;
            candidate.RuleTrace.Add("device=" + deviceCategory);
            candidate.RuleTrace.Add("subject=" + subject.GroupId);
            return score;
        }

        private static int DetermineTargetCount(FireAlarmSubject subject)
        {
            if (string.Equals(subject.SubjectType, "corridor", StringComparison.OrdinalIgnoreCase))
            {
                var spacing = Math.Max(1.0, subject.MaxSpacingFt);
                var length = Math.Max(1.0, subject.ApproximateLengthFt);
                return Math.Max(1, (int)Math.Ceiling(length / spacing));
            }

            var area = Math.Max(1.0, subject.TotalAreaFt2);
            var maxCoverage = Math.Max(1.0, subject.MaxCoverageAreaFt2);
            return Math.Max(1, (int)Math.Ceiling(area / maxCoverage));
        }

        private static FamilyTypeState? ResolveFamilyType(LayoutContext context, FireAlarmProfile profile, string deviceCategory)
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

            if (haystack.IndexOf("fire", StringComparison.OrdinalIgnoreCase) >= 0) score += 5;
            if (haystack.IndexOf("alarm", StringComparison.OrdinalIgnoreCase) >= 0) score += 5;
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
                    Color = string.Equals(review.Severity, "error", StringComparison.OrdinalIgnoreCase) ? "red" : "orange",
                    RoomId = review.RoomId,
                    GroupId = review.GroupId
                });
            }

            return preview;
        }

        private static Point3 GetSubjectCentroid(FireAlarmSubject subject, IReadOnlyDictionary<long, RoomState> roomsById)
        {
            var points = subject.RoomIds
                .Where(roomsById.ContainsKey)
                .SelectMany(roomId => roomsById[roomId].BoundaryPolygon)
                .ToList();
            return Geometry2D.GetCentroid(points);
        }

        private static double GetRoomSpan(RoomState room)
        {
            if (!Geometry2D.TryGetBounds(room.BoundaryPolygon, out var bounds))
            {
                return Math.Sqrt(room.Area);
            }

            return Math.Max(bounds.MaxX - bounds.MinX, bounds.MaxY - bounds.MinY);
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

        private sealed class FireAlarmClassification
        {
            public string Bucket { get; set; } = "unknown";
            public string Source { get; set; } = "unknown";
            public bool OpenToCorridor { get; set; }
        }

        private sealed class FireAlarmSubject
        {
            public string GroupId { get; set; } = string.Empty;
            public string SubjectType { get; set; } = string.Empty;
            public string Bucket { get; set; } = string.Empty;
            public List<long> RoomIds { get; set; } = new List<long>();
            public List<string> DeviceCategories { get; set; } = new List<string>();
            public List<string> CandidateStrategies { get; set; } = new List<string>();
            public string HostPreference { get; set; } = "any";
            public bool RequireDevice { get; set; }
            public bool ReviewRequired { get; set; }
            public double TotalAreaFt2 { get; set; } = 1;
            public double ApproximateLengthFt { get; set; } = 1;
            public double MaxCoverageAreaFt2 { get; set; } = 400;
            public double MaxSpacingFt { get; set; } = 45;
            public double MinSeparationFt { get; set; } = 6;
            public double MinClearanceFt { get; set; } = 1.5;
            public string DisplayName => SubjectType + " " + GroupId;
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Geometry;

namespace RevitBridge.Common.LowVoltage.Skills.DwellingReceptacles
{
    public sealed class DwellingReceptacleExcludedInterval
    {
        public double StartChainageFt { get; set; }
        public double EndChainageFt { get; set; }
        public string Kind { get; set; } = "opening";
        public string? SourceScopedId { get; set; }
    }

    public sealed class DwellingReceptacleWallSpace
    {
        public string WallSpaceId { get; set; } = string.Empty;
        public string? HostScopedId { get; set; }
        public Point3 Start { get; set; } = new Point3();
        public Point3 End { get; set; } = new Point3();
        public bool Eligible { get; set; } = true;
        public string? ReviewReason { get; set; }
        public List<DwellingReceptacleExcludedInterval> ExcludedIntervals { get; set; } = new List<DwellingReceptacleExcludedInterval>();
    }

    public sealed class DwellingExistingReceptacle
    {
        public long? ElementId { get; set; }
        public string WallSpaceId { get; set; } = string.Empty;
        public double ChainageFt { get; set; }
        public bool CountsTowardGeneralSpacing { get; set; } = true;
    }

    public sealed class DwellingReceptaclePlanInput
    {
        public long? RoomId { get; set; }
        public string RoomNumber { get; set; } = string.Empty;
        public string RoomName { get; set; } = string.Empty;
        public List<string> RoomClassifications { get; set; } = new List<string>();
        public List<DwellingReceptacleWallSpace> WallSpaces { get; set; } = new List<DwellingReceptacleWallSpace>();
        public List<DwellingExistingReceptacle> ExistingReceptacles { get; set; } = new List<DwellingExistingReceptacle>();
    }

    public sealed class DwellingReceptaclePlacement
    {
        public string PlacementId { get; set; } = string.Empty;
        public string WallSpaceId { get; set; } = string.Empty;
        public string? HostScopedId { get; set; }
        public double ChainageFt { get; set; }
        public double NormalizedChainage { get; set; }
        public Point3 Point { get; set; } = new Point3();
        public double MountingHeightAffFt { get; set; }
        public string DeviceFamilyIntent { get; set; } = string.Empty;
        public bool RequiresApply { get; set; }
        public List<string> RuleTrace { get; set; } = new List<string>();
    }

    public sealed class DwellingReceptacleCoverageCheck
    {
        public string WallSpaceId { get; set; } = string.Empty;
        public double StartChainageFt { get; set; }
        public double EndChainageFt { get; set; }
        public double LengthFt { get; set; }
        public double StartDistanceFt { get; set; }
        public double EndDistanceFt { get; set; }
        public double MaximumSpacingFt { get; set; }
        public bool Passes { get; set; }
    }

    public sealed class DwellingReceptacleReviewItem
    {
        public string Code { get; set; } = string.Empty;
        public string Message { get; set; } = string.Empty;
        public string? WallSpaceId { get; set; }
    }

    public sealed class DwellingReceptaclePlan
    {
        public string Schema { get; set; } = "revit-operator.dwelling-receptacle-plan.v1";
        public string Status { get; set; } = "ready";
        public string ProfileId { get; set; } = string.Empty;
        public string ProfileVersion { get; set; } = string.Empty;
        public long? RoomId { get; set; }
        public string RoomNumber { get; set; } = string.Empty;
        public List<DwellingReceptaclePlacement> ProposedPlacements { get; set; } = new List<DwellingReceptaclePlacement>();
        public List<DwellingReceptacleCoverageCheck> CoverageChecks { get; set; } = new List<DwellingReceptacleCoverageCheck>();
        public List<DwellingReceptacleReviewItem> ManualReviews { get; set; } = new List<DwellingReceptacleReviewItem>();
        public List<string> Assumptions { get; set; } = new List<string>();
        public string ComplianceDisclaimer { get; set; } = string.Empty;
        public bool InvokedTools { get; set; }
    }

    public static class DwellingReceptaclePlanner
    {
        private const double Tolerance = 0.000001;

        public static DwellingReceptaclePlan Plan(DwellingReceptaclePlanInput input, DwellingReceptacleProfile? profile = null)
        {
            if (input == null) throw new ArgumentNullException(nameof(input));
            profile ??= new DwellingReceptacleProfile();
            ValidateProfile(profile);

            var result = new DwellingReceptaclePlan
            {
                ProfileId = profile.ProfileId,
                ProfileVersion = profile.Version,
                RoomId = input.RoomId,
                RoomNumber = input.RoomNumber ?? string.Empty,
                ComplianceDisclaimer = profile.ComplianceDisclaimer,
                InvokedTools = false
            };
            result.Assumptions.Add(profile.RuleBasis);
            result.Assumptions.Add("Doorways, similar openings, fixed cabinets, stationary appliances, and other non-general wall conditions must be supplied as exclusions or withheld for manual review.");
            result.Assumptions.Add(profile.CircuitPolicy);

            var classifications = (input.RoomClassifications ?? new List<string>())
                .Select(NormalizeToken)
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var reviewClassifications = profile.ManualReviewClassifications.Select(NormalizeToken).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var supportedClassifications = profile.SupportedRoomClassifications.Select(NormalizeToken).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var special = classifications.Where(reviewClassifications.Contains).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
            if (special.Count > 0)
            {
                result.Status = "manual_review";
                result.ManualReviews.Add(new DwellingReceptacleReviewItem
                {
                    Code = "special_condition_scope",
                    Message = "V1 does not automatically lay out special-condition scope: " + string.Join(", ", special) + "."
                });
                return result;
            }

            if (classifications.Count == 0 || !classifications.Any(supportedClassifications.Contains))
            {
                result.Status = "manual_review";
                result.ManualReviews.Add(new DwellingReceptacleReviewItem
                {
                    Code = "unclassified_room",
                    Message = "Room classification is not grounded as an ordinary dwelling general wall-space area."
                });
                return result;
            }

            var placementOrdinal = 0;
            foreach (var wall in (input.WallSpaces ?? new List<DwellingReceptacleWallSpace>()).OrderBy(x => x.WallSpaceId, StringComparer.OrdinalIgnoreCase))
            {
                var wallId = string.IsNullOrWhiteSpace(wall.WallSpaceId) ? "wall-space" : wall.WallSpaceId.Trim();
                var length = Distance2d(wall.Start, wall.End);
                if (!wall.Eligible)
                {
                    result.ManualReviews.Add(new DwellingReceptacleReviewItem
                    {
                        Code = "wall_space_withheld",
                        WallSpaceId = wallId,
                        Message = string.IsNullOrWhiteSpace(wall.ReviewReason) ? "Wall space was withheld for professional review." : wall.ReviewReason!
                    });
                    continue;
                }
                if (length <= Tolerance)
                {
                    result.ManualReviews.Add(new DwellingReceptacleReviewItem { Code = "invalid_wall_space", WallSpaceId = wallId, Message = "Wall space has zero or invalid length." });
                    continue;
                }

                var intervals = BuildEligibleIntervals(length, wall.ExcludedIntervals, profile.OpeningClearanceFt);
                foreach (var interval in intervals)
                {
                    var intervalLength = interval.End - interval.Start;
                    if (intervalLength + Tolerance < profile.MinimumWallSpaceWidthFt)
                    {
                        result.ManualReviews.Add(new DwellingReceptacleReviewItem
                        {
                            Code = "short_wall_space_excluded",
                            WallSpaceId = wallId,
                            Message = $"Wall segment {intervalLength:0.###} ft is below the {profile.MinimumWallSpaceWidthFt:0.###} ft office-standard threshold."
                        });
                        continue;
                    }

                    var existing = (input.ExistingReceptacles ?? new List<DwellingExistingReceptacle>())
                        .Where(x => x.CountsTowardGeneralSpacing && string.Equals(x.WallSpaceId, wallId, StringComparison.OrdinalIgnoreCase))
                        .Select(x => x.ChainageFt)
                        .Where(x => x >= interval.Start - Tolerance && x <= interval.End + Tolerance)
                        .OrderBy(x => x)
                        .ToList();
                    var newPositions = BuildPositions(interval.Start, interval.End, existing, profile);
                    foreach (var chainage in newPositions)
                    {
                        placementOrdinal++;
                        var normalized = Math.Max(0, Math.Min(1, chainage / length));
                        result.ProposedPlacements.Add(new DwellingReceptaclePlacement
                        {
                            PlacementId = $"{profile.ProfileId.ToLowerInvariant()}-{placementOrdinal:000}",
                            WallSpaceId = wallId,
                            HostScopedId = wall.HostScopedId,
                            ChainageFt = chainage,
                            NormalizedChainage = normalized,
                            Point = Interpolate(wall.Start, wall.End, normalized, profile.DefaultMountingHeightAffFt),
                            MountingHeightAffFt = profile.DefaultMountingHeightAffFt,
                            DeviceFamilyIntent = profile.PreferredDeviceFamilyIntent,
                            RequiresApply = false,
                            RuleTrace = new List<string>
                            {
                                "qualifying_wall_space_at_least_2_ft",
                                "floor_line_end_distance_at_most_6_ft",
                                "receptacle_spacing_at_most_12_ft",
                                "opening_intervals_excluded",
                                "existing_general_receptacles_counted"
                            }
                        });
                    }

                    var allPositions = existing.Concat(newPositions).OrderBy(x => x).ToList();
                    result.CoverageChecks.Add(BuildCoverageCheck(wallId, interval.Start, interval.End, allPositions, profile));
                }
            }

            if (result.CoverageChecks.Count == 0)
            {
                result.Status = "manual_review";
                result.ManualReviews.Add(new DwellingReceptacleReviewItem { Code = "no_qualifying_wall_space", Message = "No qualifying ordinary wall space was available for deterministic layout." });
            }
            else if (result.CoverageChecks.Any(x => !x.Passes))
            {
                result.Status = "manual_review";
                result.ManualReviews.Add(new DwellingReceptacleReviewItem { Code = "coverage_not_proven", Message = "One or more proposed wall spaces did not pass deterministic spacing verification." });
            }

            return result;
        }

        private static List<double> BuildPositions(double start, double end, IReadOnlyCollection<double> existing, DwellingReceptacleProfile profile)
        {
            if (CoveragePasses(start, end, existing, profile)) return new List<double>();
            var length = end - start;
            var count = Math.Max(1, (int)Math.Ceiling(length / profile.MaximumReceptacleSpacingFt));
            var proposed = Enumerable.Range(0, count)
                .Select(index => start + ((index + 0.5) * length / count))
                .Where(target => !existing.Any(value => Math.Abs(value - target) <= profile.DuplicateToleranceFt))
                .ToList();

            var combined = existing.Concat(proposed).OrderBy(x => x).ToList();
            if (!CoveragePasses(start, end, combined, profile))
            {
                AddCoverageRepairs(start, end, combined, proposed, profile);
            }
            return proposed.Distinct().OrderBy(x => x).ToList();
        }

        private static void AddCoverageRepairs(double start, double end, List<double> combined, List<double> proposed, DwellingReceptacleProfile profile)
        {
            combined.Sort();
            if (combined.Count == 0)
            {
                proposed.Add((start + end) / 2.0);
                return;
            }
            if (combined[0] - start > profile.MaximumFloorLineDistanceToReceptacleFt + Tolerance)
                proposed.Add(start + profile.MaximumFloorLineDistanceToReceptacleFt);
            for (var i = 1; i < combined.Count; i++)
            {
                var gap = combined[i] - combined[i - 1];
                if (gap <= profile.MaximumReceptacleSpacingFt + Tolerance) continue;
                var additions = (int)Math.Ceiling(gap / profile.MaximumReceptacleSpacingFt) - 1;
                for (var j = 1; j <= additions; j++) proposed.Add(combined[i - 1] + (gap * j / (additions + 1)));
            }
            if (end - combined[combined.Count - 1] > profile.MaximumFloorLineDistanceToReceptacleFt + Tolerance)
                proposed.Add(end - profile.MaximumFloorLineDistanceToReceptacleFt);
        }

        private static DwellingReceptacleCoverageCheck BuildCoverageCheck(string wallId, double start, double end, IReadOnlyList<double> positions, DwellingReceptacleProfile profile)
        {
            var ordered = positions.OrderBy(x => x).ToList();
            var startDistance = ordered.Count == 0 ? double.PositiveInfinity : ordered[0] - start;
            var endDistance = ordered.Count == 0 ? double.PositiveInfinity : end - ordered[ordered.Count - 1];
            var maxSpacing = ordered.Count < 2 ? 0 : ordered.Zip(ordered.Skip(1), (a, b) => b - a).Max();
            return new DwellingReceptacleCoverageCheck
            {
                WallSpaceId = wallId,
                StartChainageFt = start,
                EndChainageFt = end,
                LengthFt = end - start,
                StartDistanceFt = startDistance,
                EndDistanceFt = endDistance,
                MaximumSpacingFt = maxSpacing,
                Passes = ordered.Count > 0
                    && startDistance <= profile.MaximumFloorLineDistanceToReceptacleFt + Tolerance
                    && endDistance <= profile.MaximumFloorLineDistanceToReceptacleFt + Tolerance
                    && maxSpacing <= profile.MaximumReceptacleSpacingFt + Tolerance
            };
        }

        private static bool CoveragePasses(double start, double end, IEnumerable<double> positions, DwellingReceptacleProfile profile)
            => BuildCoverageCheck("probe", start, end, positions.OrderBy(x => x).ToList(), profile).Passes;

        private static List<(double Start, double End)> BuildEligibleIntervals(double wallLength, IEnumerable<DwellingReceptacleExcludedInterval>? exclusions, double clearance)
        {
            var clipped = (exclusions ?? Enumerable.Empty<DwellingReceptacleExcludedInterval>())
                .Select(x => (Start: Math.Max(0, Math.Min(x.StartChainageFt, x.EndChainageFt) - clearance), End: Math.Min(wallLength, Math.Max(x.StartChainageFt, x.EndChainageFt) + clearance)))
                .Where(x => x.End > x.Start + Tolerance)
                .OrderBy(x => x.Start)
                .ToList();
            var merged = new List<(double Start, double End)>();
            foreach (var item in clipped)
            {
                if (merged.Count == 0 || item.Start > merged[merged.Count - 1].End + Tolerance) merged.Add(item);
                else merged[merged.Count - 1] = (merged[merged.Count - 1].Start, Math.Max(merged[merged.Count - 1].End, item.End));
            }
            var result = new List<(double Start, double End)>();
            var cursor = 0.0;
            foreach (var item in merged)
            {
                if (item.Start > cursor + Tolerance) result.Add((cursor, item.Start));
                cursor = Math.Max(cursor, item.End);
            }
            if (cursor < wallLength - Tolerance) result.Add((cursor, wallLength));
            return result;
        }

        private static Point3 Interpolate(Point3 start, Point3 end, double t, double mountingHeight)
            => new Point3 { X = start.X + ((end.X - start.X) * t), Y = start.Y + ((end.Y - start.Y) * t), Z = start.Z + mountingHeight };

        private static double Distance2d(Point3 a, Point3 b)
        {
            var dx = b.X - a.X;
            var dy = b.Y - a.Y;
            return Math.Sqrt((dx * dx) + (dy * dy));
        }

        private static string NormalizeToken(string? value)
            => (value ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_').Replace(' ', '_').Replace('/', '_');

        private static void ValidateProfile(DwellingReceptacleProfile profile)
        {
            if (string.IsNullOrWhiteSpace(profile.ProfileId)) throw new ArgumentException("ProfileId is required.");
            if (profile.MinimumWallSpaceWidthFt <= 0) throw new ArgumentOutOfRangeException(nameof(profile.MinimumWallSpaceWidthFt));
            if (profile.MaximumFloorLineDistanceToReceptacleFt <= 0) throw new ArgumentOutOfRangeException(nameof(profile.MaximumFloorLineDistanceToReceptacleFt));
            if (profile.MaximumReceptacleSpacingFt <= 0 || profile.MaximumReceptacleSpacingFt > profile.MaximumFloorLineDistanceToReceptacleFt * 2 + Tolerance)
                throw new ArgumentOutOfRangeException(nameof(profile.MaximumReceptacleSpacingFt));
            if (profile.DefaultMountingHeightAffFt < 0) throw new ArgumentOutOfRangeException(nameof(profile.DefaultMountingHeightAffFt));
        }
    }
}

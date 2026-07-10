using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    public readonly struct BranchPoint3d
    {
        public BranchPoint3d(double x, double y, double z)
        {
            X = x;
            Y = y;
            Z = z;
        }

        public double X { get; }
        public double Y { get; }
        public double Z { get; }

        public double DistanceTo(BranchPoint3d other)
        {
            var dx = X - other.X;
            var dy = Y - other.Y;
            var dz = Z - other.Z;
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }
    }

    public sealed class BranchSplitGeometryPlan
    {
        public bool ApplySupported { get; set; }
        public string Mode { get; set; } = "tee";
        public string ExpectedFitting { get; set; } = "tee";
        public string BlockCode { get; set; } = "";
        public string BlockReason { get; set; } = "";
        public BranchPoint3d? SplitPoint { get; set; }
        public BranchPoint3d? MainSegmentAStart { get; set; }
        public BranchPoint3d? MainSegmentAEnd { get; set; }
        public BranchPoint3d? MainSegmentBStart { get; set; }
        public BranchPoint3d? MainSegmentBEnd { get; set; }
        public double? DistanceToMainFt { get; set; }
        public double? DistanceFromMainStartFt { get; set; }
        public double? DistanceFromMainEndFt { get; set; }
    }

    public static class MepBranchSplitGeometryPlanner
    {
        public static BranchSplitGeometryPlan PlanLineSplit(
            string? kind,
            bool isSupportedMain,
            bool isLineMain,
            BranchPoint3d? mainStart,
            BranchPoint3d? mainEnd,
            IReadOnlyList<BranchPoint3d> branchPoints,
            BranchPoint3d? projectedPoint,
            double? distanceToMainFt,
            string? connectionMode = "tee",
            double projectionToleranceFt = 0.25,
            double minMainEndDistanceFt = 0.5,
            double minBranchSegmentLengthFt = 0.5)
        {
            var mode = NormalizeConnectionMode(connectionMode);
            var normalizedKind = NormalizeKind(kind);
            if (normalizedKind != "duct" && normalizedKind != "pipe")
                return Blocked("kind_not_supported", "Safe split/tee apply currently supports duct and pipe mains only.");
            if (!isSupportedMain)
                return Blocked("main_not_matching_mep_curve", "Safe split/tee apply requires the main element to match the requested duct or pipe kind.");
            if (!isLineMain || !mainStart.HasValue || !mainEnd.HasValue)
                return Blocked("main_curve_not_line", "Safe split/tee apply currently supports straight line duct or pipe mains only.");
            if (!projectedPoint.HasValue || !distanceToMainFt.HasValue)
                return Blocked("projection_failed", "Branch start could not be projected to the main MEP curve.");
            if (distanceToMainFt.Value > projectionToleranceFt)
                return Blocked("branch_start_too_far", $"Branch start is {distanceToMainFt.Value:G6} ft from the main; maximum supported offset is {projectionToleranceFt:G6} ft.");
            if (branchPoints == null || branchPoints.Count < 2)
                return Blocked("missing_branch_points", "At least two branch points are required.");

            var split = projectedPoint.Value;
            var distanceFromStart = split.DistanceTo(mainStart.Value);
            var distanceFromEnd = split.DistanceTo(mainEnd.Value);
            if (distanceFromStart < minMainEndDistanceFt || distanceFromEnd < minMainEndDistanceFt)
                return Blocked("split_too_close_to_main_end", $"Projected split point must be at least {minMainEndDistanceFt:G6} ft from both main MEP curve ends.");
            if (split.DistanceTo(branchPoints[1]) < minBranchSegmentLengthFt)
                return Blocked("branch_segment_too_short", $"First branch segment after snapping to the split point must be at least {minBranchSegmentLengthFt:G6} ft long.");

            return new BranchSplitGeometryPlan
            {
                ApplySupported = true,
                Mode = mode,
                ExpectedFitting = mode == "tap" ? "takeoff" : "tee",
                SplitPoint = split,
                MainSegmentAStart = mainStart,
                MainSegmentAEnd = split,
                MainSegmentBStart = split,
                MainSegmentBEnd = mainEnd,
                DistanceToMainFt = distanceToMainFt,
                DistanceFromMainStartFt = distanceFromStart,
                DistanceFromMainEndFt = distanceFromEnd
            };
        }

        private static BranchSplitGeometryPlan Blocked(string code, string reason) => new BranchSplitGeometryPlan
        {
            ApplySupported = false,
            BlockCode = code,
            BlockReason = reason
        };

        private static string NormalizeKind(string? kind)
        {
            var k = (kind ?? "").Trim().ToLowerInvariant();
            return k == "pipe" || k == "piping" ? "pipe" : "duct";
        }

        private static string NormalizeConnectionMode(string? mode)
        {
            var m = (mode ?? "").Trim().ToLowerInvariant();
            return m == "tap" || m == "takeoff" ? "tap" : "tee";
        }
    }
}

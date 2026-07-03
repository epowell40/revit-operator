using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class MepRouteReroutePlan
    {
        public bool ApplySupported { get; set; }
        public string BlockCode { get; set; } = "";
        public string BlockReason { get; set; } = "";
        public double MainLengthFt { get; set; }
        public double Split1ChainageFt { get; set; }
        public double Split2ChainageFt { get; set; }
        public BranchPoint3d MainStart { get; set; }
        public BranchPoint3d MainEnd { get; set; }
        public BranchPoint3d Split1 { get; set; }
        public BranchPoint3d Split2 { get; set; }
        public BranchPoint3d OffsetSplit1 { get; set; }
        public BranchPoint3d OffsetSplit2 { get; set; }
        public List<MepRouteRerouteSegmentPlan> Segments { get; set; } = new List<MepRouteRerouteSegmentPlan>();
        public List<MepRouteRerouteFittingPlan> ExpectedFittings { get; set; } = new List<MepRouteRerouteFittingPlan>();
    }

    public sealed class MepRouteRerouteSegmentPlan
    {
        public string Role { get; set; } = "";
        public BranchPoint3d Start { get; set; }
        public BranchPoint3d End { get; set; }
        public double LengthFt { get; set; }
    }

    public sealed class MepRouteRerouteFittingPlan
    {
        public string ExpectedFitting { get; set; } = "elbow";
        public string At { get; set; } = "";
        public BranchPoint3d Point { get; set; }
    }

    public sealed class MepRouteSizeTransitionPlan
    {
        public bool ApplySupported { get; set; }
        public string BlockCode { get; set; } = "";
        public string BlockReason { get; set; } = "";
        public double MainLengthFt { get; set; }
        public double TransitionChainageFt { get; set; }
        public BranchPoint3d MainStart { get; set; }
        public BranchPoint3d MainEnd { get; set; }
        public BranchPoint3d TransitionPoint { get; set; }
        public List<MepRouteRerouteSegmentPlan> Segments { get; set; } = new List<MepRouteRerouteSegmentPlan>();
        public MepRouteRerouteFittingPlan ExpectedFitting { get; set; } = new MepRouteRerouteFittingPlan
        {
            ExpectedFitting = "transition"
        };
    }

    public static class MepRouteReroutePlanner
    {
        public static MepRouteReroutePlan PlanOffsetReroute(
            BranchPoint3d mainStart,
            BranchPoint3d mainEnd,
            double? split1ChainageFt,
            double? split2ChainageFt,
            double? split1Normalized,
            double? split2Normalized,
            BranchPoint3d offsetVector,
            double minEndDistanceFt = 0.5,
            double minMiddleLengthFt = 1.0,
            double minOffsetFt = 0.25)
        {
            var mainLength = mainStart.DistanceTo(mainEnd);
            if (mainLength <= 1e-6)
                return Blocked("main_too_short", "Main route segment has zero length.");

            var c1 = ResolveChainage(split1ChainageFt, split1Normalized, mainLength);
            var c2 = ResolveChainage(split2ChainageFt, split2Normalized, mainLength);
            if (!c1.HasValue || !c2.HasValue)
                return Blocked("missing_split_positions", "Two split positions are required as chainage feet or normalized chainage values.");
            if (c1.Value > c2.Value)
            {
                var tmp = c1;
                c1 = c2;
                c2 = tmp;
            }

            if (c1.Value < minEndDistanceFt || mainLength - c2.Value < minEndDistanceFt)
                return Blocked("split_too_close_to_endpoint", $"Split points must leave at least {minEndDistanceFt:G6} ft at both original route ends.");
            if (c2.Value - c1.Value < minMiddleLengthFt)
                return Blocked("split_span_too_short", $"Distance between split points must be at least {minMiddleLengthFt:G6} ft.");

            var offsetLength = offsetVector.DistanceTo(new BranchPoint3d(0, 0, 0));
            if (offsetLength < minOffsetFt)
                return Blocked("offset_too_small", $"Offset vector must be at least {minOffsetFt:G6} ft long.");

            var split1 = PointAtChainage(mainStart, mainEnd, c1.Value / mainLength);
            var split2 = PointAtChainage(mainStart, mainEnd, c2.Value / mainLength);
            var offset1 = Add(split1, offsetVector);
            var offset2 = Add(split2, offsetVector);

            var segments = new List<MepRouteRerouteSegmentPlan>
            {
                Segment("main_a", mainStart, split1),
                Segment("offset_leg_a", split1, offset1),
                Segment("offset_middle", offset1, offset2),
                Segment("offset_leg_b", offset2, split2),
                Segment("main_b", split2, mainEnd)
            };

            if (segments.Any(x => x.LengthFt <= 1e-6))
                return Blocked("zero_length_segment", "Reroute plan produced a zero-length segment.");

            return new MepRouteReroutePlan
            {
                ApplySupported = true,
                MainLengthFt = mainLength,
                Split1ChainageFt = c1.Value,
                Split2ChainageFt = c2.Value,
                MainStart = mainStart,
                MainEnd = mainEnd,
                Split1 = split1,
                Split2 = split2,
                OffsetSplit1 = offset1,
                OffsetSplit2 = offset2,
                Segments = segments,
                ExpectedFittings = new List<MepRouteRerouteFittingPlan>
                {
                    Fitting("split1_to_offset_leg", split1),
                    Fitting("offset_leg_to_middle_a", offset1),
                    Fitting("middle_to_offset_leg_b", offset2),
                    Fitting("offset_leg_to_split2", split2)
                }
            };
        }

        public static MepRouteSizeTransitionPlan PlanSizeTransition(
            BranchPoint3d mainStart,
            BranchPoint3d mainEnd,
            double? transitionChainageFt,
            double? transitionNormalized,
            double minEndDistanceFt = 0.5)
        {
            var mainLength = mainStart.DistanceTo(mainEnd);
            if (mainLength <= 1e-6)
                return BlockedTransition("main_too_short", "Main route segment has zero length.");

            var chainage = ResolveChainage(transitionChainageFt, transitionNormalized, mainLength);
            if (!chainage.HasValue)
                return BlockedTransition("missing_transition_position", "A transition position is required as chainage feet or normalized chainage.");

            if (chainage.Value < minEndDistanceFt || mainLength - chainage.Value < minEndDistanceFt)
                return BlockedTransition("transition_too_close_to_endpoint", $"Transition point must leave at least {minEndDistanceFt:G6} ft at both original route ends.");

            var point = PointAtChainage(mainStart, mainEnd, chainage.Value / mainLength);
            var segments = new List<MepRouteRerouteSegmentPlan>
            {
                Segment("upstream", mainStart, point),
                Segment("downstream", point, mainEnd)
            };

            if (segments.Any(x => x.LengthFt <= 1e-6))
                return BlockedTransition("zero_length_segment", "Size transition plan produced a zero-length segment.");

            return new MepRouteSizeTransitionPlan
            {
                ApplySupported = true,
                MainLengthFt = mainLength,
                TransitionChainageFt = chainage.Value,
                MainStart = mainStart,
                MainEnd = mainEnd,
                TransitionPoint = point,
                Segments = segments,
                ExpectedFitting = new MepRouteRerouteFittingPlan
                {
                    ExpectedFitting = "transition",
                    At = "size_change",
                    Point = point
                }
            };
        }

        private static MepRouteReroutePlan Blocked(string code, string reason) => new MepRouteReroutePlan
        {
            ApplySupported = false,
            BlockCode = code,
            BlockReason = reason
        };

        private static MepRouteSizeTransitionPlan BlockedTransition(string code, string reason) => new MepRouteSizeTransitionPlan
        {
            ApplySupported = false,
            BlockCode = code,
            BlockReason = reason
        };

        private static double? ResolveChainage(double? chainage, double? normalized, double length)
        {
            if (chainage.HasValue && IsFinite(chainage.Value)) return chainage.Value;
            if (normalized.HasValue && IsFinite(normalized.Value)) return normalized.Value * length;
            return null;
        }

        private static bool IsFinite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        private static BranchPoint3d PointAtChainage(BranchPoint3d a, BranchPoint3d b, double t)
        {
            return new BranchPoint3d(
                a.X + (b.X - a.X) * t,
                a.Y + (b.Y - a.Y) * t,
                a.Z + (b.Z - a.Z) * t);
        }

        private static BranchPoint3d Add(BranchPoint3d point, BranchPoint3d vector)
        {
            return new BranchPoint3d(point.X + vector.X, point.Y + vector.Y, point.Z + vector.Z);
        }

        private static MepRouteRerouteSegmentPlan Segment(string role, BranchPoint3d start, BranchPoint3d end)
        {
            return new MepRouteRerouteSegmentPlan
            {
                Role = role,
                Start = start,
                End = end,
                LengthFt = start.DistanceTo(end)
            };
        }

        private static MepRouteRerouteFittingPlan Fitting(string at, BranchPoint3d point)
        {
            return new MepRouteRerouteFittingPlan
            {
                ExpectedFitting = "elbow",
                At = at,
                Point = point
            };
        }
    }
}

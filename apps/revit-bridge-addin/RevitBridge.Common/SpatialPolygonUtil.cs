using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public enum SpatialPointRelation
    {
        Outside,
        Inside,
        Boundary
    }

    public readonly struct SpatialPoint2
    {
        public SpatialPoint2(double x, double y)
        {
            X = x;
            Y = y;
        }

        public double X { get; }
        public double Y { get; }
    }

    public static class SpatialPolygonUtil
    {
        public static bool Contains(
            double x,
            double y,
            IReadOnlyList<IReadOnlyList<SpatialPoint2>> loops)
        {
            return Classify(x, y, loops) == SpatialPointRelation.Inside;
        }

        public static SpatialPointRelation Classify(
            double x,
            double y,
            IReadOnlyList<IReadOnlyList<SpatialPoint2>> loops,
            double boundaryTolerance = 1e-6)
        {
            if (loops == null || loops.Count == 0) return SpatialPointRelation.Outside;

            var tolerance = Math.Max(0, boundaryTolerance);
            if (DistanceToBoundary(x, y, loops) <= tolerance)
                return SpatialPointRelation.Boundary;

            // Revit may return one outer loop plus hole loops. Applying the
            // even-odd rule across every loop handles both without depending
            // on loop winding conventions.
            var inside = false;
            for (var loopIndex = 0; loopIndex < loops.Count; loopIndex++)
            {
                if (ContainsLoop(x, y, loops[loopIndex])) inside = !inside;
            }
            return inside ? SpatialPointRelation.Inside : SpatialPointRelation.Outside;
        }

        public static double DistanceToBoundary(
            double x,
            double y,
            IReadOnlyList<IReadOnlyList<SpatialPoint2>> loops)
        {
            if (loops == null || loops.Count == 0) return double.PositiveInfinity;

            var best = double.PositiveInfinity;
            for (var loopIndex = 0; loopIndex < loops.Count; loopIndex++)
            {
                var loop = loops[loopIndex];
                if (loop == null || loop.Count == 0) continue;
                for (var i = 0; i < loop.Count; i++)
                {
                    var a = loop[i];
                    var b = loop[(i + 1) % loop.Count];
                    best = Math.Min(best, DistanceToSegment(x, y, a.X, a.Y, b.X, b.Y));
                }
            }
            return best;
        }

        private static bool ContainsLoop(
            double x,
            double y,
            IReadOnlyList<SpatialPoint2> loop)
        {
            if (loop == null || loop.Count < 3) return false;

            var inside = false;
            var j = loop.Count - 1;
            for (var i = 0; i < loop.Count; i++)
            {
                var a = loop[i];
                var b = loop[j];
                var crosses = (a.Y > y) != (b.Y > y);
                if (crosses)
                {
                    var edgeX = ((b.X - a.X) * (y - a.Y) / (b.Y - a.Y)) + a.X;
                    if (x < edgeX) inside = !inside;
                }
                j = i;
            }
            return inside;
        }

        private static double DistanceToSegment(
            double px,
            double py,
            double ax,
            double ay,
            double bx,
            double by)
        {
            var dx = bx - ax;
            var dy = by - ay;
            var lengthSquared = (dx * dx) + (dy * dy);
            if (lengthSquared <= 1e-18)
            {
                var pointDx = px - ax;
                var pointDy = py - ay;
                return Math.Sqrt((pointDx * pointDx) + (pointDy * pointDy));
            }

            var t = (((px - ax) * dx) + ((py - ay) * dy)) / lengthSquared;
            t = Math.Max(0, Math.Min(1, t));
            var qx = ax + (t * dx);
            var qy = ay + (t * dy);
            var resultDx = px - qx;
            var resultDy = py - qy;
            return Math.Sqrt((resultDx * resultDx) + (resultDy * resultDy));
        }
    }

    public static class SpatialCandidateIdentityUtil
    {
        public static string Build(
            string spatialKind,
            string sourceScope,
            long? linkInstanceId,
            long spatialId,
            string sourceScopedId)
        {
            if (!string.IsNullOrWhiteSpace(sourceScopedId))
                return $"{spatialKind}|{sourceScopedId.Trim()}";
            return $"{spatialKind}|{sourceScope}|{linkInstanceId}|{spatialId}";
        }
    }

    public static class SpatialPhaseMapUtil
    {
        public static long? ResolveLinkedPhaseId(
            long hostPhaseId,
            IEnumerable<KeyValuePair<long, long>> phaseMap)
        {
            if (phaseMap == null) return null;
            foreach (var pair in phaseMap)
            {
                if (pair.Key == hostPhaseId) return pair.Value;
            }
            return null;
        }
    }

    public static class SpatialEffectivePhaseFallbackUtil
    {
        public static long? ResolveSharedCreatedPhaseId(IEnumerable<long?> createdPhaseIds)
        {
            if (createdPhaseIds == null) return null;
            var values = createdPhaseIds.ToList();
            if (values.Count == 0 || values.Any(value => !value.HasValue || value.Value <= 0)) return null;
            var distinct = values.Select(value => value!.Value).Distinct().Take(2).ToList();
            return distinct.Count == 1 ? distinct[0] : null;
        }
    }

    public static class SpatialVerticalRangeUtil
    {
        public static bool Contains(
            double z,
            double? baseElevation,
            double? topElevation,
            double tolerance = 1e-5)
        {
            if (!baseElevation.HasValue || !topElevation.HasValue) return false;
            var min = Math.Min(baseElevation.Value, topElevation.Value);
            var max = Math.Max(baseElevation.Value, topElevation.Value);
            var tol = Math.Max(0, tolerance);
            return z >= min - tol && z <= max + tol;
        }
    }

    public static class SpatialResolutionDecisionUtil
    {
        public static string WithoutGeometryStatus(int associationCandidateCount)
        {
            if (associationCandidateCount == 1) return "resolved";
            if (associationCandidateCount > 1) return "ambiguous";
            return "unresolved";
        }
    }

    public static class SpatialElementLifecycleUtil
    {
        public static bool IsPresentInEffectivePhase(string phaseStatus)
        {
            return string.Equals(phaseStatus, "Existing", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(phaseStatus, "New", StringComparison.OrdinalIgnoreCase);
        }
    }

    public static class SpatialLocationEvidenceUtil
    {
        public static bool CanEvaluateProximity(bool candidatePointAvailable, bool referencePointAvailable)
        {
            return candidatePointAvailable && referencePointAvailable;
        }

        public static bool CanSuggestPlacement(bool hostSupported, bool factualPointAvailable)
        {
            return hostSupported && factualPointAvailable;
        }
    }

    public static class SpatialCandidateFilterUtil
    {
        public static bool SourceIsEnabled(
            string spatialKind,
            string sourceScope,
            bool includeHostRooms,
            bool includeHostSpaces,
            bool includeLinkedRooms)
        {
            if (string.Equals(sourceScope, "host", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(spatialKind, "Room", StringComparison.OrdinalIgnoreCase))
                return includeHostRooms;
            if (string.Equals(sourceScope, "host", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(spatialKind, "Space", StringComparison.OrdinalIgnoreCase))
                return includeHostSpaces;
            if (string.Equals(sourceScope, "linked", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(spatialKind, "Room", StringComparison.OrdinalIgnoreCase))
                return includeLinkedRooms;
            return false;
        }

        public static bool MatchesRequested(
            string candidateNumber,
            string candidateName,
            string requestedNumber,
            string requestedNameContains)
        {
            return (string.IsNullOrWhiteSpace(requestedNumber) ||
                    string.Equals(candidateNumber ?? "", requestedNumber, StringComparison.OrdinalIgnoreCase)) &&
                   (string.IsNullOrWhiteSpace(requestedNameContains) ||
                    (candidateName ?? "").IndexOf(requestedNameContains, StringComparison.OrdinalIgnoreCase) >= 0);
        }
    }
}

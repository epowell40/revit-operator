using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

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

    public static class SpatialPhaseVariantIdentityUtil
    {
        public static string Build(
            string spatialKind,
            string sourceScope,
            long? linkInstanceId,
            string sourceDocumentTitle,
            string number,
            string name,
            string levelName)
        {
            if (string.IsNullOrWhiteSpace(number)) return string.Empty;
            return string.Join("|", new[]
            {
                Normalize(spatialKind),
                Normalize(sourceScope),
                linkInstanceId?.ToString() ?? string.Empty,
                Normalize(sourceDocumentTitle),
                Normalize(number),
                Normalize(name),
                Normalize(levelName)
            });
        }

        private static string Normalize(string value) => (value ?? string.Empty).Trim().ToLowerInvariant();
    }

    public static class SpatialPhaseVariantProvenanceUtil
    {
        public static bool IsValid(long? sourcePhaseId, IEnumerable<long> applicableHostPhaseIds)
        {
            if (!sourcePhaseId.HasValue || sourcePhaseId.Value <= 0 || applicableHostPhaseIds == null)
                return false;
            foreach (var hostPhaseId in applicableHostPhaseIds)
            {
                if (hostPhaseId > 0) return true;
            }
            return false;
        }

        public static bool CanMerge(IEnumerable<long?> sourcePhaseIds)
        {
            if (sourcePhaseIds == null) return false;
            var seen = new HashSet<long>();
            var count = 0;
            foreach (var sourcePhaseId in sourcePhaseIds)
            {
                if (!sourcePhaseId.HasValue || sourcePhaseId.Value <= 0 || !seen.Add(sourcePhaseId.Value))
                    return false;
                count++;
            }
            return count > 0;
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

    public static class SpatialLevelMatchUtil
    {
        public static bool IsSameLevel(
            string? elementLevelName,
            double? elementLevelElevation,
            string? candidateLevelName,
            double? candidateLevelElevation,
            double elevationToleranceFt = 2.0)
        {
            if (TryGetOrdinal(elementLevelName, out var elementOrdinal) &&
                TryGetOrdinal(candidateLevelName, out var candidateOrdinal) &&
                elementOrdinal != candidateOrdinal)
                return false;

            if (elementLevelElevation.HasValue && candidateLevelElevation.HasValue)
            {
                var tolerance = Math.Max(0, elevationToleranceFt);
                return Math.Abs(elementLevelElevation.Value - candidateLevelElevation.Value) <= tolerance;
            }

            var elementKey = NormalizeName(elementLevelName);
            var candidateKey = NormalizeName(candidateLevelName);
            return elementKey.Length > 0 && string.Equals(elementKey, candidateKey, StringComparison.Ordinal);
        }

        private static bool TryGetOrdinal(string? levelName, out long ordinal)
        {
            ordinal = 0;
            if (string.IsNullOrWhiteSpace(levelName)) return false;
            var labeledMatches = Regex.Matches(
                levelName!,
                @"(?:LEVEL|LVL|FLOOR|FL)\s*[-_ ]*0*(\d+)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (labeledMatches.Count > 0)
            {
                return long.TryParse(
                    labeledMatches[labeledMatches.Count - 1].Groups[1].Value,
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out ordinal);
            }

            var matches = Regex.Matches(levelName!, @"\d+");
            if (matches.Count != 1) return false;
            return long.TryParse(
                matches[0].Value,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out ordinal);
        }

        public static string NormalizeName(string? levelName)
        {
            if (string.IsNullOrWhiteSpace(levelName)) return string.Empty;
            var upper = levelName!.Trim().ToUpperInvariant();
            var numericCanonical = Regex.Replace(upper, @"\d+", match =>
            {
                if (long.TryParse(match.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var value))
                    return value.ToString(CultureInfo.InvariantCulture);
                var trimmed = match.Value.TrimStart('0');
                return trimmed.Length > 0 ? trimmed : "0";
            });
            return Regex.Replace(numericCanonical, @"[^A-Z0-9]+", string.Empty);
        }
    }

    public static class SpatialVerticalScopeUtil
    {
        public static bool RequiresGeometry(string? spatialVerticalScope)
        {
            return string.Equals(spatialVerticalScope, "same_level", StringComparison.OrdinalIgnoreCase);
        }

        public static bool AllowsAssociationEvidence(string? spatialVerticalScope)
        {
            return !RequiresGeometry(spatialVerticalScope);
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

        public static bool HasAnyApplicablePresentPhase(IEnumerable<bool> applicablePhasePresence)
        {
            if (applicablePhasePresence == null) return false;
            foreach (var isPresent in applicablePhasePresence)
            {
                if (isPresent) return true;
            }
            return false;
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

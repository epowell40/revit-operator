using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common.Annotation
{
    public sealed class TagRect2
    {
        public TagRect2(double minX, double minY, double maxX, double maxY)
        {
            if (!IsFinite(minX) || !IsFinite(minY) || !IsFinite(maxX) || !IsFinite(maxY))
                throw new ArgumentException("Tag rectangle coordinates must be finite.");
            if (maxX < minX || maxY < minY)
                throw new ArgumentException("Tag rectangle maxima must be greater than or equal to minima.");
            MinX = minX;
            MinY = minY;
            MaxX = maxX;
            MaxY = maxY;
        }

        public double MinX { get; }
        public double MinY { get; }
        public double MaxX { get; }
        public double MaxY { get; }
        public double CenterX => (MinX + MaxX) * 0.5;
        public double CenterY => (MinY + MaxY) * 0.5;
        public double Width => MaxX - MinX;
        public double Height => MaxY - MinY;

        public TagRect2 Inflate(double amount) => new TagRect2(MinX - amount, MinY - amount, MaxX + amount, MaxY + amount);

        public bool Intersects(TagRect2 other, double tolerance = 1e-9) =>
            MaxX > other.MinX + tolerance &&
            MinX < other.MaxX - tolerance &&
            MaxY > other.MinY + tolerance &&
            MinY < other.MaxY - tolerance;

        public double IntersectionArea(TagRect2 other)
        {
            var width = Math.Max(0, Math.Min(MaxX, other.MaxX) - Math.Max(MinX, other.MinX));
            var height = Math.Max(0, Math.Min(MaxY, other.MaxY) - Math.Max(MinY, other.MinY));
            return width * height;
        }

        private static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }

    public sealed class TagSegment2
    {
        public TagSegment2(double startX, double startY, double endX, double endY)
        {
            if (!IsFinite(startX) || !IsFinite(startY) || !IsFinite(endX) || !IsFinite(endY))
                throw new ArgumentException("Tag leader coordinates must be finite.");
            StartX = startX;
            StartY = startY;
            EndX = endX;
            EndY = endY;
        }

        public double StartX { get; }
        public double StartY { get; }
        public double EndX { get; }
        public double EndY { get; }
        public double Length => Math.Sqrt(Math.Pow(EndX - StartX, 2) + Math.Pow(EndY - StartY, 2));

        public bool Intersects(TagSegment2 other, double tolerance = 1e-9)
        {
            if (other == null) throw new ArgumentNullException(nameof(other));
            var o1 = Orientation(StartX, StartY, EndX, EndY, other.StartX, other.StartY, tolerance);
            var o2 = Orientation(StartX, StartY, EndX, EndY, other.EndX, other.EndY, tolerance);
            var o3 = Orientation(other.StartX, other.StartY, other.EndX, other.EndY, StartX, StartY, tolerance);
            var o4 = Orientation(other.StartX, other.StartY, other.EndX, other.EndY, EndX, EndY, tolerance);
            if (o1 != o2 && o3 != o4) return true;
            return (o1 == 0 && OnSegment(StartX, StartY, EndX, EndY, other.StartX, other.StartY, tolerance)) ||
                   (o2 == 0 && OnSegment(StartX, StartY, EndX, EndY, other.EndX, other.EndY, tolerance)) ||
                   (o3 == 0 && OnSegment(other.StartX, other.StartY, other.EndX, other.EndY, StartX, StartY, tolerance)) ||
                   (o4 == 0 && OnSegment(other.StartX, other.StartY, other.EndX, other.EndY, EndX, EndY, tolerance));
        }

        public bool CrossesInterior(TagRect2 rect, double tolerance = 1e-9)
        {
            if (rect == null) throw new ArgumentNullException(nameof(rect));
            var minX = rect.MinX + tolerance;
            var minY = rect.MinY + tolerance;
            var maxX = rect.MaxX - tolerance;
            var maxY = rect.MaxY - tolerance;
            if (maxX <= minX || maxY <= minY) return false;
            if (Inside(StartX, StartY, minX, minY, maxX, maxY) || Inside(EndX, EndY, minX, minY, maxX, maxY)) return true;

            var t0 = 0.0;
            var t1 = 1.0;
            var dx = EndX - StartX;
            var dy = EndY - StartY;
            if (!Clip(-dx, StartX - minX, ref t0, ref t1) ||
                !Clip(dx, maxX - StartX, ref t0, ref t1) ||
                !Clip(-dy, StartY - minY, ref t0, ref t1) ||
                !Clip(dy, maxY - StartY, ref t0, ref t1)) return false;
            return t1 - t0 > tolerance;
        }

        private static bool Clip(double p, double q, ref double t0, ref double t1)
        {
            if (Math.Abs(p) <= 1e-12) return q >= 0;
            var r = q / p;
            if (p < 0)
            {
                if (r > t1) return false;
                if (r > t0) t0 = r;
            }
            else
            {
                if (r < t0) return false;
                if (r < t1) t1 = r;
            }
            return true;
        }

        private static int Orientation(double ax, double ay, double bx, double by, double cx, double cy, double tolerance)
        {
            var value = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
            if (Math.Abs(value) <= tolerance) return 0;
            return value > 0 ? 1 : 2;
        }

        private static bool OnSegment(double ax, double ay, double bx, double by, double px, double py, double tolerance) =>
            px <= Math.Max(ax, bx) + tolerance && px >= Math.Min(ax, bx) - tolerance &&
            py <= Math.Max(ay, by) + tolerance && py >= Math.Min(ay, by) - tolerance;

        private static bool Inside(double x, double y, double minX, double minY, double maxX, double maxY) =>
            x > minX && x < maxX && y > minY && y < maxY;

        private static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }

    public sealed class TagPlacementRequest
    {
        public TagRect2 Target { get; set; } = new TagRect2(0, 0, 0, 0);
        public IReadOnlyList<TagRect2> Obstacles { get; set; } = Array.Empty<TagRect2>();
        public IReadOnlyList<TagRect2> SoftObstacles { get; set; } = Array.Empty<TagRect2>();
        public IReadOnlyList<TagRect2> LeaderProtectedObstacles { get; set; } = Array.Empty<TagRect2>();
        public IReadOnlyList<TagSegment2> LeaderSegments { get; set; } = Array.Empty<TagSegment2>();
        public bool LeaderEnabled { get; set; } = true;
        public double TagWidth { get; set; }
        public double TagHeight { get; set; }
        public double Clearance { get; set; }
        public string Profile { get; set; } = "auto";
        public int MaxCandidates { get; set; } = 16;
    }

    public sealed class TagPlacementCandidate
    {
        public string Side { get; set; } = "right";
        public double HeadX { get; set; }
        public double HeadY { get; set; }
        public TagRect2 Bounds { get; set; } = new TagRect2(0, 0, 0, 0);
        public int CollisionCount { get; set; }
        public double CollisionArea { get; set; }
        public int SoftObstacleCount { get; set; }
        public double SoftObstacleArea { get; set; }
        public TagSegment2? LeaderSegment { get; set; }
        public double LeaderLength { get; set; }
        public int LeaderCrossingCount { get; set; }
        public int LeaderProtectedCrossingCount { get; set; }
        public double Score { get; set; }
        public bool CollisionFree => CollisionCount == 0 && LeaderCrossingCount == 0 && LeaderProtectedCrossingCount == 0;
    }

    public static class TagPlacementPlanner
    {
        private sealed class Direction
        {
            public string Side { get; set; } = "right";
            public double X { get; set; }
            public double Y { get; set; }
            public double Penalty { get; set; }
        }

        public static IReadOnlyList<TagPlacementCandidate> RankCandidates(TagPlacementRequest request)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            ValidatePositiveFinite(request.TagWidth, nameof(request.TagWidth));
            ValidatePositiveFinite(request.TagHeight, nameof(request.TagHeight));
            ValidateNonNegativeFinite(request.Clearance, nameof(request.Clearance));

            // The deterministic search below contains 9 lanes x 5 distance bands x 4 directions.
            // Keep the search finite, but allow callers to inspect the complete bounded lattice in
            // dense production views instead of truncating it after the first 128 positions.
            var maxCandidates = Math.Max(1, Math.Min(180, request.MaxCandidates));
            var obstacles = (request.Obstacles ?? Array.Empty<TagRect2>()).Where(x => x != null).ToList();
            var softObstacles = (request.SoftObstacles ?? Array.Empty<TagRect2>()).Where(x => x != null).ToList();
            var leaderProtectedObstacles = (request.LeaderProtectedObstacles ?? Array.Empty<TagRect2>()).Where(x => x != null).ToList();
            var leaderSegments = (request.LeaderSegments ?? Array.Empty<TagSegment2>()).Where(x => x != null).ToList();
            var directions = DirectionsFor(request.Profile);
            var candidates = new List<TagPlacementCandidate>();
            var halfWidth = request.TagWidth * 0.5;
            var halfHeight = request.TagHeight * 0.5;
            var xDistance = request.Target.Width * 0.5 + halfWidth + request.Clearance;
            var yDistance = request.Target.Height * 0.5 + halfHeight + request.Clearance;

            foreach (var lane in new[] { 0.0, 1.0, -1.0, 2.0, -2.0, 3.0, -3.0, 4.0, -4.0 })
            {
                foreach (var distanceScale in new[] { 1.0, 1.75, 2.5, 3.5, 4.75 })
                {
                    foreach (var direction in directions)
                    {
                        if (candidates.Count >= maxCandidates) break;
                        var laneStep = Math.Max(request.TagHeight, request.Clearance * 2.0);
                        var headX = request.Target.CenterX + direction.X * xDistance * distanceScale + (direction.Y != 0 ? lane * laneStep : 0);
                        var headY = request.Target.CenterY + direction.Y * yDistance * distanceScale + (direction.X != 0 ? lane * laneStep : 0);
                        var bounds = new TagRect2(headX - halfWidth, headY - halfHeight, headX + halfWidth, headY + halfHeight);
                        var collisionCount = 0;
                        var collisionArea = 0.0;
                        foreach (var obstacle in obstacles)
                        {
                            var inflated = obstacle.Inflate(request.Clearance);
                            if (!bounds.Intersects(inflated)) continue;
                            collisionCount++;
                            collisionArea += bounds.IntersectionArea(inflated);
                        }

                        var softObstacleCount = 0;
                        var softObstacleArea = 0.0;
                        foreach (var obstacle in softObstacles)
                        {
                            if (!bounds.Intersects(obstacle)) continue;
                            softObstacleCount++;
                            softObstacleArea += bounds.IntersectionArea(obstacle);
                        }

                        var leaderSegment = request.LeaderEnabled ? BuildLeaderSegment(request.Target, bounds) : null;
                        var leaderCrossingCount = leaderSegment == null ? 0 : leaderSegments.Count(segment => leaderSegment.Intersects(segment));
                        var leaderProtectedCrossingCount = leaderSegment == null
                            ? 0
                            : leaderProtectedObstacles.Count(obstacle => !SameRect(obstacle, request.Target) && leaderSegment.CrossesInterior(obstacle.Inflate(request.Clearance)));
                        var leaderLength = leaderSegment?.Length ?? 0.0;

                        var distance = Math.Sqrt(
                            Math.Pow(headX - request.Target.CenterX, 2) +
                            Math.Pow(headY - request.Target.CenterY, 2));
                        candidates.Add(new TagPlacementCandidate
                        {
                            Side = direction.Side,
                            HeadX = headX,
                            HeadY = headY,
                            Bounds = bounds,
                            CollisionCount = collisionCount,
                            CollisionArea = collisionArea,
                            SoftObstacleCount = softObstacleCount,
                            SoftObstacleArea = softObstacleArea,
                            LeaderSegment = leaderSegment,
                            LeaderLength = leaderLength,
                            LeaderCrossingCount = leaderCrossingCount,
                            LeaderProtectedCrossingCount = leaderProtectedCrossingCount,
                            Score = collisionCount * 1000000000000.0 +
                                    leaderCrossingCount * 100000000000.0 +
                                    leaderProtectedCrossingCount * 10000000000.0 +
                                    collisionArea * 1000000.0 +
                                    softObstacleCount * 100000.0 +
                                    softObstacleArea * 1000.0 +
                                    leaderLength * 2.0 +
                                    direction.Penalty * 300.0 +
                                    Math.Pow(distanceScale - 1.0, 2.0) * 10.0 +
                                    Math.Abs(lane) * 10.0 + distance
                        });
                    }
                    if (candidates.Count >= maxCandidates) break;
                }
                if (candidates.Count >= maxCandidates) break;
            }

            return candidates
                .GroupBy(x => new { x.HeadX, x.HeadY })
                .Select(group => group.OrderBy(x => x.Score).ThenBy(x => x.Side, StringComparer.Ordinal).First())
                .OrderBy(x => x.Score)
                .ThenBy(x => x.Side, StringComparer.Ordinal)
                .ThenBy(x => x.HeadX)
                .ThenBy(x => x.HeadY)
                .ToList();
        }

        public static TagSegment2 BuildLeaderSegment(TagRect2 target, TagRect2 tagBounds)
        {
            if (target == null) throw new ArgumentNullException(nameof(target));
            if (tagBounds == null) throw new ArgumentNullException(nameof(tagBounds));
            var startX = Clamp(tagBounds.CenterX, target.MinX, target.MaxX);
            var startY = Clamp(tagBounds.CenterY, target.MinY, target.MaxY);
            return new TagSegment2(startX, startY, tagBounds.CenterX, tagBounds.CenterY);
        }

        public static TagRect2 BuildConservativeLeaderEnvelope(TagRect2 target, double anchorX, double anchorY)
        {
            if (target == null) throw new ArgumentNullException(nameof(target));
            if (double.IsNaN(anchorX) || double.IsInfinity(anchorX) ||
                double.IsNaN(anchorY) || double.IsInfinity(anchorY))
                throw new ArgumentOutOfRangeException(nameof(anchorX), "Leader anchor coordinates must be finite.");
            return new TagRect2(
                Math.Min(target.MinX, anchorX),
                Math.Min(target.MinY, anchorY),
                Math.Max(target.MaxX, anchorX),
                Math.Max(target.MaxY, anchorY));
        }

        private static bool SameRect(TagRect2 left, TagRect2 right, double tolerance = 1e-9) =>
            Math.Abs(left.MinX - right.MinX) <= tolerance &&
            Math.Abs(left.MinY - right.MinY) <= tolerance &&
            Math.Abs(left.MaxX - right.MaxX) <= tolerance &&
            Math.Abs(left.MaxY - right.MaxY) <= tolerance;

        private static double Clamp(double value, double min, double max) => Math.Max(min, Math.Min(max, value));

        private static IReadOnlyList<Direction> DirectionsFor(string? profile)
        {
            var normalized = (profile ?? "auto").Trim().ToLowerInvariant();
            if (normalized == "architectural")
            {
                return new[]
                {
                    DirectionOf("top", 0, 1, 0), DirectionOf("right", 1, 0, 0.1),
                    DirectionOf("left", -1, 0, 0.2), DirectionOf("bottom", 0, -1, 0.3)
                };
            }
            if (normalized == "electrical")
            {
                return new[]
                {
                    DirectionOf("right", 1, 0, 0), DirectionOf("left", -1, 0, 0.1),
                    DirectionOf("top", 0, 1, 0.2), DirectionOf("bottom", 0, -1, 0.3)
                };
            }
            return new[]
            {
                DirectionOf("right", 1, 0, 0), DirectionOf("top", 0, 1, 0.1),
                DirectionOf("left", -1, 0, 0.2), DirectionOf("bottom", 0, -1, 0.3)
            };
        }

        private static Direction DirectionOf(string side, double x, double y, double penalty) =>
            new Direction { Side = side, X = x, Y = y, Penalty = penalty };

        private static void ValidatePositiveFinite(double value, string name)
        {
            if (double.IsNaN(value) || double.IsInfinity(value) || value <= 0)
                throw new ArgumentOutOfRangeException(name, "Value must be finite and positive.");
        }

        private static void ValidateNonNegativeFinite(double value, string name)
        {
            if (double.IsNaN(value) || double.IsInfinity(value) || value < 0)
                throw new ArgumentOutOfRangeException(name, "Value must be finite and non-negative.");
        }
    }
}

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

    public sealed class TagPlacementRequest
    {
        public TagRect2 Target { get; set; } = new TagRect2(0, 0, 0, 0);
        public IReadOnlyList<TagRect2> Obstacles { get; set; } = Array.Empty<TagRect2>();
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
        public double Score { get; set; }
        public bool CollisionFree => CollisionCount == 0;
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

            var maxCandidates = Math.Max(1, Math.Min(64, request.MaxCandidates));
            var obstacles = (request.Obstacles ?? Array.Empty<TagRect2>()).Where(x => x != null).ToList();
            var directions = DirectionsFor(request.Profile);
            var candidates = new List<TagPlacementCandidate>();
            var halfWidth = request.TagWidth * 0.5;
            var halfHeight = request.TagHeight * 0.5;
            var xDistance = request.Target.Width * 0.5 + halfWidth + request.Clearance;
            var yDistance = request.Target.Height * 0.5 + halfHeight + request.Clearance;

            foreach (var direction in directions)
            {
                foreach (var lane in new[] { 0.0, 1.0, -1.0, 2.0, -2.0 })
                {
                    if (candidates.Count >= maxCandidates) break;
                    var laneStep = Math.Max(request.TagHeight, request.Clearance * 2.0);
                    var headX = request.Target.CenterX + direction.X * xDistance + (direction.Y != 0 ? lane * laneStep : 0);
                    var headY = request.Target.CenterY + direction.Y * yDistance + (direction.X != 0 ? lane * laneStep : 0);
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
                        Score = collisionCount * 1000000.0 + collisionArea * 1000.0 + direction.Penalty * 1000.0 + Math.Abs(lane) * 10.0 + distance
                    });
                }
                if (candidates.Count >= maxCandidates) break;
            }

            return candidates
                .OrderBy(x => x.Score)
                .ThenBy(x => x.Side, StringComparer.Ordinal)
                .ThenBy(x => x.HeadX)
                .ThenBy(x => x.HeadY)
                .ToList();
        }

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

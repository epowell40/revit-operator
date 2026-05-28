using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common.LowVoltage.Core.Geometry
{
    public static class Geometry2D
    {
        public static Point3 GetCentroid(IReadOnlyCollection<Point3> polygon)
        {
            if (polygon == null || polygon.Count == 0) return new Point3();
            return new Point3
            {
                X = polygon.Average(point => point.X),
                Y = polygon.Average(point => point.Y),
                Z = polygon.Average(point => point.Z)
            };
        }

        public static bool TryGetBounds(IReadOnlyCollection<Point3> points, out BoundingBox2D bounds)
        {
            if (points == null || points.Count == 0)
            {
                bounds = new BoundingBox2D();
                return false;
            }

            bounds = new BoundingBox2D
            {
                MinX = points.Min(point => point.X),
                MinY = points.Min(point => point.Y),
                MaxX = points.Max(point => point.X),
                MaxY = points.Max(point => point.Y)
            };
            return true;
        }

        public static bool ContainsPoint(IReadOnlyList<Point3> polygon, Point3 point, double tolerance = 0.05)
        {
            if (polygon == null || polygon.Count == 0) return false;
            if (polygon.Count == 1) return Distance(polygon[0], point) <= tolerance;
            if (polygon.Count == 2) return DistanceToSegment(point, polygon[0], polygon[1]) <= tolerance;

            if (DistanceToPolygonEdges(polygon, point) <= tolerance) return true;

            var inside = false;
            for (var i = 0; i < polygon.Count; i++)
            {
                var j = (i + polygon.Count - 1) % polygon.Count;
                var xi = polygon[i].X;
                var yi = polygon[i].Y;
                var xj = polygon[j].X;
                var yj = polygon[j].Y;
                var crosses = ((yi > point.Y) != (yj > point.Y))
                    && (point.X < ((xj - xi) * (point.Y - yi) / ((yj - yi) == 0 ? double.Epsilon : (yj - yi))) + xi);
                if (crosses)
                {
                    inside = !inside;
                }
            }

            return inside;
        }

        public static bool PolygonsTouchOrOverlap(IReadOnlyList<Point3> a, IReadOnlyList<Point3> b, double tolerance)
        {
            if (a == null || b == null || a.Count == 0 || b.Count == 0) return false;

            foreach (var point in a)
            {
                if (ContainsPoint(b, point, tolerance)) return true;
            }

            foreach (var point in b)
            {
                if (ContainsPoint(a, point, tolerance)) return true;
            }

            foreach (var segmentA in GetSegments(a))
            {
                foreach (var segmentB in GetSegments(b))
                {
                    if (SegmentDistance(segmentA.Start, segmentA.End, segmentB.Start, segmentB.End) <= tolerance)
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        public static double Distance(Point3 a, Point3 b)
        {
            var dx = a.X - b.X;
            var dy = a.Y - b.Y;
            var dz = a.Z - b.Z;
            return Math.Sqrt((dx * dx) + (dy * dy) + (dz * dz));
        }

        public static double DistanceToPolygon(IReadOnlyList<Point3> polygon, Point3 point)
        {
            if (ContainsPoint(polygon, point)) return 0;
            return DistanceToPolygonEdges(polygon, point);
        }

        public static double DistanceToPolygonEdges(IReadOnlyList<Point3> polygon, Point3 point)
        {
            if (polygon == null || polygon.Count == 0) return double.MaxValue;
            if (polygon.Count == 1) return Distance(polygon[0], point);

            return GetSegments(polygon)
                .Select(segment => DistanceToSegment(point, segment.Start, segment.End))
                .DefaultIfEmpty(double.MaxValue)
                .Min();
        }

        public static Point3 ProjectToward(Point3 from, Point3 to, double distance)
        {
            var dx = to.X - from.X;
            var dy = to.Y - from.Y;
            var dz = to.Z - from.Z;
            var length = Math.Sqrt((dx * dx) + (dy * dy) + (dz * dz));
            if (length <= 1e-9 || distance <= 0) return new Point3 { X = from.X, Y = from.Y, Z = from.Z };

            var scale = distance / length;
            return new Point3
            {
                X = from.X + (dx * scale),
                Y = from.Y + (dy * scale),
                Z = from.Z + (dz * scale)
            };
        }

        private static double DistanceToSegment(Point3 point, Point3 start, Point3 end)
        {
            var dx = end.X - start.X;
            var dy = end.Y - start.Y;
            var lengthSquared = (dx * dx) + (dy * dy);
            if (lengthSquared <= 1e-9) return Distance(point, start);

            var t = ((point.X - start.X) * dx + ((point.Y - start.Y) * dy)) / lengthSquared;
            t = Math.Max(0, Math.Min(1, t));
            var projection = new Point3
            {
                X = start.X + (t * dx),
                Y = start.Y + (t * dy),
                Z = start.Z + ((end.Z - start.Z) * t)
            };
            return Distance(point, projection);
        }

        private static IEnumerable<(Point3 Start, Point3 End)> GetSegments(IReadOnlyList<Point3> polygon)
        {
            if (polygon.Count < 2) yield break;
            for (var i = 0; i < polygon.Count; i++)
            {
                var start = polygon[i];
                var end = polygon[(i + 1) % polygon.Count];
                yield return (start, end);
            }
        }

        private static double SegmentDistance(Point3 aStart, Point3 aEnd, Point3 bStart, Point3 bEnd)
        {
            return new[]
            {
                DistanceToSegment(aStart, bStart, bEnd),
                DistanceToSegment(aEnd, bStart, bEnd),
                DistanceToSegment(bStart, aStart, aEnd),
                DistanceToSegment(bEnd, aStart, aEnd)
            }.Min();
        }
    }
}

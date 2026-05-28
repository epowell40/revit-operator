using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Placement;

namespace RevitBridge.Common.LowVoltage.Core.Candidates
{
    public static class CandidateGenerator
    {
        public static IEnumerable<CandidatePoint> GenerateWallHostPoints(IEnumerable<WallState> walls, double spacing = 10)
        {
            foreach (var wall in walls.Where(w => w.IsHostable))
            {
                var dx = wall.End.X - wall.Start.X;
                var dy = wall.End.Y - wall.Start.Y;
                var length = Math.Sqrt(dx * dx + dy * dy);
                var count = Math.Max(1, (int)Math.Floor(length / spacing));
                for (var i = 1; i <= count; i++)
                {
                    var t = (double)i / (count + 1);
                    yield return new CandidatePoint
                    {
                        Id = $"wall-{wall.Id}-{i}",
                        Strategy = "wall_host",
                        HostType = "wall",
                        HostElementId = wall.Id,
                        Location = new Point3 { X = wall.Start.X + (dx * t), Y = wall.Start.Y + (dy * t), Z = wall.Start.Z },
                        Meta = new Dictionary<string, string> { ["wallId"] = wall.Id.ToString() }
                    };
                }
            }
        }

        public static IEnumerable<CandidatePoint> GenerateRoomCenteredPoints(IEnumerable<RoomState> rooms)
        {
            foreach (var room in rooms)
            {
                if (!room.BoundaryPolygon.Any()) continue;
                yield return new CandidatePoint
                {
                    Id = $"room-center-{room.Id}",
                    Strategy = "room_center",
                    HostType = "room",
                    RoomId = room.Id,
                    Location = Geometry2D.GetCentroid(room.BoundaryPolygon),
                    Meta = new Dictionary<string, string> { ["roomId"] = room.Id.ToString() }
                };
            }
        }

        public static IEnumerable<CandidatePoint> GenerateRoomEntryPoints(IEnumerable<RoomState> rooms, IEnumerable<OpeningState> openings, double offset = 2.0, double maxOpeningDistance = 6.0)
        {
            var openingList = openings.ToList();
            foreach (var room in rooms.Where(r => r.BoundaryPolygon.Any()))
            {
                var centroid = Geometry2D.GetCentroid(room.BoundaryPolygon);
                var nearestOpening = openingList
                    .Select(opening => new
                    {
                        Opening = opening,
                        Distance = Geometry2D.DistanceToPolygon(room.BoundaryPolygon, opening.Location)
                    })
                    .Where(x => x.Distance <= maxOpeningDistance)
                    .OrderBy(x => x.Distance)
                    .ThenBy(x => x.Opening.Id)
                    .FirstOrDefault();
                if (nearestOpening == null) continue;

                yield return new CandidatePoint
                {
                    Id = $"room-entry-{room.Id}-{nearestOpening.Opening.Id}",
                    Strategy = "room_entry",
                    HostType = "room",
                    HostElementId = nearestOpening.Opening.HostWallId,
                    RoomId = room.Id,
                    Location = Geometry2D.ProjectToward(nearestOpening.Opening.Location, centroid, offset),
                    Meta = new Dictionary<string, string>
                    {
                        ["roomId"] = room.Id.ToString(),
                        ["openingId"] = nearestOpening.Opening.Id.ToString()
                    }
                };
            }
        }

        public static IEnumerable<CandidatePoint> GenerateNearFixturePoints(IEnumerable<FixtureState> fixtures, double offset = 1.0)
            => fixtures.Select(f => new CandidatePoint
            {
                Id = $"fixture-{f.Id}",
                Strategy = "near_fixture",
                HostType = "fixture",
                HostElementId = f.Id,
                Location = new Point3 { X = f.Location.X + offset, Y = f.Location.Y, Z = f.Location.Z }
            });

        public static IEnumerable<CandidatePoint> GenerateNearEquipmentPoints(IEnumerable<EquipmentState> equipment, double offset = 1.0)
            => equipment.Select(e => new CandidatePoint
            {
                Id = $"equipment-{e.Id}",
                Strategy = "near_equipment",
                HostType = "equipment",
                HostElementId = e.Id,
                Location = new Point3 { X = e.Location.X + offset, Y = e.Location.Y, Z = e.Location.Z }
            });


        public static IEnumerable<CandidatePoint> GenerateCeilingHostPoints(IEnumerable<CeilingState> ceilings)
        {
            foreach (var c in ceilings.Where(c => c.Bounds != null))
            {
                yield return new CandidatePoint
                {
                    Id = $"ceiling-{c.Id}",
                    Strategy = "ceiling_host",
                    HostType = "ceiling",
                    HostElementId = c.Id,
                    Location = new Point3
                    {
                        X = (c.Bounds!.MinX + c.Bounds.MaxX) / 2.0,
                        Y = (c.Bounds.MinY + c.Bounds.MaxY) / 2.0,
                        Z = c.Elevation ?? 0
                    }
                };
            }
        }

        public static IEnumerable<CandidatePoint> GenerateCorridorOffsetPoints(IEnumerable<RoomState> rooms, double offset = 2.0)
        {
            foreach (var room in rooms.Where(r => string.Equals(r.SemanticType, "corridor", StringComparison.OrdinalIgnoreCase) && r.BoundaryPolygon.Any()))
            {
                var centroid = Geometry2D.GetCentroid(room.BoundaryPolygon);
                yield return new CandidatePoint
                {
                    Id = $"corridor-{room.Id}",
                    Strategy = "corridor_offset",
                    HostType = "room",
                    RoomId = room.Id,
                    Location = new Point3 { X = centroid.X + offset, Y = centroid.Y, Z = centroid.Z },
                    Meta = new Dictionary<string, string> { ["roomId"] = room.Id.ToString() }
                };
            }
        }

        public static IEnumerable<CandidatePoint> GenerateCorridorCenterlinePoints(IEnumerable<RoomState> rooms, double spacing = 24.0, double endOffset = 8.0)
        {
            foreach (var room in rooms.Where(r => string.Equals(r.SemanticType, "corridor", StringComparison.OrdinalIgnoreCase) && r.BoundaryPolygon.Any()))
            {
                if (!Geometry2D.TryGetBounds(room.BoundaryPolygon, out var bounds)) continue;

                var width = bounds.MaxX - bounds.MinX;
                var height = bounds.MaxY - bounds.MinY;
                var alongX = width >= height;
                var span = alongX ? width : height;
                var start = alongX ? bounds.MinX : bounds.MinY;
                var end = alongX ? bounds.MaxX : bounds.MaxY;
                var cross = alongX ? (bounds.MinY + bounds.MaxY) / 2.0 : (bounds.MinX + bounds.MaxX) / 2.0;

                var usableStart = start + Math.Max(0, endOffset);
                var usableEnd = end - Math.Max(0, endOffset);
                if (usableEnd < usableStart)
                {
                    usableStart = start + (span / 2.0);
                    usableEnd = usableStart;
                }

                var step = Math.Max(1.0, spacing);
                var count = Math.Max(1, (int)Math.Ceiling(Math.Max(0.0, usableEnd - usableStart) / step) + 1);
                for (var i = 0; i < count; i++)
                {
                    var t = count == 1 ? 0.5 : (double)i / (count - 1);
                    var axisValue = usableStart + ((usableEnd - usableStart) * t);
                    var point = alongX
                        ? new Point3 { X = axisValue, Y = cross, Z = room.BoundaryPolygon.Average(p => p.Z) }
                        : new Point3 { X = cross, Y = axisValue, Z = room.BoundaryPolygon.Average(p => p.Z) };
                    yield return new CandidatePoint
                    {
                        Id = $"corridor-centerline-{room.Id}-{i + 1}",
                        Strategy = "corridor_centerline",
                        HostType = "room",
                        RoomId = room.Id,
                        Location = point,
                        Meta = new Dictionary<string, string>
                        {
                            ["roomId"] = room.Id.ToString(),
                            ["axis"] = alongX ? "x" : "y",
                            ["station"] = (i + 1).ToString()
                        }
                    };
                }
            }
        }

        public static IEnumerable<CandidatePoint> GenerateCorridorEndOffsetPoints(IEnumerable<RoomState> rooms, double endOffset = 8.0)
        {
            foreach (var room in rooms.Where(r => string.Equals(r.SemanticType, "corridor", StringComparison.OrdinalIgnoreCase) && r.BoundaryPolygon.Any()))
            {
                if (!Geometry2D.TryGetBounds(room.BoundaryPolygon, out var bounds)) continue;
                var width = bounds.MaxX - bounds.MinX;
                var height = bounds.MaxY - bounds.MinY;
                var alongX = width >= height;
                var cross = alongX ? (bounds.MinY + bounds.MaxY) / 2.0 : (bounds.MinX + bounds.MaxX) / 2.0;
                var axisStart = alongX ? bounds.MinX : bounds.MinY;
                var axisEnd = alongX ? bounds.MaxX : bounds.MaxY;
                foreach (var entry in new[]
                {
                    new { Index = 1, AxisValue = axisStart + Math.Max(0, endOffset) },
                    new { Index = 2, AxisValue = axisEnd - Math.Max(0, endOffset) }
                })
                {
                    yield return new CandidatePoint
                    {
                        Id = $"corridor-end-{room.Id}-{entry.Index}",
                        Strategy = "corridor_end_offset",
                        HostType = "room",
                        RoomId = room.Id,
                        Location = alongX
                            ? new Point3 { X = entry.AxisValue, Y = cross, Z = room.BoundaryPolygon.Average(p => p.Z) }
                            : new Point3 { X = cross, Y = entry.AxisValue, Z = room.BoundaryPolygon.Average(p => p.Z) },
                        Meta = new Dictionary<string, string>
                        {
                            ["roomId"] = room.Id.ToString(),
                            ["end"] = entry.Index == 1 ? "start" : "end"
                        }
                    };
                };
            }
        }

        public static IEnumerable<CandidatePoint> GenerateAnchorRelativeWallPoints(
            string anchorId,
            long roomId,
            Point3 anchorLocation,
            IReadOnlyList<Point3> roomPolygon,
            IEnumerable<CandidatePoint> wallCandidates,
            double minDistance,
            double maxDistance)
        {
            foreach (var candidate in wallCandidates
                .Where(candidate => string.Equals(candidate.HostType, "wall", StringComparison.OrdinalIgnoreCase))
                .OrderBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase))
            {
                var distance = Geometry2D.Distance(anchorLocation, candidate.Location);
                if (distance < minDistance || distance > maxDistance) continue;
                if (roomPolygon.Count > 0 && !Geometry2D.ContainsPoint(roomPolygon, candidate.Location, 0.2)) continue;

                yield return new CandidatePoint
                {
                    Id = $"anchor-wall-{anchorId}-{candidate.Id}",
                    Strategy = "anchor_wall_host",
                    HostType = candidate.HostType,
                    HostElementId = candidate.HostElementId,
                    RoomId = roomId,
                    Location = candidate.Location,
                    Meta = new Dictionary<string, string>(candidate.Meta)
                    {
                        ["anchorId"] = anchorId,
                        ["roomId"] = roomId.ToString()
                    }
                };
            }
        }

        public static IEnumerable<CandidatePoint> GenerateNearestWallHostPoints(
            string referenceId,
            long roomId,
            Point3 referenceLocation,
            IReadOnlyList<Point3> roomPolygon,
            IEnumerable<CandidatePoint> wallCandidates,
            double minDistance,
            double maxDistance,
            int maxResults = 4)
        {
            return GenerateAnchorRelativeWallPoints(referenceId, roomId, referenceLocation, roomPolygon, wallCandidates, minDistance, maxDistance)
                .Select(candidate =>
                {
                    candidate.Id = $"nearest-wall-{referenceId}-{candidate.HostElementId}-{candidate.Id}";
                    candidate.Strategy = "endpoint_wall_host";
                    candidate.Meta["referenceId"] = referenceId;
                    candidate.Meta["distanceFt"] = Geometry2D.Distance(referenceLocation, candidate.Location).ToString("0.###");
                    return candidate;
                })
                .OrderBy(candidate => Geometry2D.Distance(referenceLocation, candidate.Location))
                .ThenBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
                .Take(Math.Max(1, maxResults));
        }

        public static IEnumerable<CandidatePoint> GenerateAnchorRelativeCeilingPoints(
            string anchorId,
            long roomId,
            Point3 anchorLocation,
            IReadOnlyList<Point3> roomPolygon,
            IEnumerable<CandidatePoint> ceilingCandidates,
            double minDistance,
            double maxDistance)
        {
            foreach (var candidate in ceilingCandidates
                .Where(candidate => string.Equals(candidate.HostType, "ceiling", StringComparison.OrdinalIgnoreCase))
                .OrderBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase))
            {
                var distance = Geometry2D.Distance(anchorLocation, candidate.Location);
                if (distance < minDistance || distance > maxDistance) continue;
                if (roomPolygon.Count > 0 && !Geometry2D.ContainsPoint(roomPolygon, candidate.Location, 0.2)) continue;

                yield return new CandidatePoint
                {
                    Id = $"anchor-ceiling-{anchorId}-{candidate.Id}",
                    Strategy = "anchor_ceiling_host",
                    HostType = candidate.HostType,
                    HostElementId = candidate.HostElementId,
                    RoomId = roomId,
                    Location = candidate.Location,
                    Meta = new Dictionary<string, string>(candidate.Meta)
                    {
                        ["anchorId"] = anchorId,
                        ["roomId"] = roomId.ToString()
                    }
                };
            }
        }
    }
}

using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Candidates;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Placement;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class LowVoltageCandidateTests
    {
        [Fact]
        public void CandidateGenerator_Creates_Wall_And_Room_Points()
        {
            var walls = new List<WallState> { new WallState { Id = 10, IsHostable = true, Start = new Point3 { X = 0, Y = 0, Z = 0 }, End = new Point3 { X = 20, Y = 0, Z = 0 } } };
            var rooms = new List<RoomState>
            {
                new RoomState
                {
                    Id = 99,
                    BoundaryPolygon = new List<Point3>
                    {
                        new Point3 { X = 0, Y = 0 },
                        new Point3 { X = 10, Y = 0 },
                        new Point3 { X = 10, Y = 10 },
                        new Point3 { X = 0, Y = 10 }
                    }
                },
                new RoomState
                {
                    Id = 100,
                    SemanticType = "corridor",
                    BoundaryPolygon = new List<Point3>
                    {
                        new Point3 { X = 0, Y = 20 },
                        new Point3 { X = 40, Y = 20 },
                        new Point3 { X = 40, Y = 26 },
                        new Point3 { X = 0, Y = 26 }
                    }
                }
            };
            var openings = new List<OpeningState> { new OpeningState { Id = 50, HostWallId = 10, Location = new Point3 { X = 0, Y = 5, Z = 0 } } };

            var wallCandidates = CandidateGenerator.GenerateWallHostPoints(walls, spacing: 8).ToList();
            var roomCandidates = CandidateGenerator.GenerateRoomCenteredPoints(rooms).ToList();
            var entryCandidates = CandidateGenerator.GenerateRoomEntryPoints(rooms, openings).ToList();
            var corridorCandidates = CandidateGenerator.GenerateCorridorCenterlinePoints(rooms, spacing: 12, endOffset: 6).ToList();

            Assert.NotEmpty(wallCandidates);
            Assert.Equal(2, roomCandidates.Count);
            Assert.Single(entryCandidates);
            Assert.True(corridorCandidates.Count >= 2);
            Assert.Equal("room_center", roomCandidates[0].Strategy);
        }

        [Fact]
        public void CandidateGenerator_Creates_AnchorRelative_Points_InsideRoom()
        {
            var roomPolygon = new List<Point3>
            {
                new Point3 { X = 0, Y = 0 },
                new Point3 { X = 12, Y = 0 },
                new Point3 { X = 12, Y = 12 },
                new Point3 { X = 0, Y = 12 }
            };

            var wallCandidates = new List<CandidatePoint>
            {
                new CandidatePoint
                {
                    Id = "wall-10-1",
                    Strategy = "wall_host",
                    HostType = "wall",
                    HostElementId = 10,
                    RoomId = 99,
                    Location = new Point3 { X = 2, Y = 0.1 }
                },
                new CandidatePoint
                {
                    Id = "wall-10-2",
                    Strategy = "wall_host",
                    HostType = "wall",
                    HostElementId = 10,
                    RoomId = 99,
                    Location = new Point3 { X = 11, Y = 0.1 }
                }
            };

            var ceilingCandidates = new List<CandidatePoint>
            {
                new CandidatePoint
                {
                    Id = "ceiling-20",
                    Strategy = "ceiling_host",
                    HostType = "ceiling",
                    HostElementId = 20,
                    RoomId = 99,
                    Location = new Point3 { X = 6, Y = 6, Z = 0 }
                }
            };

            var wallRelative = CandidateGenerator.GenerateAnchorRelativeWallPoints("fixture:1", 99, new Point3 { X = 4, Y = 4 }, roomPolygon, wallCandidates, 1.0, 6.5).ToList();
            var ceilingRelative = CandidateGenerator.GenerateAnchorRelativeCeilingPoints("fixture:1", 99, new Point3 { X = 4, Y = 4 }, roomPolygon, ceilingCandidates, 1.0, 4.0).ToList();

            Assert.Single(wallRelative);
            Assert.Equal("anchor_wall_host", wallRelative[0].Strategy);
            Assert.Equal("fixture:1", wallRelative[0].Meta["anchorId"]);
            Assert.Single(ceilingRelative);
            Assert.Equal("anchor_ceiling_host", ceilingRelative[0].Strategy);
        }

        [Fact]
        public void CandidateGenerator_Creates_NearestWallHost_Points_InDistanceOrder()
        {
            var roomPolygon = new List<Point3>
            {
                new Point3 { X = 0, Y = 0 },
                new Point3 { X = 10, Y = 0 },
                new Point3 { X = 10, Y = 6 },
                new Point3 { X = 0, Y = 6 }
            };

            var wallCandidates = new List<CandidatePoint>
            {
                new CandidatePoint
                {
                    Id = "wall-left",
                    Strategy = "wall_host",
                    HostType = "wall",
                    HostElementId = 10,
                    RoomId = 1,
                    Location = new Point3 { X = 0.1, Y = 3, Z = 0 }
                },
                new CandidatePoint
                {
                    Id = "wall-right",
                    Strategy = "wall_host",
                    HostType = "wall",
                    HostElementId = 11,
                    RoomId = 1,
                    Location = new Point3 { X = 9.9, Y = 3, Z = 0 }
                }
            };

            var candidates = CandidateGenerator.GenerateNearestWallHostPoints("endpoint:1", 1, new Point3 { X = 2, Y = 3, Z = 0 }, roomPolygon, wallCandidates, 1.0, 8.5, maxResults: 2).ToList();

            Assert.Equal(2, candidates.Count);
            Assert.Equal("endpoint_wall_host", candidates[0].Strategy);
            Assert.Equal(10, candidates[0].HostElementId);
            Assert.Equal("endpoint:1", candidates[0].Meta["referenceId"]);
        }
    }
}

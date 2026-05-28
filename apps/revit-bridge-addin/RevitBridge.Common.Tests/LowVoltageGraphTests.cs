using System.Collections.Generic;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Graphs;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class LowVoltageGraphTests
    {
        [Fact]
        public void Graph_Detects_Adjacency_And_OpenToCorridor()
        {
            var state = new ModelState
            {
                Rooms = new List<RoomState>
                {
                    new RoomState { Id = 1, SemanticType = "corridor", BoundaryPolygon = new List<Point3>{ new Point3{X=0,Y=0}, new Point3{X=10,Y=0} } },
                    new RoomState { Id = 2, SemanticType = "patient_room", BoundaryPolygon = new List<Point3>{ new Point3{X=10,Y=0}, new Point3{X=20,Y=0} } }
                }
            };

            var graph = SpaceGraphBuilder.Build(state, tolerance: 0.01);
            Assert.Contains(2, graph.Adjacency[1]);
            Assert.Contains(2, graph.OpenToCorridorRooms);
            Assert.Contains(graph.Groups, group => group.GroupType == "corridor_group" && group.RoomIds.Contains(1));
        }
    }
}

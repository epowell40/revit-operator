using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Geometry;

namespace RevitBridge.Common.LowVoltage.Core.Graphs
{
    public class SpaceGroup
    {
        public string GroupId { get; set; } = string.Empty;
        public string GroupType { get; set; } = string.Empty;
        public List<long> RoomIds { get; set; } = new List<long>();
    }

    public class SpaceGraph
    {
        public Dictionary<long, HashSet<long>> Adjacency { get; } = new Dictionary<long, HashSet<long>>();
        public HashSet<long> OpenToCorridorRooms { get; } = new HashSet<long>();
        public List<SpaceGroup> Groups { get; } = new List<SpaceGroup>();

        public IEnumerable<List<long>> GetConnectedGroups()
        {
            var visited = new HashSet<long>();
            foreach (var roomId in Adjacency.Keys)
            {
                if (!visited.Add(roomId)) continue;
                var stack = new Stack<long>();
                var group = new List<long>();
                stack.Push(roomId);
                while (stack.Count > 0)
                {
                    var id = stack.Pop();
                    group.Add(id);
                    foreach (var n in Adjacency[id])
                    {
                        if (visited.Add(n)) stack.Push(n);
                    }
                }

                yield return group;
            }
        }
    }

    public static class SpaceGraphBuilder
    {
        public static SpaceGraph Build(ModelState state, double tolerance = 0.25)
        {
            var graph = new SpaceGraph();
            foreach (var room in state.Rooms)
            {
                graph.Adjacency[room.Id] = new HashSet<long>();
            }

            for (var i = 0; i < state.Rooms.Count; i++)
            {
                for (var j = i + 1; j < state.Rooms.Count; j++)
                {
                    if (Geometry2D.PolygonsTouchOrOverlap(state.Rooms[i].BoundaryPolygon, state.Rooms[j].BoundaryPolygon, tolerance))
                    {
                        graph.Adjacency[state.Rooms[i].Id].Add(state.Rooms[j].Id);
                        graph.Adjacency[state.Rooms[j].Id].Add(state.Rooms[i].Id);
                    }
                }
            }

            var corridorIds = state.Rooms.Where(r => string.Equals(r.SemanticType, "corridor", StringComparison.OrdinalIgnoreCase)).Select(r => r.Id).ToHashSet();
            foreach (var room in state.Rooms)
            {
                if (graph.Adjacency.TryGetValue(room.Id, out var neighbors) && neighbors.Any(corridorIds.Contains))
                {
                    graph.OpenToCorridorRooms.Add(room.Id);
                }
            }

            AddGroups(graph, state);
            return graph;
        }

        private static void AddGroups(SpaceGraph graph, ModelState state)
        {
            AddTypedGroups(graph, state, "corridor_group", room => string.Equals(room.SemanticType, "corridor", StringComparison.OrdinalIgnoreCase));
            AddTypedGroups(
                graph,
                state,
                "open_suite",
                room => graph.OpenToCorridorRooms.Contains(room.Id)
                    && !string.Equals(room.SemanticType, "corridor", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(room.SemanticType, "utility_room", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(room.SemanticType, "support_room", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(room.SemanticType, "unknown", StringComparison.OrdinalIgnoreCase));
        }

        private static void AddTypedGroups(SpaceGraph graph, ModelState state, string groupType, Func<RoomState, bool> include)
        {
            var roomsById = state.Rooms.ToDictionary(room => room.Id);
            var eligible = state.Rooms.Where(include).Select(room => room.Id).ToHashSet();
            var visited = new HashSet<long>();
            foreach (var roomId in eligible.OrderBy(id => id))
            {
                if (!visited.Add(roomId)) continue;
                var group = new List<long>();
                var stack = new Stack<long>();
                stack.Push(roomId);
                while (stack.Count > 0)
                {
                    var current = stack.Pop();
                    group.Add(current);
                    if (!graph.Adjacency.TryGetValue(current, out var neighbors)) continue;
                    foreach (var neighbor in neighbors.Where(eligible.Contains).OrderBy(id => id))
                    {
                        if (visited.Add(neighbor))
                        {
                            stack.Push(neighbor);
                        }
                    }
                }

                if (!group.Any()) continue;
                graph.Groups.Add(new SpaceGroup
                {
                    GroupId = $"{groupType}:{string.Join("-", group.OrderBy(id => id))}",
                    GroupType = groupType,
                    RoomIds = group.OrderBy(id => id).ToList()
                });
            }
        }
    }
}

using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Candidates;
using RevitBridge.Common.LowVoltage.Core.Diagnostics;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Graphs;
using RevitBridge.Common.LowVoltage.Core.Placement;
using RevitBridge.Common.LowVoltage.Core.Rules;
using RevitBridge.Logic.LowVoltage.Skills.DataOutlets;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class DataOutletsRuleEngineTests
    {
        [Fact]
        public void DataOutletsEngine_SelectsNearestValidWallCandidate()
        {
            var context = BuildContext(includeFamilyTypes: true);
            var result = new DataOutletsRuleEngine().Evaluate(context);

            var action = Assert.Single(result.ProposedActions);
            Assert.Equal("data_outlet", action.DeviceCategory);
            Assert.Equal("endpoint_wall_host", action.Candidate.Strategy);
            Assert.Equal(10, action.HostElementId);
        }

        [Fact]
        public void DataOutletsEngine_SuppressesDuplicates_ForClusteredEndpoints()
        {
            var context = BuildContext(includeFamilyTypes: true, includeClusteredEndpoint: true);
            var result = new DataOutletsRuleEngine().Evaluate(context);

            Assert.Single(result.ProposedActions);
            Assert.Contains(context.Diagnostics.SkippedEndpoints, item => item.Reason == "clustered_with_existing_endpoint");
        }

        [Fact]
        public void DataOutletsEngine_ReviewsUnknownFamilies_ForMappingExpansion()
        {
            var context = BuildContext(includeFamilyTypes: true, useUnknownEndpoint: true);
            var result = new DataOutletsRuleEngine().Evaluate(context);

            Assert.Contains(context.Diagnostics.UnknownEndpointMappings, item => item.StartsWith("equipment:700:", System.StringComparison.OrdinalIgnoreCase));
            Assert.Contains(result.ManualReviews, review => review.Code == "unknown_endpoint");
        }

        [Fact]
        public void DataOutletsEngine_IsDeterministic_ForSameInput()
        {
            var first = BuildContext(includeFamilyTypes: true, includeClusteredEndpoint: true);
            var second = BuildContext(includeFamilyTypes: true, includeClusteredEndpoint: true);

            var firstResult = new DataOutletsRuleEngine().Evaluate(first);
            var secondResult = new DataOutletsRuleEngine().Evaluate(second);

            var firstActions = firstResult.ProposedActions.Select(action => action.ActionId + "|" + action.Candidate.Id).ToList();
            var secondActions = secondResult.ProposedActions.Select(action => action.ActionId + "|" + action.Candidate.Id).ToList();

            Assert.Equal(firstActions, secondActions);
        }

        private static LayoutContext BuildContext(bool includeFamilyTypes, bool includeClusteredEndpoint = false, bool useUnknownEndpoint = false)
        {
            var state = new ModelState
            {
                Rooms = new List<RoomState>
                {
                    CreateRoom(1, "OFFICE 101", "office", 0, 0, 10, 6)
                },
                Openings = new List<OpeningState>
                {
                    new OpeningState { Id = 50, HostWallId = 10, Location = new Point3 { X = 0, Y = 3, Z = 0 } }
                },
                Equipment = new List<EquipmentState>
                {
                    new EquipmentState
                    {
                        Id = 600,
                        Category = "Furniture",
                        FamilyName = "Dell Computer",
                        TypeName = "Workstation",
                        SemanticType = "workstation_computer",
                        Location = new Point3 { X = 2, Y = 3, Z = 0 }
                    }
                }
            };

            if (includeClusteredEndpoint)
            {
                state.Equipment.Add(new EquipmentState
                {
                    Id = 601,
                    Category = "Furniture",
                    FamilyName = "Dell Computer",
                    TypeName = "Workstation",
                    SemanticType = "workstation_computer",
                    Location = new Point3 { X = 2.8, Y = 3.2, Z = 0 }
                });
            }

            if (useUnknownEndpoint)
            {
                state.Equipment.Add(new EquipmentState
                {
                    Id = 700,
                    Category = "Furniture",
                    FamilyName = "Mystery Computer Cart",
                    TypeName = "Unknown Terminal",
                    SemanticType = "unknown",
                    Location = new Point3 { X = 7, Y = 3, Z = 0 }
                });
            }

            state.Walls.AddRange(CreatePerimeterWalls(10, 0, 0, 10, 6));

            if (includeFamilyTypes)
            {
                state.FamilyTypes.Add(new FamilyTypeState
                {
                    Id = 800,
                    Category = "Communication Devices",
                    FamilyName = "Data Outlet",
                    TypeName = "CAT6 Outlet",
                    IsActive = true
                });
            }

            var graph = SpaceGraphBuilder.Build(state, tolerance: 0.1);
            var candidates = new List<CandidatePoint>();
            candidates.AddRange(CandidateGenerator.GenerateWallHostPoints(state.Walls, spacing: 6));
            candidates.AddRange(CandidateGenerator.GenerateRoomEntryPoints(state.Rooms, state.Openings));
            candidates.AddRange(CandidateGenerator.GenerateRoomCenteredPoints(state.Rooms));

            return new LayoutContext
            {
                Discipline = "data_outlets",
                State = state,
                Graph = graph,
                Candidates = candidates.OrderBy(candidate => candidate.Id).ToList(),
                DisciplineProfile = DataOutletsProfile.CreateDefault(),
                Diagnostics = new DiagnosticReport()
            };
        }

        private static RoomState CreateRoom(long id, string name, string semanticType, double minX, double minY, double maxX, double maxY)
        {
            return new RoomState
            {
                Id = id,
                Name = name,
                SemanticType = semanticType,
                Area = (maxX - minX) * (maxY - minY),
                BoundaryPolygon = new List<Point3>
                {
                    new Point3 { X = minX, Y = minY, Z = 0 },
                    new Point3 { X = maxX, Y = minY, Z = 0 },
                    new Point3 { X = maxX, Y = maxY, Z = 0 },
                    new Point3 { X = minX, Y = maxY, Z = 0 }
                }
            };
        }

        private static IEnumerable<WallState> CreatePerimeterWalls(long baseId, double minX, double minY, double maxX, double maxY)
        {
            return new[]
            {
                new WallState { Id = baseId, IsHostable = true, Start = new Point3 { X = minX, Y = minY, Z = 0 }, End = new Point3 { X = maxX, Y = minY, Z = 0 } },
                new WallState { Id = baseId + 1, IsHostable = true, Start = new Point3 { X = maxX, Y = minY, Z = 0 }, End = new Point3 { X = maxX, Y = maxY, Z = 0 } },
                new WallState { Id = baseId + 2, IsHostable = true, Start = new Point3 { X = maxX, Y = maxY, Z = 0 }, End = new Point3 { X = minX, Y = maxY, Z = 0 } },
                new WallState { Id = baseId + 3, IsHostable = true, Start = new Point3 { X = minX, Y = maxY, Z = 0 }, End = new Point3 { X = minX, Y = minY, Z = 0 } }
            };
        }
    }
}

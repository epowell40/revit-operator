using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Candidates;
using RevitBridge.Common.LowVoltage.Core.Diagnostics;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Graphs;
using RevitBridge.Common.LowVoltage.Core.Placement;
using RevitBridge.Common.LowVoltage.Core.Rules;
using RevitBridge.Logic.LowVoltage.Skills.PowerOutlets;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class PowerOutletsRuleEngineTests
    {
        [Fact]
        public void PowerOutletsEngine_SelectsNearestValidWallCandidate()
        {
            var context = BuildContext(includeFamilyTypes: true);
            var result = new PowerOutletsRuleEngine().Evaluate(context);

            var action = Assert.Single(result.ProposedActions);
            Assert.Equal("dedicated_receptacle", action.DeviceCategory);
            Assert.Equal("endpoint_wall_host", action.Candidate.Strategy);
            Assert.Equal(10, action.HostElementId);
        }

        [Fact]
        public void PowerOutletsEngine_SuppressesDuplicates_ForClusteredEndpoints()
        {
            var context = BuildContext(includeFamilyTypes: true, includeClusteredEndpoint: true);
            var result = new PowerOutletsRuleEngine().Evaluate(context);

            Assert.Single(result.ProposedActions);
            Assert.Contains(context.Diagnostics.SkippedEndpoints, item => item.Reason == "clustered_with_existing_endpoint");
        }

        [Fact]
        public void PowerOutletsEngine_UsesRoomEntryFallback_WhenWallHostFails()
        {
            var context = BuildFallbackContext();
            var result = new PowerOutletsRuleEngine().Evaluate(context);

            var action = Assert.Single(result.ProposedActions);
            Assert.Equal("room_entry", action.Candidate.Strategy);
        }

        [Fact]
        public void PowerOutletsEngine_ReviewsUnknownEquipment_ForMappingExpansion()
        {
            var context = BuildContext(includeFamilyTypes: true, useUnknownEndpoint: true);
            var result = new PowerOutletsRuleEngine().Evaluate(context);

            Assert.Contains(context.Diagnostics.UnknownEndpointMappings, item => item.StartsWith("equipment:700:", System.StringComparison.OrdinalIgnoreCase));
            Assert.Contains(result.ManualReviews, review => review.Code == "unknown_power_endpoint");
        }

        [Fact]
        public void PowerOutletsEngine_IsDeterministic_ForSameInput()
        {
            var first = BuildContext(includeFamilyTypes: true, includeClusteredEndpoint: true);
            var second = BuildContext(includeFamilyTypes: true, includeClusteredEndpoint: true);

            var firstResult = new PowerOutletsRuleEngine().Evaluate(first);
            var secondResult = new PowerOutletsRuleEngine().Evaluate(second);

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
                    CreateRoom(1, "BREAKROOM 101", "staff_area", 0, 0, 10, 6)
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
                        Category = "Equipment",
                        FamilyName = "Breakroom Refrigerator",
                        TypeName = "Fridge",
                        SemanticType = "refrigerator",
                        Location = new Point3 { X = 2, Y = 3, Z = 0 }
                    }
                }
            };

            if (includeClusteredEndpoint)
            {
                state.Equipment.Add(new EquipmentState
                {
                    Id = 601,
                    Category = "Equipment",
                    FamilyName = "Breakroom Refrigerator",
                    TypeName = "Fridge",
                    SemanticType = "refrigerator",
                    Location = new Point3 { X = 2.8, Y = 3.1, Z = 0 }
                });
            }

            if (useUnknownEndpoint)
            {
                state.Equipment.Add(new EquipmentState
                {
                    Id = 700,
                    Category = "Equipment",
                    FamilyName = "Mystery Powered Cabinet",
                    TypeName = "Unknown Appliance",
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
                    Category = "Electrical Fixtures",
                    FamilyName = "Dedicated Power Receptacle",
                    TypeName = "Dedicated Duplex",
                    IsActive = true
                });
                state.FamilyTypes.Add(new FamilyTypeState
                {
                    Id = 801,
                    Category = "Electrical Fixtures",
                    FamilyName = "Duplex Receptacle",
                    TypeName = "Standard Duplex",
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
                Discipline = "power_outlets",
                State = state,
                Graph = graph,
                Candidates = candidates.OrderBy(candidate => candidate.Id).ToList(),
                DisciplineProfile = PowerOutletsProfile.CreateDefault(),
                Diagnostics = new DiagnosticReport()
            };
        }

        private static LayoutContext BuildFallbackContext()
        {
            var state = new ModelState
            {
                Rooms = new List<RoomState>
                {
                    CreateRoom(1, "BREAKROOM 101", "staff_area", 0, 0, 10, 6)
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
                        Category = "Equipment",
                        FamilyName = "Breakroom Refrigerator",
                        TypeName = "Fridge",
                        SemanticType = "refrigerator",
                        Location = new Point3 { X = 6.4, Y = 3.0, Z = 0 }
                    }
                },
                Walls = new List<WallState>
                {
                    new WallState { Id = 10, IsHostable = true, Start = new Point3 { X = 0, Y = 0, Z = 0 }, End = new Point3 { X = 0, Y = 6, Z = 0 } }
                },
                FamilyTypes = new List<FamilyTypeState>
                {
                    new FamilyTypeState
                    {
                        Id = 800,
                        Category = "Electrical Fixtures",
                        FamilyName = "Dedicated Power Receptacle",
                        TypeName = "Dedicated Duplex",
                        IsActive = true
                    }
                }
            };

            var graph = SpaceGraphBuilder.Build(state, tolerance: 0.1);
            var candidates = new List<CandidatePoint>();
            candidates.AddRange(CandidateGenerator.GenerateWallHostPoints(state.Walls, spacing: 6));
            candidates.AddRange(CandidateGenerator.GenerateRoomEntryPoints(state.Rooms, state.Openings));
            candidates.AddRange(CandidateGenerator.GenerateRoomCenteredPoints(state.Rooms));

            return new LayoutContext
            {
                Discipline = "power_outlets",
                State = state,
                Graph = graph,
                Candidates = candidates.OrderBy(candidate => candidate.Id).ToList(),
                DisciplineProfile = PowerOutletsProfile.CreateDefault(),
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

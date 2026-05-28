using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Candidates;
using RevitBridge.Common.LowVoltage.Core.Diagnostics;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Graphs;
using RevitBridge.Common.LowVoltage.Core.Placement;
using RevitBridge.Common.LowVoltage.Core.Rules;
using RevitBridge.Logic.LowVoltage.Skills.NurseCall;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class NurseCallRuleEngineTests
    {
        [Fact]
        public void NurseCallEngine_ClassifiesRooms_AndDetectsAnchors()
        {
            var context = BuildContext(includeFamilyTypes: true);
            var result = new NurseCallRuleEngine().Evaluate(context);

            Assert.Contains(context.Diagnostics.ClassifiedSpaces, item => item.RoomId == 1 && item.Bucket == "patient_room");
            Assert.Contains(context.Diagnostics.ClassifiedSpaces, item => item.RoomId == 2 && item.Bucket == "patient_toilet");
            Assert.Contains(context.Diagnostics.ClassifiedSpaces, item => item.RoomId == 3 && item.Bucket == "shower_room");
            Assert.Contains(context.Diagnostics.ClassifiedSpaces, item => item.RoomId == 4 && item.Bucket == "nurse_station");
            Assert.Contains(context.Diagnostics.AnchorsUsed, item => item.AnchorKind == "bed" && item.RoomId == 1);
            Assert.Contains(context.Diagnostics.AnchorsUsed, item => item.AnchorKind == "toilet" && item.RoomId == 2);
            Assert.Contains(context.Diagnostics.AnchorsUsed, item => item.AnchorKind == "shower" && item.RoomId == 3);
            Assert.Contains(result.ProposedActions, action => action.DeviceCategory == "patient_station");
            Assert.Contains(result.ProposedActions, action => action.DeviceCategory == "toilet_pull");
            Assert.Contains(result.ProposedActions, action => action.DeviceCategory == "shower_pull");
        }

        [Fact]
        public void NurseCallEngine_UsesAnchorRelativeWallCandidates()
        {
            var context = BuildContext(includeFamilyTypes: true);
            var result = new NurseCallRuleEngine().Evaluate(context);

            var toiletAction = Assert.Single(result.ProposedActions, action => action.DeviceCategory == "toilet_pull");
            var showerAction = Assert.Single(result.ProposedActions, action => action.DeviceCategory == "shower_pull");

            Assert.Equal("anchor_wall_host", toiletAction.Candidate.Strategy);
            Assert.Equal("anchor_wall_host", showerAction.Candidate.Strategy);
            Assert.Equal("wall", toiletAction.HostPreference);
            Assert.Equal("wall", showerAction.HostPreference);
        }

        [Fact]
        public void NurseCallEngine_ReportsMissingFamilies_AndLeavesActionsUnapproved()
        {
            var context = BuildContext(includeFamilyTypes: false);
            var result = new NurseCallRuleEngine().Evaluate(context);

            Assert.NotEmpty(context.Diagnostics.MissingFamilyTypes);
            Assert.Contains(result.ProposedActions, action => !action.Approved);
            Assert.Contains(result.ManualReviews, review => review.Code == "missing_family_symbol");
        }

        [Fact]
        public void NurseCallEngine_FlagsManualReview_WhenAnchorHasNoValidHost()
        {
            var context = BuildHostAmbiguityContext();
            var result = new NurseCallRuleEngine().Evaluate(context);

            Assert.Contains(result.ManualReviews, review => review.RoomId == 2 && review.Code == "host_ambiguity");
            Assert.DoesNotContain(result.ProposedActions, action => action.RoomId == 2 && action.DeviceCategory == "toilet_pull");
        }

        [Fact]
        public void NurseCallEngine_LogsUnknownFixtures_AndFlagsMissingAnchor()
        {
            var context = BuildContext(includeFamilyTypes: true, useUnknownToiletFixture: true);
            var result = new NurseCallRuleEngine().Evaluate(context);

            Assert.Contains(context.Diagnostics.UnknownFixtureMappings, item => item.StartsWith("fixture:700:unknown", System.StringComparison.OrdinalIgnoreCase));
            Assert.Contains(result.ManualReviews, review => review.RoomId == 2 && review.Code == "missing_anchor");
        }

        [Fact]
        public void NurseCallEngine_IsDeterministic_ForSameInput()
        {
            var first = BuildContext(includeFamilyTypes: true);
            var second = BuildContext(includeFamilyTypes: true);

            var firstResult = new NurseCallRuleEngine().Evaluate(first);
            var secondResult = new NurseCallRuleEngine().Evaluate(second);

            var firstActions = firstResult.ProposedActions.Select(action => action.ActionId + "|" + action.Candidate.Id).ToList();
            var secondActions = secondResult.ProposedActions.Select(action => action.ActionId + "|" + action.Candidate.Id).ToList();

            Assert.Equal(firstActions, secondActions);
        }

        private static LayoutContext BuildContext(
            bool includeFamilyTypes,
            bool includeToiletWalls = true,
            bool includeToiletOpening = true,
            bool useUnknownToiletFixture = false)
        {
            var state = new ModelState
            {
                Rooms = new List<RoomState>
                {
                    CreateRoom(1, "PAT RM 101", "patient_room", 0, 0, 12, 12),
                    CreateRoom(2, "TOILET 101A", "toilet_room", 12, 0, 18, 8),
                    CreateRoom(3, "SHWR 101B", "shower", 18, 0, 24, 8),
                    CreateRoom(4, "NURSE STATION", "nurse_station", 0, 12, 12, 20)
                },
                Openings = new List<OpeningState>
                {
                    new OpeningState { Id = 10, HostWallId = 100, Location = new Point3 { X = 0, Y = 6, Z = 0 } },
                    new OpeningState { Id = 30, HostWallId = 300, Location = new Point3 { X = 18, Y = 4, Z = 0 } },
                    new OpeningState { Id = 40, HostWallId = 400, Location = new Point3 { X = 0, Y = 16, Z = 0 } }
                },
                Equipment = new List<EquipmentState>
                {
                    new EquipmentState { Id = 600, FamilyName = "Patient Bed", TypeName = "Headwall Bed", SemanticType = "bed_placeholder", Location = new Point3 { X = 6, Y = 6, Z = 0 } },
                    new EquipmentState { Id = 601, FamilyName = "Nurse Console", TypeName = "Staff Console", SemanticType = "nurse_console", Location = new Point3 { X = 6, Y = 16, Z = 0 } }
                },
                Fixtures = new List<FixtureState>
                {
                    new FixtureState
                    {
                        Id = useUnknownToiletFixture ? 700 : 500,
                        FamilyName = useUnknownToiletFixture ? "Mystery Fixture" : "Patient Toilet",
                        TypeName = useUnknownToiletFixture ? "Unknown Fixture" : "ADA Toilet",
                        SemanticType = useUnknownToiletFixture ? "unknown" : "toilet",
                        Location = new Point3 { X = 15, Y = 4, Z = 0 }
                    },
                    new FixtureState { Id = 501, FamilyName = "Shower", TypeName = "Accessible Shower", SemanticType = "shower_fixture", Location = new Point3 { X = 21, Y = 4, Z = 0 } }
                }
            };

            state.Walls.AddRange(CreatePerimeterWalls(100, 0, 0, 12, 12));
            if (includeToiletWalls)
            {
                state.Walls.AddRange(CreatePerimeterWalls(200, 12, 0, 18, 8));
            }
            state.Walls.AddRange(CreatePerimeterWalls(300, 18, 0, 24, 8));
            state.Walls.AddRange(CreatePerimeterWalls(400, 0, 12, 12, 20));

            if (includeToiletOpening)
            {
                state.Openings.Add(new OpeningState { Id = 20, HostWallId = 200, Location = new Point3 { X = 12, Y = 4, Z = 0 } });
            }

            if (includeFamilyTypes)
            {
                state.FamilyTypes.Add(new FamilyTypeState { Id = 800, Category = "Communication Devices", FamilyName = "Nurse Call Patient Station", TypeName = "Patient Station", IsActive = true });
                state.FamilyTypes.Add(new FamilyTypeState { Id = 801, Category = "Communication Devices", FamilyName = "Nurse Call Toilet Pull", TypeName = "Toilet Pull", IsActive = true });
                state.FamilyTypes.Add(new FamilyTypeState { Id = 802, Category = "Communication Devices", FamilyName = "Nurse Call Shower Pull", TypeName = "Shower Pull", IsActive = true });
                state.FamilyTypes.Add(new FamilyTypeState { Id = 803, Category = "Communication Devices", FamilyName = "Nurse Call Staff Console", TypeName = "Staff Console", IsActive = true });
            }

            var graph = SpaceGraphBuilder.Build(state, tolerance: 0.1);
            var candidates = new List<CandidatePoint>();
            candidates.AddRange(CandidateGenerator.GenerateWallHostPoints(state.Walls, spacing: 6));
            candidates.AddRange(CandidateGenerator.GenerateCeilingHostPoints(state.Ceilings));
            candidates.AddRange(CandidateGenerator.GenerateRoomCenteredPoints(state.Rooms));
            candidates.AddRange(CandidateGenerator.GenerateRoomEntryPoints(state.Rooms, state.Openings));

            return new LayoutContext
            {
                Discipline = "nurse_call",
                State = state,
                Graph = graph,
                Candidates = candidates.OrderBy(candidate => candidate.Id).ToList(),
                DisciplineProfile = NurseCallProfile.CreateDefault(),
                Diagnostics = new DiagnosticReport()
            };
        }

        private static LayoutContext BuildHostAmbiguityContext()
        {
            var state = new ModelState
            {
                Rooms = new List<RoomState>
                {
                    CreateRoom(1, "PAT RM 101", "patient_room", 0, 0, 12, 12),
                    CreateRoom(2, "TOILET 101A", "toilet_room", 40, 0, 46, 8)
                },
                Walls = new List<WallState>()
            };

            state.Equipment.Add(new EquipmentState { Id = 600, FamilyName = "Patient Bed", TypeName = "Headwall Bed", SemanticType = "bed_placeholder", Location = new Point3 { X = 6, Y = 6, Z = 0 } });
            state.Fixtures.Add(new FixtureState { Id = 500, FamilyName = "Patient Toilet", TypeName = "ADA Toilet", SemanticType = "toilet", Location = new Point3 { X = 43, Y = 4, Z = 0 } });
            state.Openings.Add(new OpeningState { Id = 10, HostWallId = 100, Location = new Point3 { X = 0, Y = 6, Z = 0 } });
            state.Walls.AddRange(CreatePerimeterWalls(100, 0, 0, 12, 12));
            state.FamilyTypes.Add(new FamilyTypeState { Id = 801, Category = "Communication Devices", FamilyName = "Nurse Call Toilet Pull", TypeName = "Toilet Pull", IsActive = true });

            var graph = SpaceGraphBuilder.Build(state, tolerance: 0.1);
            var candidates = new List<CandidatePoint>();
            candidates.AddRange(CandidateGenerator.GenerateWallHostPoints(state.Walls, spacing: 6));
            candidates.AddRange(CandidateGenerator.GenerateRoomCenteredPoints(state.Rooms));
            candidates.AddRange(CandidateGenerator.GenerateRoomEntryPoints(state.Rooms, state.Openings));

            return new LayoutContext
            {
                Discipline = "nurse_call",
                State = state,
                Graph = graph,
                Candidates = candidates.OrderBy(candidate => candidate.Id).ToList(),
                DisciplineProfile = NurseCallProfile.CreateDefault(),
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

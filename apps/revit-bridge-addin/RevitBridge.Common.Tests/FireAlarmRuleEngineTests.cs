using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Candidates;
using RevitBridge.Common.LowVoltage.Core.Diagnostics;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Graphs;
using RevitBridge.Common.LowVoltage.Core.Placement;
using RevitBridge.Common.LowVoltage.Core.Rules;
using RevitBridge.Logic.LowVoltage.Skills.FireAlarm;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class FireAlarmRuleEngineTests
    {
        [Fact]
        public void FireAlarmEngine_ClassifiesRooms_AndFlagsUnknowns()
        {
            var context = BuildContext(includeFamilyTypes: true);
            var result = new FireAlarmRuleEngine().Evaluate(context);

            Assert.Contains(context.Diagnostics.ClassifiedSpaces, item => item.RoomId == 1 && item.Bucket == "corridor");
            Assert.Contains(context.Diagnostics.ClassifiedSpaces, item => item.RoomId == 2 && item.Bucket == "patient_room");
            Assert.Contains(result.ManualReviews, item => item.RoomId == 4 && item.Code == "unknown_room_type");
        }

        [Fact]
        public void FireAlarmEngine_HandlesMissingFamilies_WithManualReview()
        {
            var context = BuildContext(includeFamilyTypes: false);
            var result = new FireAlarmRuleEngine().Evaluate(context);

            Assert.NotEmpty(context.Diagnostics.MissingFamilyTypes);
            Assert.Contains(result.ProposedActions, action => !action.Approved);
        }

        [Fact]
        public void FireAlarmEngine_IsDeterministic_ForSameInput()
        {
            var first = BuildContext(includeFamilyTypes: true);
            var second = BuildContext(includeFamilyTypes: true);

            var firstResult = new FireAlarmRuleEngine().Evaluate(first);
            var secondResult = new FireAlarmRuleEngine().Evaluate(second);

            var firstActions = firstResult.ProposedActions.Select(action => action.ActionId + "|" + action.Candidate.Id).ToList();
            var secondActions = secondResult.ProposedActions.Select(action => action.ActionId + "|" + action.Candidate.Id).ToList();

            Assert.Equal(firstActions, secondActions);
        }

        private static LayoutContext BuildContext(bool includeFamilyTypes)
        {
            var state = new ModelState
            {
                Rooms = new List<RoomState>
                {
                    new RoomState
                    {
                        Id = 1,
                        Name = "CORR A",
                        SemanticType = "corridor",
                        Area = 300,
                        BoundaryPolygon = new List<Point3>
                        {
                            new Point3 { X = 0, Y = 0 },
                            new Point3 { X = 30, Y = 0 },
                            new Point3 { X = 30, Y = 6 },
                            new Point3 { X = 0, Y = 6 }
                        }
                    },
                    new RoomState
                    {
                        Id = 2,
                        Name = "PAT RM 101",
                        SemanticType = "patient_room",
                        Area = 180,
                        BoundaryPolygon = new List<Point3>
                        {
                            new Point3 { X = 30, Y = 0 },
                            new Point3 { X = 42, Y = 0 },
                            new Point3 { X = 42, Y = 12 },
                            new Point3 { X = 30, Y = 12 }
                        }
                    },
                    new RoomState
                    {
                        Id = 3,
                        Name = "WAITING",
                        SemanticType = "waiting",
                        Area = 220,
                        BoundaryPolygon = new List<Point3>
                        {
                            new Point3 { X = 30, Y = 12 },
                            new Point3 { X = 48, Y = 12 },
                            new Point3 { X = 48, Y = 24 },
                            new Point3 { X = 30, Y = 24 }
                        }
                    },
                    new RoomState
                    {
                        Id = 4,
                        Name = "MYSTERY",
                        SemanticType = "unknown",
                        Area = 90,
                        BoundaryPolygon = new List<Point3>
                        {
                            new Point3 { X = 0, Y = 6 },
                            new Point3 { X = 10, Y = 6 },
                            new Point3 { X = 10, Y = 14 },
                            new Point3 { X = 0, Y = 14 }
                        }
                    }
                },
                Openings = new List<OpeningState>
                {
                    new OpeningState { Id = 10, HostWallId = 100, Location = new Point3 { X = 30, Y = 3, Z = 0 } },
                    new OpeningState { Id = 11, HostWallId = 101, Location = new Point3 { X = 30, Y = 18, Z = 0 } }
                },
                Walls = new List<WallState>
                {
                    new WallState { Id = 100, IsHostable = true, Start = new Point3 { X = 30, Y = 0 }, End = new Point3 { X = 30, Y = 12 } },
                    new WallState { Id = 101, IsHostable = true, Start = new Point3 { X = 30, Y = 12 }, End = new Point3 { X = 30, Y = 24 } }
                },
                Ceilings = new List<CeilingState>
                {
                    new CeilingState { Id = 200, Elevation = 9, Bounds = new BoundingBox2D { MinX = 30, MinY = 12, MaxX = 48, MaxY = 24 } },
                    new CeilingState { Id = 201, Elevation = 9, Bounds = new BoundingBox2D { MinX = 0, MinY = 0, MaxX = 30, MaxY = 6 } }
                }
            };

            if (includeFamilyTypes)
            {
                state.FamilyTypes.Add(new FamilyTypeState { Id = 500, Category = "Fire Alarm Devices", FamilyName = "Fire Alarm Strobe", TypeName = "Ceiling Strobe", IsActive = true });
            }

            var graph = SpaceGraphBuilder.Build(state, tolerance: 0.1);
            var candidates = new List<CandidatePoint>();
            candidates.AddRange(CandidateGenerator.GenerateWallHostPoints(state.Walls, spacing: 6));
            candidates.AddRange(CandidateGenerator.GenerateCeilingHostPoints(state.Ceilings));
            candidates.AddRange(CandidateGenerator.GenerateRoomCenteredPoints(state.Rooms));
            candidates.AddRange(CandidateGenerator.GenerateRoomEntryPoints(state.Rooms, state.Openings));
            candidates.AddRange(CandidateGenerator.GenerateCorridorCenterlinePoints(state.Rooms, spacing: 12, endOffset: 6));
            candidates.AddRange(CandidateGenerator.GenerateCorridorEndOffsetPoints(state.Rooms, endOffset: 6));

            return new LayoutContext
            {
                Discipline = "fire_alarm",
                State = state,
                Graph = graph,
                Candidates = candidates.OrderBy(candidate => candidate.Id).ToList(),
                DisciplineProfile = FireAlarmProfile.CreateDefault(),
                Diagnostics = new DiagnosticReport()
            };
        }
    }
}

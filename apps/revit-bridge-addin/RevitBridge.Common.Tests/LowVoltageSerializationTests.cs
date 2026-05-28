using System.Text.Json;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Placement;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class LowVoltageSerializationTests
    {
        [Fact]
        public void PlacementAction_Serializes_And_Deserializes()
        {
            var action = new PlacementAction
            {
                ActionId = "a1",
                ActionType = "place_family_instance",
                Discipline = "data_outlets",
                DeviceCategory = "data_outlet",
                DeviceType = "data_outlet",
                Approved = true,
                Candidate = new CandidatePoint { Id = "c1", Location = new Point3 { X = 1, Y = 2, Z = 3 } }
            };

            var json = JsonSerializer.Serialize(action);
            var roundTrip = JsonSerializer.Deserialize<PlacementAction>(json);

            Assert.NotNull(roundTrip);
            Assert.Equal("a1", roundTrip!.ActionId);
            Assert.Equal(1, roundTrip.Candidate.Location.X);
        }
    }
}

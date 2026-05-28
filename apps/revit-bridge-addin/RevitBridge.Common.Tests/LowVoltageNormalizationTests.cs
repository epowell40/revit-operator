using System.Collections.Generic;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Normalization;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class LowVoltageNormalizationTests
    {
        [Fact]
        public void Normalization_Maps_Room_Aliases()
        {
            var state = new ModelState
            {
                Rooms = new List<RoomState>
                {
                    new RoomState { Id = 1, Name = "PAT RM 101" },
                    new RoomState { Id = 2, Name = "CORR B" }
                }
            };

            var profile = new NormalizationProfile
            {
                RoomMappings = new Dictionary<string, List<string>>
                {
                    ["patient_room"] = new List<string> { "PAT RM", "PATIENT ROOM" },
                    ["corridor"] = new List<string> { "CORR", "HALL" }
                }
            };

            NormalizationEngine.Normalize(state, profile);

            Assert.Equal("patient_room", state.Rooms[0].SemanticType);
            Assert.Equal("corridor", state.Rooms[1].SemanticType);
        }

        [Fact]
        public void Normalization_Maps_DataEndpoint_Equipment_Aliases()
        {
            var state = new ModelState
            {
                Equipment = new List<EquipmentState>
                {
                    new EquipmentState { Id = 1, FamilyName = "Dell Computer", TypeName = "Workstation" },
                    new EquipmentState { Id = 2, FamilyName = "HP Printer", TypeName = "LaserJet" }
                }
            };

            var profile = new NormalizationProfile
            {
                EquipmentMappings = new Dictionary<string, List<string>>
                {
                    ["workstation_computer"] = new List<string> { "COMPUTER", "WORKSTATION" },
                    ["printer"] = new List<string> { "PRINTER", "LASERJET" }
                }
            };

            NormalizationEngine.Normalize(state, profile);

            Assert.Equal("workstation_computer", state.Equipment[0].SemanticType);
            Assert.Equal("printer", state.Equipment[1].SemanticType);
        }

        [Fact]
        public void Normalization_Maps_PowerEndpoint_Equipment_Aliases()
        {
            var state = new ModelState
            {
                Equipment = new List<EquipmentState>
                {
                    new EquipmentState { Id = 1, FamilyName = "Breakroom Refrigerator", TypeName = "Fridge" },
                    new EquipmentState { Id = 2, FamilyName = "Counter Microwave", TypeName = "Microwave Oven" }
                }
            };

            var profile = new NormalizationProfile
            {
                EquipmentMappings = new Dictionary<string, List<string>>
                {
                    ["refrigerator"] = new List<string> { "REFRIGERATOR", "FRIDGE" },
                    ["microwave"] = new List<string> { "MICROWAVE" }
                }
            };

            NormalizationEngine.Normalize(state, profile);

            Assert.Equal("refrigerator", state.Equipment[0].SemanticType);
            Assert.Equal("microwave", state.Equipment[1].SemanticType);
        }
    }
}

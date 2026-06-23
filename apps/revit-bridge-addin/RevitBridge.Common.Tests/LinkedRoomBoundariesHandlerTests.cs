using System.Text.Json;
using RevitBridge.Logic.Handlers;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class LinkedRoomBoundariesHandlerTests
    {
        [Fact]
        public void Request_Defaults_To_Include_Boundary_Metadata()
        {
            var request = JsonSerializer.Deserialize<LinkedRoomBoundariesHandler.Request>(
                "{\"levelName\":\"LEVEL 03\",\"linkedModelNameContains\":\"Pineville\"}",
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            Assert.NotNull(request);
            Assert.Equal("LEVEL 03", request!.levelName);
            Assert.Equal("Pineville", request.linkedModelNameContains);
            Assert.True(request.includeBoundarySegmentMetadata);
        }

        [Fact]
        public void Request_Allows_Metadata_To_Be_Disabled_For_Small_Payloads()
        {
            var request = JsonSerializer.Deserialize<LinkedRoomBoundariesHandler.Request>(
                "{\"includeBoundarySegmentMetadata\":false,\"maxRooms\":12}",
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            Assert.NotNull(request);
            Assert.False(request!.includeBoundarySegmentMetadata);
            Assert.Equal(12, request.maxRooms);
        }
    }
}

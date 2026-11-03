using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryInspectionPolicyTests
    {
        private static bool Valid(string json)
        {
            using var document = JsonDocument.Parse(json);
            return DuctVerificationInspectionPolicy.TryValidate(document.RootElement, out _);
        }
        [Fact] public void LegacyConnectorReadsRemainUnchanged()
        {
            Assert.True(Valid("{\"elementIds\":[1]}"));
            Assert.True(Valid("{\"elementIds\":[1],\"includeInlineAccessoryState\":false}"));
        }
        [Fact] public void CompleteBoundedCombinedReadIsAdmitted()
            => Assert.True(Valid("{\"elementIds\":[1,2,3,4,5],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[6,7]}"));
        [Theory]
        [InlineData("{\"elementIds\":[1],\"preservationScheduleIds\":[]}")]
        [InlineData("{\"elementIds\":[1],\"includeInlineAccessoryState\":true}")]
        [InlineData("{\"elementIds\":[1],\"includeInlineAccessoryState\":\"true\",\"preservationScheduleIds\":[]}")]
        [InlineData("{\"elementIds\":[1,1],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[]}")]
        [InlineData("{\"elementIds\":[1,2,3,4,5,6],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[]}")]
        [InlineData("{\"elementIds\":[1],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[1]}")]
        [InlineData("{\"elementIds\":[null],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[]}")]
        [InlineData("{\"elementIds\":[1],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[],\"onlyOpenPhysicalConnectors\":true}")]
        [InlineData("{\"elementIds\":[1],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[],\"includeCoordinateSystem\":false}")]
        [InlineData("{\"elementIds\":[1],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[],\"includeAllRefs\":false}")]
        [InlineData("{\"elementIds\":[1],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[],\"includeFlexGeometry\":false}")]
        public void IncompleteOrAmbiguousScopesReject(string json) => Assert.False(Valid(json));
    }
}

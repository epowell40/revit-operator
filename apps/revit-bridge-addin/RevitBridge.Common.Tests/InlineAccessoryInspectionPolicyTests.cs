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
        [Theory]
        [InlineData("{\"elementIds\":[1,2,3,4,5],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[6,7]}")]
        [InlineData("{\"elementIds\":[1,2,3,4,5],\"includeInlineAccessoryState\":true,\"preservationScheduleIds\":[]}")]
        public void CompleteBoundedCombinedReadIsAdmitted(string json) => Assert.True(Valid(json));
        [Theory]
        [InlineData("{\"elementIds\":[1,2,3,4,5],\"includeVerificationParameters\":true,\"includeInlineAccessoryState\":true}", false)]
        [InlineData("{\"elementIds\":[1,2,3,4,5,6,7,8],\"includeVerificationParameters\":true,\"includeInlineAccessoryState\":true}", true)]
        public void InlineReadNamesAllInvalidFieldsBeforeDispatch(string json, bool invalidOwners)
        {
            using var document = JsonDocument.Parse(json);
            Assert.False(DuctVerificationInspectionPolicy.TryValidate(document.RootElement, out var error));
            Assert.Contains("preservationScheduleIds", error);
            Assert.Contains("[]", error);
            Assert.Equal(invalidOwners, error.Contains("elementIds"));
        }
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

using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorRetiredPrototypeToolTests
    {
        [Theory]
        [InlineData("/revit/create-zones")]
        [InlineData("/revit/create-zone-visuals")]
        public void RetiredZoningPrototypeCannotPassNativeAllowlist(string path)
        {
            Assert.False(OperatorActionAllowlist.IsAllowed("POST", path));
        }

        [Theory]
        [InlineData("/revit/get-parameters")]
        [InlineData("/revit/get-connectors")]
        [InlineData("/revit/create-view")]
        [InlineData("/revit/place-families")]
        public void GeneralPrimitiveNeighborsRemainAdmitted(string path)
        {
            Assert.True(OperatorActionAllowlist.IsAllowed("POST", path));
        }
    }
}

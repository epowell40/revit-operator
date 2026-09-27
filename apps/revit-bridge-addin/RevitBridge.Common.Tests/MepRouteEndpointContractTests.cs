using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepRouteEndpointContractTests
    {
        [Theory]
        [InlineData("start", null, null, true, false)]
        [InlineData("end", null, null, true, false)]
        [InlineData("both", 42L, null, true, false)]
        [InlineData("start", 42L, null, false, false)]
        [InlineData("unknown", 42L, null, true, false)]
        [InlineData("start", 42L, null, true, true, true)]
        [InlineData("end", null, 43L, true, true, true)]
        [InlineData("start", null, 43L, true, true, false)]
        [InlineData("start", 42L, null, true, false, true)]
        [InlineData("end", null, 43L, true, false, true)]
        [InlineData("both", 42L, 43L, true, true, true)]
        public void ExactExistingOwnerContract(string requiredEndpoint, long? startOwner, long? endOwner, bool connect, bool legacyBoth, bool expectedValid = false)
        {
            Assert.Equal(expectedValid, MepRouteEndpointContract.TryResolve(connect, legacyBoth, requiredEndpoint,
                startOwner, endOwner, out var normalized));
            Assert.Equal(requiredEndpoint, normalized);
        }

        [Fact]
        public void LegacyOptionalAndRequiredBothRemainCompatible()
        {
            Assert.True(MepRouteEndpointContract.TryResolve(true, false, null, null, null, out var optional));
            Assert.Equal("", optional);
            Assert.True(MepRouteEndpointContract.TryResolve(true, true, null, null, null, out var both));
            Assert.Equal("", both);
        }
    }
}

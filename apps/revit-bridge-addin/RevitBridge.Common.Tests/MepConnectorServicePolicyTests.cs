using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepConnectorServicePolicyTests
    {
        [Theory]
        [InlineData("SupplyAir", "Supply Air", true)]
        [InlineData("ExhaustAir", "SupplyAir", false)]
        [InlineData("Exhaust Air", "SupplyAir", false)]
        [InlineData("ReturnAir", "SupplyAir", false)]
        [InlineData("SupplyAir", "UndefinedSystemType", true)]
        [InlineData("", "ExhaustAir", true)]
        public void KnownServiceMismatchCannotConnect(string source, string target, bool expected)
        {
            Assert.Equal(expected, MepConnectorServicePolicy.AreCompatible(source, target));
        }
    }
}

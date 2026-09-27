using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepSystemTypeNamePolicyTests
    {
        [Fact]
        public void ReturnAirAliasSelectsReturnAirInsteadOfFirstSupplySystem()
        {
            var names = new[] { "Supply Air", "Return Air", "Exhaust Air" };
            Assert.Equal("Return Air", MepSystemTypeNamePolicy.SelectExplicitName("ReturnAir", names));
            Assert.Equal("Return Air", MepSystemTypeNamePolicy.SelectExplicitName("Return Air", names));
            Assert.Null(MepSystemTypeNamePolicy.SelectExplicitName("Unknown Service", names));
            Assert.Equal("Supply Air", MepSystemTypeNamePolicy.SelectExplicitName(null, names));
        }
    }
}

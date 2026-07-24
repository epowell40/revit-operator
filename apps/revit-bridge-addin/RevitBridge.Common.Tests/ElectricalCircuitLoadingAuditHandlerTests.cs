using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class ElectricalCircuitLoadingAuditHandlerTests
    {
        [Fact]
        public void WireSizeProfileMatchIgnoresOnlyCaseAndWhitespace()
        {
            Assert.True(ElectricalWireSizeProfilePolicy.Matches(
                "1-#12, 1-#12, 1-#12",
                " 1-#12,1-#12,1-#12 "));
        }

        [Fact]
        public void WireSizeProfileMatchRejectsSubstringTokens()
        {
            Assert.False(ElectricalWireSizeProfilePolicy.Matches("#12", "#1"));
            Assert.False(ElectricalWireSizeProfilePolicy.Matches("1-#12, 1-#12", "#12"));
        }

        [Fact]
        public void WireSizeProfileMatchRejectsEmptyTokens()
        {
            Assert.False(ElectricalWireSizeProfilePolicy.Matches("#12", ""));
            Assert.False(ElectricalWireSizeProfilePolicy.Matches("", "#12"));
        }
    }
}

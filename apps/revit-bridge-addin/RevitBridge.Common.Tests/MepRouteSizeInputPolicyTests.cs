using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepRouteSizeInputPolicyTests
    {
        [Fact]
        public void ResolveDuctSizeAcceptsAdvertisedDiameterAlias()
        {
            Assert.Equal("8\"", MepRouteSizeInputPolicy.ResolveDuctSize(null, " 8\" "));
        }

        [Fact]
        public void ResolveDuctSizePrefersExplicitDuctSize()
        {
            Assert.Equal("10x8", MepRouteSizeInputPolicy.ResolveDuctSize(" 10x8 ", "8\""));
        }

        [Fact]
        public void ResolveDuctSizeReturnsEmptyWhenNoExplicitSizeExists()
        {
            Assert.Equal(string.Empty, MepRouteSizeInputPolicy.ResolveDuctSize(" ", null));
        }
    }
}

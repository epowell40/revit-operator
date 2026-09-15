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

        [Fact]
        public void SingleDuctAdapterPreservesSizeAliasesAndRejectsPartialDimensions()
        {
            Assert.Equal("12x10", MepRouteSizeInputPolicy.ResolveSingleDuctSize(null, "12", "10", null));
            Assert.Equal("8", MepRouteSizeInputPolicy.ResolveSingleDuctSize(null, null, null, "8"));
            Assert.Equal("12x10", MepRouteSizeInputPolicy.ResolveSingleDuctSize("12x10", "8", "8", "6"));
            Assert.Throws<System.ArgumentException>(() => MepRouteSizeInputPolicy.ResolveSingleDuctSize(null, "12", null, null));
            Assert.Throws<System.ArgumentException>(() => MepRouteSizeInputPolicy.ResolveSingleDuctSize(null, "12", "10", "8"));
            Assert.Equal(string.Empty, MepRouteSizeInputPolicy.ResolveSingleDuctSize(null, null, null, null));
        }
    }
}

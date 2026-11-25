using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorBrowserCompatibilityTests
    {
        [Theory]
        [InlineData("2023")]
        [InlineData("2024")]
        [InlineData("2025")]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("Revit 2024")]
        public void CefOrUnknownHostsKeepTheBrowserOutOfTheRevitProcess(string? version)
            => Assert.False(OperatorBrowserCompatibility.SupportsEmbeddedBrowser(version));

        [Theory]
        [InlineData("2026")]
        [InlineData("2027")]
        public void NewerHostsRetainTheirConfiguredInterfaceChoice(string version)
            => Assert.True(OperatorBrowserCompatibility.SupportsEmbeddedBrowser(version));
    }
}

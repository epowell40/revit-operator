using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class HostedPlacementPreflightTests
    {
        [Theory]
        [InlineData("OneLevelBased")]
        [InlineData("WorkPlaneBased")]
        [InlineData("OneLevelBasedHosted")]
        public void MissingHostHasExplicitNoTransactionAuthority(string placementType)
        {
            var result = HostedPlacementPreflight.CheckHost(false, placementType, 1464223, null)!;
            Assert.Equal(false, result["success"]);
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal("not_started", receipt.Status);
            Assert.Equal(false, receipt.CommittedValue);
            Assert.Empty(receipt.AffectedElementIds);
            Assert.Equal(placementType == "OneLevelBased",
                ((string)result["correction"]!).Contains("/revit/create-family-instance"));
        }

        [Fact]
        public void ResolvedHostContinuesWithoutInventingAnOutcome()
        {
            Assert.Null(HostedPlacementPreflight.CheckHost(true, "WorkPlaneBased", 1464223, 42));
        }

        [Fact]
        public void InvalidExplicitHostIsRetainedForCorrection()
        {
            var result = HostedPlacementPreflight.CheckHost(false, "OneLevelBasedHosted", 1464223, 999)!;
            Assert.Equal(999L, result["requestedHostElementId"]);
            Assert.Contains("compatible host", (string)result["correction"]!);
        }
    }
}

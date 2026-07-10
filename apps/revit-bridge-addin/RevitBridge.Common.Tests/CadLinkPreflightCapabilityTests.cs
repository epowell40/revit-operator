using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class CadLinkPreflightCapabilityTests
    {
        [Fact]
        public void CreateResponse_AdvertisesOwnerViewSheetPlacementWithoutSourcePath()
        {
            var response = CadLinkPreflightCapability.CreateResponse();

            Assert.Equal("Dry Run", response.status);
            Assert.True(response.dryRun);
            Assert.True(response.preflightOnly);
            Assert.Equal("view_then_sheet", response.targetMode);
            Assert.True(response.supportsOwnerViewSheetPlacement);
            Assert.True(response.supportsCadCategories);
            Assert.True(response.supportsCustomScale);
            Assert.True(response.supportsImportUnit);
        }

        [Fact]
        public void CreateResponse_RequiresStrongApplyEvidence()
        {
            var evidence = CadLinkPreflightCapability.CreateResponse().requiredApplyEvidence;

            Assert.Contains("elementId", evidence);
            Assert.Contains("ownerViewId", evidence);
            Assert.Contains("sheetViewId", evidence);
            Assert.Contains("viewportId", evidence);
            Assert.Contains("viewportBox", evidence);
            Assert.Contains("elementBoundingBoxInOwnerView", evidence);
            Assert.Contains("cadCategories", evidence);
            Assert.Equal(evidence.Length, evidence.Distinct().Count());
        }
    }
}

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
            Assert.False(response.previewExecuted);
            Assert.Equal("not_started", response.transaction.Status);
            Assert.False(response.transaction.CommittedValue);
            Assert.Empty(response.transaction.AffectedElementIds);
            Assert.Equal("view_then_sheet", response.targetMode);
            Assert.True(response.supportsOwnerViewSheetPlacement);
            Assert.True(response.supportsCadCategories);
            Assert.True(response.supportsCustomScale);
            Assert.True(response.supportsImportUnit);
            Assert.Equal("preserve", response.defaultColorMode);
            Assert.Equal(new[] { "preserve", "black_and_white", "invert" }, response.colorModes);
            Assert.False(response.fallsBackFromLinkToImport);
        }

        [Fact]
        public void CapabilityProbeIsKnownNoEffectButDoesNotClaimExecutedPreview()
        {
            var response = CadLinkPreflightCapability.CreateResponse();
            var settled = OperatorAttemptSuccessfulSettlement.Classify(response, "preview", "POST", "/revit/link-cad");
            Assert.Equal("none", settled.EffectState);
            Assert.Equal("native_transaction_not_started", settled.EffectReason);
            Assert.Equal("native_transaction", settled.EffectAuthority);
            Assert.False(response.previewExecuted);
        }

        [Fact]
        public void CreateResponse_RequiresStrongApplyEvidence()
        {
            var evidence = CadLinkPreflightCapability.CreateResponse().requiredApplyEvidence;

            Assert.Contains("elementId", evidence);
            Assert.Contains("elementUniqueId", evidence);
            Assert.Contains("isLinked", evidence);
            Assert.Contains("colorMode", evidence);
            Assert.Contains("totalTransformScale", evidence);
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

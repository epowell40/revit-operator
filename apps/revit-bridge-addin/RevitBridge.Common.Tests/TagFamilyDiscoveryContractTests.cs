using System.Linq;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TagFamilyDiscoveryContractTests
    {
        [Fact]
        public void ExternalInspectionIsDiscoverableWithoutOpeningAnEditableSession()
        {
            var tool = OperatorToolManifest.Tools.Single(x => x.Path == "/revit/inspect-family-content");
            Assert.Contains("filePath", tool.Description);
            Assert.Contains("workspace", tool.Description);
            Assert.Contains("specTypeId", tool.Description);
            Assert.Contains("unitTypeId", tool.Description);
            Assert.Contains("without saving", tool.Description);
            Assert.Contains("not loaded-project", tool.Description);
        }

        [Fact]
        public void SummaryExposesActualSubjectsAndPhaseLimitsBeforeScopedStyling()
        {
            var tool = OperatorToolManifest.Tools.Single(x => x.Path == "/revit/get-element-summary");
            Assert.Contains("includeTagReferences", tool.Description);
            Assert.Contains("statusInOwnerViewPhase", tool.Description);
            Assert.Contains("linked", tool.Description);
            Assert.Contains("orphan", tool.Description);
        }

        [Fact]
        public void InspectionExplainsAnnotationLabelStyleAndScopedVariantWorkflow()
        {
            var tool = OperatorToolManifest.Tools.Single(x => x.Path == "/revit/inspect-family-content");
            Assert.Contains("IndependentTag", tool.Description);
            Assert.Contains("FamilySymbol", tool.Description);
            Assert.Contains("before placement", tool.Description);
            Assert.Contains("labelType", tool.Description);
            Assert.Contains("underline", tool.Description);
            Assert.Contains("Save As", tool.Description);
            Assert.Contains("expectedOldTypes", tool.Description);
            Assert.Contains("inspect-family-label-styles", tool.Description);
            Assert.Contains("set-family-label-style", tool.Description);
            Assert.Contains("does not require manual Family Editor input", tool.Description);
        }

        [Fact]
        public void GroundedTagEditorIsDiscoverableWithoutInferringFamilyInstanceIdentity()
        {
            var tool = OperatorToolManifest.Tools.Single(x => x.Path == "/revit/open-family-doc");
            Assert.Contains("allowNonTitleblock", tool.Description);
            Assert.Contains("tag", tool.Description);
        }

        [Fact]
        public void FamilySessionTypographyHasDistinctReadAndMutationTools()
        {
            var read = OperatorToolManifest.Tools.SingleOrDefault(x => x.Path == "/revit/inspect-family-label-styles");
            var edit = OperatorToolManifest.Tools.SingleOrDefault(x => x.Path == "/revit/set-family-label-style");
            Assert.NotNull(read);
            Assert.NotNull(edit);
            Assert.Contains("familyDocumentId", read!.Description);
            Assert.Contains("expectedStyle", edit!.Description);
            Assert.Contains("underline", edit.Description);
            Assert.Contains("not", edit.Description);
        }
    }
}

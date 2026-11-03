using System.Text.Json;
using RevitBridge.Common.Annotation;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class FamilyLabelInspectionPolicyTests
    {
        [Fact]
        public void RetainedNativeFamilyLabelIsDiscoverableDespiteItsTextElementWrapper()
        {
            // Minimal native readback excerpt from a real Revit 2024 tag family.
            // The Family Editor displays this element as "Tag Label: standard".
            using var document = JsonDocument.Parse(@"{
                ""elementId"":788445,""runtimeType"":""TextElement"",
                ""name"":""standard"",""category"":""""}");
            Assert.True(FamilyLabelInspectionPolicy.IsLabel(document.RootElement.GetProperty("runtimeType").GetString()));
        }

        [Theory]
        [InlineData("TagLabel", true)]
        [InlineData("Label", true)]
        [InlineData("TextNote", false)]
        [InlineData("ModelText", false)]
        [InlineData("GraphicsStyle", false)]
        [InlineData("FamilyInstance", false)]
        [InlineData("", false)]
        [InlineData(null, false)]
        public void StaticTextAndNonTextFamilyContentAreNotMislabeled(string? runtimeType, bool expected)
            => Assert.Equal(expected, FamilyLabelInspectionPolicy.IsLabel(runtimeType));

        [Theory]
        [InlineData("Label", true)]
        [InlineData("family LABEL", true)]
        [InlineData("standard", true)]
        [InlineData("TextElement", true)]
        [InlineData("Box Visibility", true)]
        [InlineData("unrelated room name", false)]
        [InlineData("", true)]
        public void NativeTextElementLabelRemainsDiscoverableThroughFilteredSearch(string query, bool expected)
        {
            // Retained246 native query Label returned labels=[] despite the
            // complete class census containing TextElement:1. Unfiltered
            // inspection resolved this real label and its underline=false.
            Assert.Equal(expected, FamilyLabelInspectionPolicy.MatchesQuery(query,
                "TextElement", "standard", "", "Box Visibility"));
        }

        [Fact]
        public void SemanticLabelQueryDoesNotPromoteUnrelatedGraphicsStyleOrTextNote()
        {
            Assert.False(FamilyLabelInspectionPolicy.MatchesQuery("Label", "GraphicsStyle", "Contour Labels"));
            Assert.False(FamilyLabelInspectionPolicy.MatchesQuery("Label", "TextNote", "Label"));
            Assert.True(FamilyLabelInspectionPolicy.MatchesQuery("Room Number", "TagLabel", "Room Number"));
        }
    }
}

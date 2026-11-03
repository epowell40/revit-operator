using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common.Annotation;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TagTargetCategoryPolicyTests
    {
        [Fact]
        public void PublishedTagToolExplainsTheSharedDuctCategoryAndCollisionLimits()
        {
            var tool = OperatorToolManifest.Tools.Single(t => t.Path == "/revit/tag-elements");
            Assert.Contains("OST_DuctCurves -> OST_DuctTags", tool.Description);
            Assert.Contains("mixed or unsupported", tool.Description);
            Assert.Contains("no professionally clear tag/leader route are removed", tool.Description);
        }

        [Theory]
        [InlineData("OST_DuctCurves", "OST_DuctTags")]
        [InlineData("OST_DuctTerminal", "OST_DuctTerminalTags")]
        [InlineData("OST_MechanicalEquipment", "OST_MechanicalEquipmentTags")]
        [InlineData("OST_ElectricalEquipment", "OST_ElectricalEquipmentTags")]
        [InlineData("OST_ElectricalFixtures", "OST_ElectricalFixtureTags")]
        [InlineData("OST_LightingFixtures", "OST_LightingFixtureTags")]
        [InlineData("OST_PlumbingFixtures", "OST_PlumbingFixtureTags")]
        public void VisibilityAndContentSelectionShareOneNativeCategory(string subject, string tag)
        {
            Assert.Equal(tag, TagTargetCategoryPolicy.Resolve(subject));
            Assert.Equal(tag, TagTargetCategoryPolicy.ResolveCommon(new[] { subject, subject }));
        }

        [Fact]
        public void Retained326DuctRefusalIsNotAnUnsupportedOrMixedCategory()
        {
            using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "duct-tag-category-and-placement-326.json")));
            var root = json.RootElement;
            Assert.Equal(1460134, root.GetProperty("subject").GetProperty("id").GetInt32());
            Assert.Contains("single supported target tag category", root.GetProperty("cases")[0].GetProperty("payload").GetProperty("error").GetString());
            Assert.Equal("OST_DuctTags", TagTargetCategoryPolicy.ResolveCommon(new[] { root.GetProperty("subject").GetProperty("category_token").GetString() }));
            var visible = TagVisibilityPolicy.Decide(true, false, 1395555, null, true, false);
            Assert.Equal("already_visible", visible.Status);
            Assert.False(visible.ApplyChange);
            // The second refusal was real leader geometry, not category absence.
            Assert.Equal("tag_unresolved_leader_collision", root.GetProperty("cases")[1].GetProperty("payload").GetProperty("errors")[0].GetProperty("failureKind").GetString());
        }

        [Fact]
        public void UnknownLocalizedNullEmptyAndMixedTargetsStayUnresolved()
        {
            foreach (var value in new string?[] { null, "Ducts", "ost_ductcurves", "OST_Walls", "-1", "OST_DuctFitting" })
                Assert.Null(TagTargetCategoryPolicy.Resolve(value));
            Assert.Null(TagTargetCategoryPolicy.ResolveCommon(Array.Empty<string?>()));
            Assert.Null(TagTargetCategoryPolicy.ResolveCommon(new string?[] { null }));
            Assert.Null(TagTargetCategoryPolicy.ResolveCommon(new[] { "OST_DuctCurves", "OST_DuctTerminal" }));
            Assert.Null(TagTargetCategoryPolicy.ResolveCommon(new[] { "OST_DuctCurves", "OST_Walls" }));
        }
    }
}

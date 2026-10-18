using System;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorRequestSchemaSummaryTests
    {
        [Theory]
        [InlineData("/revit/inspect-excel-import")]
        [InlineData("/revit/inspect-drawing-spec")]
        public void DefaultInspectionDoesNotInheritListOnlyActionRequirement(string path)
        {
            Assert.True(OperatorConditionalRequestContracts.TryGet(path, out var schema));
            var original = schema.GetRawText();
            var summary = OperatorRequestSchemaSummary.Summarize(schema);
            Assert.Empty(summary.RequiredFields);
            Assert.Contains("action", summary.OptionalFields);
            Assert.Contains("sourcePath", summary.OptionalFields);
            Assert.Contains("manifestElementId", summary.OptionalFields);
            Assert.Equal(original, schema.GetRawText());
        }

        [Fact]
        public void AlternativeOrderCannotChangeGlobalRequirementsAndConjunctionsRemainRequired()
        {
            const string first = "{\"properties\":{\"base\":{}},\"required\":[\"base\"],\"allOf\":[{\"required\":[\"lease\"]}],\"oneOf\":[{\"properties\":{\"shared\":{},\"left\":{}},\"required\":[\"shared\",\"left\"]},{\"properties\":{\"shared\":{},\"right\":{}},\"required\":[\"shared\",\"right\"]}]}";
            using var doc = JsonDocument.Parse(first);
            var summary = OperatorRequestSchemaSummary.Summarize(doc.RootElement);
            Assert.Equal(new[] { "base", "lease", "shared" }, summary.RequiredFields);
            Assert.Equal(new[] { "left", "right" }, summary.OptionalFields);
            var reversed = first.Replace("\"oneOf\"", "\"anyOf\"").Replace("left", "temporary").Replace("right", "left").Replace("temporary", "right");
            using var other = JsonDocument.Parse(reversed);
            Assert.Equal(summary.RequiredFields, OperatorRequestSchemaSummary.Summarize(other.RootElement).RequiredFields);
            Assert.Equal(summary.OptionalFields, OperatorRequestSchemaSummary.Summarize(other.RootElement).OptionalFields);
        }

        [Theory]
        [InlineData("{\"oneOf\":[{\"type\":\"null\"},{\"properties\":{\"id\":{}},\"required\":[\"id\"]}]}", false)]
        [InlineData("{\"oneOf\":[false,{\"properties\":{\"id\":{}},\"required\":[\"id\"]}]}", true)]
        [InlineData("{\"anyOf\":[true,{\"properties\":{\"id\":{}},\"required\":[\"id\"]}]}", false)]
        public void NonObjectAndImpossibleAlternativesKeepTheirSemantics(string json, bool required)
        {
            using var doc = JsonDocument.Parse(json);
            var summary = OperatorRequestSchemaSummary.Summarize(doc.RootElement);
            Assert.Equal(required, summary.RequiredFields.Contains("id"));
            Assert.Equal(!required, summary.OptionalFields.Contains("id"));
        }

        [Fact]
        public void DeepMetadataCannotEscapeBoundedTraversal()
        {
            var json = "{}";
            for (var i = 0; i < 20; i++) json = "{\"allOf\":[" + json + "]}";
            using var doc = JsonDocument.Parse(json);
            Assert.Throws<ArgumentException>(() => OperatorRequestSchemaSummary.Summarize(doc.RootElement));
        }
    }
}

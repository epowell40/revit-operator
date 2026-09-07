using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorConditionalRequestContractsTests
    {
        [Theory]
        [InlineData("/revit/rotate-elements", "axis", "endPointX")]
        [InlineData("/revit/export-view-region", "region", "centerX")]
        [InlineData("/revit/transaction-validate", "checks", "parameterName")]
        public void ModeSpecificFieldsAreNotUnconditionallyRequired(string path, string property, string conditionalField)
        {
            Assert.True(OperatorConditionalRequestContracts.TryGet(path, out var schema));
            Assert.Equal(JsonValueKind.Object, schema.ValueKind);
            Assert.False(schema.GetProperty("additionalProperties").GetBoolean());
            var nested = schema.GetProperty("properties").GetProperty(property);
            if (property == "checks") nested = nested.GetProperty("items");
            Assert.DoesNotContain(conditionalField, nested.GetProperty("required").EnumerateArray().Select(x => x.GetString()));
            Assert.Equal(2, nested.GetProperty("oneOf").GetArrayLength());
            Assert.Contains(conditionalField, nested.GetProperty("oneOf")[1].GetProperty("required").EnumerateArray().Select(x => x.GetString()));
        }

        [Theory]
        [InlineData("/revit/create-duct")]
        [InlineData("/revit/create-pipe")]
        [InlineData("/revit/repair-mep-connectors")]
        public void MepPublicationComposesRealEmbeddedFragmentsWithoutOpeningOuterContract(string path)
        {
            var properties = new Dictionary<string, object> { ["unrelated"] = new { type = "boolean" } };
            var root = new Dictionary<string, object> { ["type"] = "object", ["properties"] = properties,
                ["additionalProperties"] = false, ["required"] = new[] { "unrelated" } };
            OperatorConditionalRequestContracts.ApplyMepFragments(path, root);
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(root));
            var schema = document.RootElement;
            Assert.False(schema.GetProperty("additionalProperties").GetBoolean());
            Assert.Equal("unrelated", schema.GetProperty("required")[0].GetString());
            Assert.Equal("boolean", schema.GetProperty("properties").GetProperty("unrelated").GetProperty("type").GetString());
            if (path == "/revit/repair-mep-connectors")
            {
                var repair = schema.GetProperty("properties").GetProperty("repair");
                Assert.Equal(new[] { "kind" }, repair.GetProperty("required").EnumerateArray().Select(x => x.GetString()).ToArray());
                var modes = repair.GetProperty("oneOf").EnumerateArray().ToArray();
                Assert.Equal(4, modes.Length);
                Assert.DoesNotContain("elementId", modes[0].GetProperty("required").EnumerateArray().Select(x => x.GetString()));
                Assert.DoesNotContain("vectorX", modes[3].GetProperty("required").EnumerateArray().Select(x => x.GetString()));
                Assert.Contains("connectorChanges", modes[3].GetProperty("required").EnumerateArray().Select(x => x.GetString()));
            }
            else
            {
                var endpoints = schema.GetProperty("allOf")[0].GetProperty("allOf");
                Assert.Equal(2, endpoints.GetArrayLength());
                foreach (var endpoint in endpoints.EnumerateArray())
                {
                    Assert.Equal(5, endpoint.GetProperty("anyOf").GetArrayLength());
                    Assert.Contains("frameId", endpoint.GetProperty("anyOf")[4].GetProperty("required").EnumerateArray().Select(x => x.GetString()));
                }
            }
        }

        [Fact]
        public void UnknownMepFragmentCannotSilentlyPublishAnOpenSchema()
        {
            Assert.Throws<InvalidOperationException>(() => OperatorConditionalRequestContracts.Fragment("missing"));
            Assert.Throws<ArgumentException>(() => OperatorConditionalRequestContracts.ApplyMepFragments("/unknown", new Dictionary<string, object>()));
        }

        [Fact]
        public void UnrelatedToolsContinueThroughTheirOwnContracts()
        {
            Assert.False(OperatorConditionalRequestContracts.TryGet("/revit/duplicate-sheet", out _));
            Assert.False(OperatorConditionalRequestContracts.TryGet("/revit/not-a-tool", out _));
        }
    }
}

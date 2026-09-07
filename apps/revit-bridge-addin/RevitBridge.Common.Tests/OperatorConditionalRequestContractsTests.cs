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

        [Fact]
        public void UnrelatedToolsContinueThroughTheirOwnContracts()
        {
            Assert.False(OperatorConditionalRequestContracts.TryGet("/revit/duplicate-sheet", out _));
            Assert.False(OperatorConditionalRequestContracts.TryGet("/revit/not-a-tool", out _));
        }
    }
}

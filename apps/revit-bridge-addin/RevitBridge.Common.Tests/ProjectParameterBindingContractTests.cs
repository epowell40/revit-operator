using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ProjectParameterBindingContractTests
    {
        [Theory]
        [InlineData("{}", true)]
        [InlineData("{\"action\":\"list\",\"query\":\"Office\",\"max\":5000}", true)]
        [InlineData("{\"action\":\"detail\",\"parameterId\":42}", true)]
        [InlineData("{\"action\":\"detail\",\"parameterId\":0}", false)]
        [InlineData("{\"action\":\"detail\",\"parameterId\":9007199254740992}", false)]
        [InlineData("{\"action\":\"detail\",\"parameterId\":\"42\"}", false)]
        [InlineData("{\"action\":\"detail\",\"parameterId\":42,\"instanceBinding\":true}", false)]
        [InlineData("{\"action\":\"list\",\"name\":\"Test\"}", false)]
        [InlineData("{\"action\":\"list\",\"max\":5001}", false)]
        [InlineData("{\"action\":null}", false)]
        [InlineData("[]", false)]
        public void ReadAuthorityRequiresAnExactNonmutatingShape(string json, bool expected)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(expected, ProjectParameterBindingContract.IsReadOnly(doc.RootElement));
            Assert.Equal(expected ? OperatorActionEffect.Read : OperatorActionEffect.Apply,
                OperatorApprovalPolicy.GetEffect("POST", "/revit/project-parameters", json));
            Assert.Equal(expected ? OperatorActionRisk.Low : OperatorActionRisk.High,
                OperatorApprovalPolicy.GetRisk("POST", "/revit/project-parameters", json));
        }

        [Theory]
        [InlineData("{\"action\":\"create\",\"name\":\"Office Instance Note\",\"categoryNames\":[\"Air Terminals\"],\"instanceBinding\":true,\"dataType\":\"text\"}", true)]
        [InlineData("{\"action\":\"create\",\"name\":\"Office Type Note\",\"categoryNames\":[\"Air Terminals\"],\"instanceBinding\":false,\"dataType\":\"text\"}", true)]
        [InlineData("{\"action\":\"create\",\"name\":\" \",\"categoryNames\":[\"Air Terminals\"]}", false)]
        [InlineData("{\"action\":\"create\",\"name\":\"Note\",\"categoryNames\":[]}", false)]
        [InlineData("{\"action\":\"create\",\"name\":\"Note\",\"categoryNames\":[\"Air Terminals\"],\"instanceBinding\":null}", false)]
        [InlineData("{\"action\":\"create\",\"name\":\"Note\",\"categoryNames\":[\"Air Terminals\"],\"dataType\":\"airflow\"}", false)]
        [InlineData("{\"action\":\"create\",\"name\":\"Note\",\"categoryNames\":[\"Air Terminals\"],\"parameterId\":42}", false)]
        public void NewBindingKeepsTypeAndInstanceChoicesExplicitAndDoesNotInventEngineeringTypes(string json, bool expected)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(expected, ProjectParameterBindingContract.ValidateCreate(doc.RootElement, out _));
        }

        [Fact]
        public void PublishedDetailAndCreateModesCannotLeakFieldsIntoEachOther()
        {
            Assert.True(OperatorConditionalRequestContracts.TryGet("/revit/project-parameters", out var schema));
            var modes = schema.GetProperty("oneOf").EnumerateArray().ToArray();
            var detail = modes.Single(m => m.GetProperty("properties").GetProperty("action").GetProperty("enum")[0].GetString() == "detail");
            var create = modes.Single(m => m.GetProperty("properties").GetProperty("action").GetProperty("enum")[0].GetString() == "create");
            Assert.False(detail.GetProperty("additionalProperties").GetBoolean());
            Assert.False(create.GetProperty("additionalProperties").GetBoolean());
            Assert.False(detail.GetProperty("properties").TryGetProperty("instanceBinding", out _));
            Assert.False(create.GetProperty("properties").TryGetProperty("parameterId", out _));
        }
    }
}

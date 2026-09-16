using System;
using System.Collections.Generic;
using System.Text.Json;
using RevitBridge.Logic.Handlers;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorJsonWireSchemaTests
    {
        [Theory]
        [InlineData(typeof(JsonElement))]
        [InlineData(typeof(JsonDocument))]
        [InlineData(typeof(object))]
        public void JsonContainersPublishTheirWireSchemaInsteadOfClrValueKind(Type type)
        {
            Assert.True(OperatorJsonWireSchema.TryCreate(type, out var schema));
            Assert.Equal("{}", JsonSerializer.Serialize(schema));
        }

        [Theory]
        [InlineData(typeof(Dictionary<string, int>))]
        public void OrdinaryRequestContractsStillUseTheirTypedSchema(Type type)
        {
            Assert.False(OperatorJsonWireSchema.TryCreate(type, out var schema));
            Assert.Null(schema);
        }

        [Theory]
        [InlineData(typeof(string), "string")]
        [InlineData(typeof(bool), "boolean")]
        [InlineData(typeof(long), "integer")]
        [InlineData(typeof(int), "integer")]
        [InlineData(typeof(short), "integer")]
        [InlineData(typeof(double), "number")]
        [InlineData(typeof(float), "number")]
        [InlineData(typeof(decimal), "number")]
        public void ScalarsKeepTheirWireTypeBeforeRecursiveSchemaExpansionIsTruncated(Type type, string expected)
        {
            Assert.True(OperatorJsonWireSchema.TryCreate(type, out var schema));
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(schema));
            Assert.Equal(expected, json.RootElement.GetProperty("type").GetString());
        }

        [Theory]
        [InlineData("{\"kind\":\"setViewScale\",\"viewId\":1542917,\"scale\":100}", true)]
        [InlineData("{\"kind\":\"setParameters\",\"changes\":[{\"elementId\":1542917,\"parameterName\":\"Comments\",\"value\":\"Coordination\"}]}", true)]
        [InlineData("{\"kind\":\"setViewScale\",\"viewId\":1542917,\"scale\":0}", false)]
        [InlineData("{\"ValueKind\":1}", false)]
        public void TransactionRequestsPreserveJsonActionsAndNativeValidation(string action, bool valid)
        {
            var request = "{\"actions\":[" + action + "]}";
            // Use the same List<JsonElement> wire type without loading the UI
            // handler's Autodesk host dependency in the standalone test runner.
            var actions = JsonSerializer.Deserialize<Dictionary<string, List<JsonElement>>>(request)!["actions"];
            Assert.Equal(action, actions[0].GetRawText());
            Assert.True(OperatorJsonWireSchema.TryCreate(actions[0].GetType(), out _));
            var outcome = TransactionActionRunner.ValidateAction(actions[0], new List<string>(), 0);
            Assert.Equal(valid, outcome.Errors.Count == 0);
        }
    }
}

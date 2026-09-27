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
        public void DictionariesAreHandledByTheRecursiveSchemaBoundaryInsteadOfTheScalarBoundary(Type type)
        {
            Assert.False(OperatorJsonWireSchema.TryCreate(type, out var schema));
            Assert.Null(schema);
        }

        [Theory]
        [InlineData(typeof(Dictionary<string, string>))]
        [InlineData(typeof(IDictionary<string, string>))]
        [InlineData(typeof(IReadOnlyDictionary<string, string>))]
        [InlineData(typeof(SortedDictionary<string, string>))]
        public void StringMapsDescribeSerializedEntriesInsteadOfCountOrKeys(Type type)
        {
            Assert.True(OperatorJsonWireSchema.TryCreateDictionary(type, valueType =>
            {
                Assert.Equal(typeof(string), valueType);
                Assert.True(OperatorJsonWireSchema.TryCreate(valueType, out var value));
                return value!;
            }, out var schema));
            Assert.Equal("{\"type\":\"object\",\"additionalProperties\":{\"type\":\"string\"}}", JsonSerializer.Serialize(schema));
        }

        [Fact]
        public void PlacementParameterWireShapeAcceptsNamedStringEntries()
        {
            // Exercise the handler's Dictionary<string,string> wire contract
            // without loading its Autodesk UI dependency in a standalone runner.
            Assert.True(OperatorJsonWireSchema.TryCreateDictionary(typeof(Dictionary<string, string>), valueType =>
            {
                Assert.True(OperatorJsonWireSchema.TryCreate(valueType, out var scalar));
                return scalar!;
            }, out var schema));
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(schema));
            Assert.Equal("string", json.RootElement.GetProperty("additionalProperties").GetProperty("type").GetString());
            Assert.False(json.RootElement.TryGetProperty("required", out _));
            Assert.False(json.RootElement.TryGetProperty("properties", out _));
            var instance = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>("{\"parameters\":{\"Mark\":\"HRU403\",\"Comments\":\"Provisional\"}}")!;
            Assert.Equal("HRU403", instance["parameters"]["Mark"]);
            Assert.Equal("Provisional", instance["parameters"]["Comments"]);
            Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>("{\"parameters\":{\"Mark\":403}}"));
        }

        [Fact]
        public void NestedMapAndListValueSchemaIsDelegatedWithoutLosingItsConstraints()
        {
            var listSchema = new Dictionary<string, object> { ["type"] = "array", ["items"] = new Dictionary<string, object> { ["type"] = "integer" } };
            Assert.True(OperatorJsonWireSchema.TryCreateDictionary(typeof(Dictionary<string, IReadOnlyDictionary<string, List<int>>>), innerType =>
            {
                Assert.Equal(typeof(IReadOnlyDictionary<string, List<int>>), innerType);
                Assert.True(OperatorJsonWireSchema.TryCreateDictionary(innerType, listType =>
                {
                    Assert.Equal(typeof(List<int>), listType);
                    return listSchema;
                }, out var nested));
                return nested!;
            }, out var schema));
            Assert.Equal("{\"type\":\"object\",\"additionalProperties\":{\"type\":\"object\",\"additionalProperties\":{\"type\":\"array\",\"items\":{\"type\":\"integer\"}}}}", JsonSerializer.Serialize(schema));
        }

        [Theory]
        [InlineData(typeof(Dictionary<int, string>))]
        [InlineData(typeof(List<string>))]
        [InlineData(typeof(OrdinaryRequest))]
        public void NonStringMapsListsAndDtosKeepTheirExistingSchemaPath(Type type)
        {
            Assert.False(OperatorJsonWireSchema.TryCreateDictionary(type, _ => throw new Exception("Not a supported map"), out var schema));
            Assert.Null(schema);
        }

        public class OrdinaryRequest { public string? Name { get; set; } }

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

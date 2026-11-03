using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class TagElementModeContractTests
    {
        [Fact]
        public void ExactRetained296RequestIsRejectedWithoutStartingATransaction()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures/created-tag-mixed-mode-296.json")));
            var body = fixture.RootElement.GetProperty("input").GetProperty("body");
            var response = NativeMutationPreflightBoundary.Execute(enter => {
                if (!TagElementModeContract.Validate(body, out var error)) throw new ArgumentException(error);
                enter(); throw new Exception("Malformed retained request reached native mutation.");
            });
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/tag-elements").EffectState);
            Assert.True(fixture.RootElement.GetProperty("applied").GetProperty("transaction").GetProperty("committed").GetBoolean());
            // Historical commit remains historical; this tests future admission.
        }

        [Theory]
        [InlineData("{\"viewId\":1,\"elementIds\":[2]}")]
        [InlineData("{\"categoryNames\":[\"Ducts\"],\"addLeader\":false}")]
        [InlineData("{\"elementIds\":[2],\"hasLeader\":null,\"repairExistingTagId\":null}")]
        [InlineData("{\"viewName\":\"L3\",\"repairExistingTagId\":3,\"hasLeader\":false,\"dryRun\":false}")]
        [InlineData("{\"repairExistingTagId\":3,\"tagHeadPositionXyz\":[1,2,3]}")]
        public void SeparateCreationAndRepairKeepTheirExistingFields(string json)
        {
            using var request = JsonDocument.Parse(json);
            Assert.True(TagElementModeContract.Validate(request.RootElement, out var error), error);
        }

        [Theory]
        [InlineData("hasLeader", "true")]
        [InlineData("hasLeader", "false")]
        [InlineData("tagHeadPositionXyz", "[1,2,3]")]
        [InlineData("leaderEndXyz", "[1,2,3]")]
        [InlineData("leaderElbowXyz", "[1,2,3]")]
        [InlineData("leaderEndCondition", "\"free\"")]
        public void IgnoredRepairFieldsFailBeforeNativeMutation(string name, string value)
        {
            using var request = JsonDocument.Parse("{\"viewId\":1,\"elementIds\":[2],\"" + name + "\":" + value + "}");
            var entered = false;
            var response = Assert.IsType<Dictionary<string, object?>>(NativeMutationPreflightBoundary.Execute(enter => {
                if (!TagElementModeContract.Validate(request.RootElement, out var error)) throw new ArgumentException(error);
                entered = true; enter(); return new { success = true };
            }));
            Assert.False(entered);
            Assert.Contains("requires repairExistingTagId", Assert.IsType<string>(response["error"]));
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(response["transaction"]);
            Assert.Equal("not_started", receipt.Status);
            Assert.Empty(receipt.AffectedElementIds);
        }

        [Theory]
        [InlineData("{\"repairExistingTagId\":1,\"elementIds\":[2]}")]
        [InlineData("{\"repairExistingTagId\":1,\"addLeader\":false}")]
        [InlineData("{\"repairExistingTagId\":1,\"orientation\":\"vertical\"}")]
        [InlineData("{\"repairExistingTagId\":1,\"tagTypeId\":2}")]
        [InlineData("{\"repairExistingTagId\":0}")]
        [InlineData("{\"repairExistingTagId\":-1}")]
        [InlineData("{\"repairExistingTagId\":\"1\"}")]
        public void RepairCannotSilentlyIgnoreCreationIntent(string json)
        {
            using var request = JsonDocument.Parse(json);
            Assert.False(TagElementModeContract.Validate(request.RootElement, out _));
        }

        [Fact]
        public void PublishedModeConstraintsAndBothNativeEntryPointsShareContract()
        {
            var properties = new Dictionary<string, object>();
            foreach (var name in typeof(TagElementsHandler.TagRequest).GetProperties().Select(p => p.Name))
                properties[name] = new Dictionary<string, object>();
            var schema = new Dictionary<string, object> { ["properties"] = properties };
            TagElementModeContract.ApplySchema(schema);
            using var published = JsonDocument.Parse(JsonSerializer.Serialize(schema));
            var modes = published.RootElement.GetProperty("oneOf");
            Assert.Empty(published.RootElement.GetProperty("required").EnumerateArray());
            Assert.Equal("null", modes[0].GetProperty("properties").GetProperty("hasLeader").GetProperty("type").GetString());
            Assert.Equal("null", modes[1].GetProperty("properties").GetProperty("addLeader").GetProperty("type").GetString());
            Assert.Equal(1, modes[1].GetProperty("properties").GetProperty("repairExistingTagId").GetProperty("minimum").GetInt32());
            Assert.Equal(2, modes[0].GetProperty("anyOf").GetArrayLength());
            string? root = null;
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null && root == null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var candidate = Path.Combine(directory.FullName, prefix);
                    if (File.Exists(Path.Combine(candidate, "RevitBridge/Operator/OperatorToolIntrospection.cs"))) root = candidate;
                }
            Assert.NotNull(root);
            Assert.Contains("TagElementModeContract.ApplySchema(schema)", File.ReadAllText(Path.Combine(root!, "RevitBridge/Operator/OperatorToolIntrospection.cs")));
            Assert.Contains("TagElementModeContract.Validate(obj.Value, out error)", File.ReadAllText(Path.Combine(root!, "RevitBridge/Operator/OperatorActionSchemaValidator.cs")));
            var handler = File.ReadAllText(Path.Combine(root!, "RevitBridge.Logic/Handlers/TagElementsHandler.cs"));
            var guard = handler.IndexOf("TagElementModeContract.Validate", StringComparison.Ordinal);
            Assert.True(guard >= 0 && guard < handler.IndexOf("var doc = app.ActiveUIDocument", StringComparison.Ordinal));
        }
    }
}

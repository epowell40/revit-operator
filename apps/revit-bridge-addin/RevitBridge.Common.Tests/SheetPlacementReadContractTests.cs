using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class SheetPlacementReadContractTests
    {
        [Theory]
        [InlineData("{\"placementIds\":[1673544]}", "detail", true)]
        [InlineData("{\"placementIds\":[1,2]}", "detail", true)]
        [InlineData("{}", "list", true)]
        [InlineData("{\"placementIds\":[1]}", "list", false)]
        [InlineData("{\"placementIds\":[1]}", "count", false)]
        [InlineData("{\"placementIds\":null}", "detail", false)]
        [InlineData("{\"placementIds\":[]}", "detail", false)]
        [InlineData("{\"placementIds\":[1,1]}", "detail", false)]
        [InlineData("{\"placementIds\":[0]}", "detail", false)]
        [InlineData("{\"placementIds\":[-1]}", "detail", false)]
        [InlineData("{\"placementIds\":[1.5]}", "detail", false)]
        [InlineData("{\"placementIds\":[\"1\"]}", "detail", false)]
        public void SelectorsPreserveModeIdentityAndBounds(string json, string action, bool accepted)
        {
            using var document = JsonDocument.Parse(json);
            Assert.Equal(accepted, SheetPlacementReadContract.Validate(document.RootElement, action, out _));
        }

        [Fact]
        public void PublishedSelectorAndPreDispatchValidatorShareBoundedContract()
        {
            using var schema = JsonDocument.Parse(JsonSerializer.Serialize(SheetPlacementReadContract.SelectorSchema()));
            Assert.Equal("array", schema.RootElement.GetProperty("type").GetString());
            Assert.Equal("integer", schema.RootElement.GetProperty("items").GetProperty("type").GetString());
            Assert.Equal(1, schema.RootElement.GetProperty("items").GetProperty("minimum").GetInt32());
            Assert.Equal(1, schema.RootElement.GetProperty("minItems").GetInt32());
            Assert.Equal(256, schema.RootElement.GetProperty("maxItems").GetInt32());
            Assert.True(schema.RootElement.GetProperty("uniqueItems").GetBoolean());
            foreach (var count in new[] { 256, 257 })
            {
                using var request = JsonDocument.Parse(JsonSerializer.Serialize(new { placementIds = Enumerable.Range(1, count).ToArray() }));
                Assert.Equal(count == 256, SheetPlacementReadContract.Validate(request.RootElement, "detail", out _));
            }
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            string? root = null;
            while (directory != null && root == null)
            {
                foreach (var suffix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var candidate = Path.Combine(directory.FullName, suffix);
                    if (File.Exists(Path.Combine(candidate, "RevitBridge/Operator/OperatorToolIntrospection.cs"))) root = candidate;
                }
                directory = directory.Parent;
            }
            Assert.NotNull(root);
            Assert.Contains("{ \"placementIds\", SheetPlacementReadContract.SelectorSchema() }", File.ReadAllText(Path.Combine(root!, "RevitBridge/Operator/OperatorToolIntrospection.cs")));
            Assert.Contains("SheetPlacementReadContract.Validate(obj.Value, sheetsAction, out error)", File.ReadAllText(Path.Combine(root!, "RevitBridge/Operator/OperatorActionSchemaValidator.cs")));
        }
    }
}

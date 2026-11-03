using System;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class NativeInteractiveAccessoryRequestTests
    {
        private static string Request(int count = 1) => JsonSerializer.Serialize(new
        {
            expectedModelPath = @"C:\sample\model.rvt", viewId = 12,
            expectedViewUniqueId = "view-uid", accessoryTypeId = 20,
            expectedAccessoryTypeUniqueId = "symbol-uid", maximumPlacements = count,
            targetHosts = new[] { new { elementId = 31, uniqueId = "host-uid" } }
        });

        [Theory]
        [InlineData(1)] [InlineData(30)] [InlineData(50)]
        public void BoundSupportsOneInsertionAndOrdinaryRepeatedWork(int count)
        {
            Assert.Equal(count, NativeInteractiveAccessoryRequest.Parse(Request(count)).maximumPlacements);
        }

        [Theory]
        [InlineData(0)] [InlineData(-1)] [InlineData(51)]
        public void NoSilentPlacementCountDefaultOrClamp(int count)
            => Assert.Throws<ArgumentException>(() => NativeInteractiveAccessoryRequest.Parse(Request(count)));

        [Theory]
        [InlineData("dryRun", "true")]
        [InlineData("hostId", "22")]
        [InlineData("splitPoint", "[0,0,0]")]
        [InlineData("maximumPlacements", "2")]
        public void UnknownOrDuplicateFieldsCannotSelectAnotherExecutionMode(string field, string value)
            => Assert.Throws<ArgumentException>(() => NativeInteractiveAccessoryRequest.Parse(
                Request().TrimEnd('}') + ",\"" + field + "\":" + value + "}"));

        [Theory]
        [InlineData("viewId")] [InlineData("expectedViewUniqueId")]
        [InlineData("accessoryTypeId")] [InlineData("expectedAccessoryTypeUniqueId")]
        [InlineData("expectedModelPath")] [InlineData("maximumPlacements")]
        [InlineData("targetHosts")]
        public void AllNativeBindingAndBoundFieldsRequired(string omitted)
        {
            var values = JsonSerializer.Deserialize<System.Collections.Generic.Dictionary<string, JsonElement>>(Request())!;
            values.Remove(omitted);
            Assert.Throws<ArgumentException>(() => NativeInteractiveAccessoryRequest.Parse(JsonSerializer.Serialize(values)));
        }

        [Fact]
        public void InvalidNativeIdentitiesRefuseBeforePlacement()
        {
            Assert.Throws<ArgumentException>(() => NativeInteractiveAccessoryRequest.Parse(Request().Replace("view-uid", "")));
            Assert.Throws<ArgumentException>(() => NativeInteractiveAccessoryRequest.Parse(Request().Replace("\"viewId\":12", "\"viewId\":20")));
            Assert.Throws<ArgumentException>(() => NativeInteractiveAccessoryRequest.Parse(Request().Replace("\"accessoryTypeId\":20", "\"accessoryTypeId\":9007199254740992")));
        }

        [Fact]
        public void ModelVisibleContractAndNativeValidationKeepExactIdentityAndBounds()
        {
            using var schema = JsonDocument.Parse(JsonSerializer.Serialize(NativeInteractiveAccessoryRequest.RequestSchema()));
            Assert.False(schema.RootElement.GetProperty("additionalProperties").GetBoolean());
            Assert.Equal(7, schema.RootElement.GetProperty("required").GetArrayLength());
            Assert.Equal(50, schema.RootElement.GetProperty("properties").GetProperty("maximumPlacements").GetProperty("maximum").GetInt32());
            using var valid = JsonDocument.Parse(Request());
            Assert.True(NativeInteractiveAccessoryRequest.TryValidate(valid.RootElement, out var error));
            Assert.Null(error);
            foreach (var json in new[] { "null", "[]", "{}", Request(51), Request().Replace("\"viewId\":12", "\"viewId\":null"),
                Request().TrimEnd('}') + ",\"dryRun\":true}" })
            {
                using var invalid = JsonDocument.Parse(json);
                Assert.False(NativeInteractiveAccessoryRequest.TryValidate(invalid.RootElement, out error));
                Assert.False(string.IsNullOrWhiteSpace(error));
            }
        }

        [Theory]
        [InlineData("[]")]
        [InlineData("null")]
        [InlineData("[{\"elementId\":31,\"uniqueId\":\"\"}]")]
        [InlineData("[{\"elementId\":20,\"uniqueId\":\"symbol-uid\"}]")]
        [InlineData("[{\"elementId\":31,\"uniqueId\":\"host-uid\",\"point\":[0,0,0]}]")]
        [InlineData("[{\"elementId\":31,\"uniqueId\":\"host-uid\"},{\"elementId\":31,\"uniqueId\":\"other\"}]")]
        public void TargetHostsAreExactBoundedNativeIdentities(string hosts)
        {
            var values = JsonSerializer.Deserialize<System.Collections.Generic.Dictionary<string, JsonElement>>(Request())!;
            using var input = JsonDocument.Parse(hosts); values["targetHosts"] = input.RootElement.Clone();
            Assert.Throws<ArgumentException>(() => NativeInteractiveAccessoryRequest.Parse(JsonSerializer.Serialize(values)));
        }
    }
}

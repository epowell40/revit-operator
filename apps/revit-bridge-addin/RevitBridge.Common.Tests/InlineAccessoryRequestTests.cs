using System;
using System.Collections.Generic;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryRequestTests
    {
        private static Dictionary<string, object> Valid() => new Dictionary<string, object> {
            ["connectionMode"] = "insert_inline_accessory", ["kind"] = "duct",
            ["expectedModelPath"] = @"C:\fixtures\disposable.rvt", ["mainElementId"] = 10L,
            ["expectedMainUniqueId"] = "native-host-uid", ["expectedMainStartXyz"] = new[] { 0d, 0d, 0d },
            ["expectedMainEndXyz"] = new[] { 4d, 0d, 0d }, ["accessoryTypeId"] = 20L,
            ["expectedAccessoryTypeUniqueId"] = "native-type-uid", ["insertionPointXyz"] = new[] { 2d, 0d, 0d },
            ["instanceRadiusParameter"] = "Duct Radius"
        };
        [Fact] public void DefaultsToNativeRollbackWithoutWaivingVerification()
        {
            var request = InlineAccessoryRequest.Parse(JsonSerializer.Serialize(Valid()));
            Assert.True(request.dryRun);
            var apply = Valid(); apply["dryRun"] = false;
            Assert.False(InlineAccessoryRequest.Parse(JsonSerializer.Serialize(apply)).dryRun);
        }
        [Theory]
        [InlineData("verify", false)]
        [InlineData("diameterFt", .5)]
        [InlineData("familyPath", "other.rfa")]
        [InlineData("worksetId", 22)]
        [InlineData("connectionMode", "takeoff_fitting")]
        [InlineData("kind", "pipe")]
        public void RejectsUnimplementedAuthorityAndGuessedDesignFields(string name, object value)
        {
            var request = Valid(); request[name] = value;
            Assert.Throws<ArgumentException>(() => InlineAccessoryRequest.Parse(JsonSerializer.Serialize(request)));
        }
        [Theory]
        [InlineData("expectedMainUniqueId")]
        [InlineData("expectedAccessoryTypeUniqueId")]
        [InlineData("expectedMainStartXyz")]
        [InlineData("instanceRadiusParameter")]
        [InlineData("connectionMode")]
        [InlineData("kind")]
        public void MissingIdentityOrGeometryCannotProceed(string field)
        {
            var request = Valid(); request.Remove(field);
            Assert.Throws<ArgumentException>(() => InlineAccessoryRequest.Parse(JsonSerializer.Serialize(request)));
        }
        [Fact] public void DuplicateKeysAndNullCoordinatesFailClosed()
        {
            var json = JsonSerializer.Serialize(Valid());
            Assert.Throws<ArgumentException>(() => InlineAccessoryRequest.Parse(json.Insert(1, "\"mainElementId\":11,")));
            var request = Valid(); request["insertionPointXyz"] = null!;
            Assert.Throws<ArgumentException>(() => InlineAccessoryRequest.Parse(JsonSerializer.Serialize(request)));
        }
        [Fact] public void PublishedSchemaUsesTheSameExplicitBoundedFields()
        {
            using var schema = JsonDocument.Parse(JsonSerializer.Serialize(InlineAccessoryRequest.RequestSchema()));
            var root = schema.RootElement;
            Assert.False(root.GetProperty("additionalProperties").GetBoolean());
            Assert.Equal(11, root.GetProperty("required").GetArrayLength());
            Assert.Equal("insert_inline_accessory", root.GetProperty("properties").GetProperty("connectionMode").GetProperty("enum")[0].GetString());
            using var valid = JsonDocument.Parse(JsonSerializer.Serialize(Valid()));
            Assert.True(InlineAccessoryRequest.IsMode(valid.RootElement));
            Assert.True(InlineAccessoryRequest.TryValidate(valid.RootElement, out _));
        }
    }
}

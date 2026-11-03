using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class NativeInteractiveAccessoryInspectionPolicyTests
    {
        private static string Request() => JsonSerializer.Serialize(new {
            elementIds = new[] { 1, 2, 3 }, placementTypeIds = new[] { 10 }, placementSystemIds = new[] { 11 },
            preservationScheduleIds = new[] { 12 }, placementChangedIds = new[] { 1 }, includeNativePlacementState = true,
            includeAllRefs = true, includeCoordinateSystem = true, includeFlexGeometry = true,
            onlyOpenPhysicalConnectors = false, maxConnectorsPerElement = 512 });
        private static bool Valid(string json)
        { using var doc = JsonDocument.Parse(json); return DuctVerificationInspectionPolicy.TryValidate(doc.RootElement, out _); }
        [Fact] public void ExistingConnectorReadsAndBoundedNativePlacementProjectionRemainDistinct()
        {
            Assert.True(Valid("{\"elementIds\":[1]}"));
            Assert.True(Valid(Request()));
            var body = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(Request())!;
            body["elementIds"] = JsonSerializer.SerializeToElement(Enumerable.Range(100, 5000));
            Assert.True(Valid(JsonSerializer.Serialize(body)));
            body["elementIds"] = JsonSerializer.SerializeToElement(Enumerable.Range(100, 5001));
            Assert.False(Valid(JsonSerializer.Serialize(body)));
            body["elementIds"] = JsonSerializer.SerializeToElement(new[] { 1, 2 });
            body["placementSystemIds"] = JsonSerializer.SerializeToElement(new int[0]);
            Assert.True(Valid(JsonSerializer.Serialize(body)), "A disconnected target can have no pre-existing system.");
        }
        [Theory]
        [InlineData("elementIds", "[1,1]")]
        [InlineData("elementIds", "[null]")]
        [InlineData("elementIds", "[\"1\"]")]
        [InlineData("placementTypeIds", "[]")]
        [InlineData("placementTypeIds", "[1]")]
        [InlineData("placementSystemIds", "[11,11]")]
        [InlineData("placementChangedIds", "[1,1]")]
        [InlineData("placementChangedIds", "[null]")]
        [InlineData("preservationScheduleIds", "[10]")]
        [InlineData("includeNativePlacementState", "\"true\"")]
        [InlineData("includeNativePlacementState", "false")]
        [InlineData("includeAllRefs", "false")]
        [InlineData("includeCoordinateSystem", "false")]
        [InlineData("includeFlexGeometry", "false")]
        [InlineData("onlyOpenPhysicalConnectors", "true")]
        [InlineData("includeInlineAccessoryState", "true")]
        [InlineData("includeTeeReplacementState", "true")]
        [InlineData("includeVerificationParameters", "true")]
        [InlineData("replacementRemovedIds", "[]")]
        public void PartialMixedOrForeignScopesCannotClaimPlacementObservation(string field, string value)
        {
            var body = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(Request())!;
            using var replacement = JsonDocument.Parse(value); body[field] = replacement.RootElement.Clone();
            Assert.False(Valid(JsonSerializer.Serialize(body)));
        }
        [Theory]
        [InlineData("elementIds")] [InlineData("placementTypeIds")] [InlineData("placementSystemIds")]
        [InlineData("preservationScheduleIds")] [InlineData("includeAllRefs")] [InlineData("includeCoordinateSystem")]
        [InlineData("placementChangedIds")]
        [InlineData("includeFlexGeometry")] [InlineData("includeNativePlacementState")]
        public void RequiredScopeAndProjectionFieldsCannotBeOmitted(string field)
        {
            var body = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(Request())!; body.Remove(field);
            Assert.False(Valid(JsonSerializer.Serialize(body)));
        }
    }
}

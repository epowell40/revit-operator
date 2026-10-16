using System;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class SchedulePresentationContractTests
    {
        [Theory]
        [InlineData("{\"fieldOrder\":[20,0,3,14],\"appearance\":{\"titleTextTypeId\":41,\"headerTextTypeId\":42,\"bodyTextTypeId\":43}}")]
        [InlineData("{\"appearance\":{\"showTitle\":true}}")]
        [InlineData("{\"fieldOrder\":null,\"appearance\":null}")]
        public void ExistingStylesAndNoncontiguousFieldIdsAreAccepted(string json)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.True(SchedulePresentationContract.Validate(doc.RootElement, out var error), error);
        }

        [Theory]
        [InlineData("{\"fieldOrder\":[]}")]
        [InlineData("{\"fieldOrder\":[0,0]}")]
        [InlineData("{\"fieldOrder\":[1,-1]}")]
        [InlineData("{\"fieldOrder\":[1,2.5]}")]
        [InlineData("{\"fieldOrder\":[\"1\"]}")]
        [InlineData("{\"fieldOrder\":[1],\"addFields\":[\"Count\"]}")]
        [InlineData("{\"fieldOrder\":[1],\"calculatedFields\":[{\"name\":\"new\"}]}")]
        [InlineData("{\"appearance\":{\"titleTextTypeId\":-1}}")]
        [InlineData("{\"appearance\":{\"headerTextTypeId\":0}}")]
        [InlineData("{\"appearance\":{\"bodyTextTypeId\":true}}")]
        public void MalformedOrUnresolvedOrdersAndStyleIdsRefuse(string json)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.False(SchedulePresentationContract.Validate(doc.RootElement, out var error));
            Assert.NotEmpty(error);
        }

        [Fact]
        public void ReorderIncludesHiddenFieldsAndDoesNotRequireContiguousIds()
        {
            var current = new[] { 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 };
            SchedulePresentationContract.RequireCompleteOrder(current, new[] { 11, 12, 13, 14, 15, 16, 17, 19, 18, 20 });
            Assert.Throws<ArgumentException>(() => SchedulePresentationContract.RequireCompleteOrder(current, new[] { 11, 12, 13, 14, 15, 16, 17, 19, 18 }));
            Assert.Throws<ArgumentException>(() => SchedulePresentationContract.RequireCompleteOrder(current, new[] { 11, 12, 13, 14, 15, 16, 17, 19, 18, 99 }));
            Assert.Throws<ArgumentException>(() => SchedulePresentationContract.RequireCompleteOrder(current, new[] { 11, 12, 13, 14, 15, 16, 17, 19, 18, 18 }));
        }

        [Fact]
        public void LargeRequestsAreBoundedBeforeNativeWork()
        {
            using var doc = JsonDocument.Parse("{\"fieldOrder\":[" + string.Join(",", System.Linq.Enumerable.Range(0, 201)) + "]}");
            Assert.False(SchedulePresentationContract.Validate(doc.RootElement, out _));
        }
    }
}

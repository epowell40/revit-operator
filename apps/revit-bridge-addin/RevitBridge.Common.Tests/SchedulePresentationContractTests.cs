using System;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class SchedulePresentationContractTests
    {
        [Fact]
        public void PublishedPresentationReadUsesTheSameExactShapeAsNativeAdmission()
        {
            Assert.True(OperatorConditionalRequestContracts.TryGet("/revit/schedules", out var schema));
            var found = false;
            foreach (var branch in schema.GetProperty("oneOf").EnumerateArray())
            {
                var action = branch.GetProperty("properties").GetProperty("action").GetProperty("enum")[0].GetString();
                if (action != "presentation") continue;
                found = true;
                Assert.False(branch.GetProperty("additionalProperties").GetBoolean());
                Assert.Equal(2, branch.GetProperty("properties").EnumerateObject().Count());
                Assert.Equal("action", branch.GetProperty("required")[0].GetString());
                Assert.Equal("scheduleId", branch.GetProperty("required")[1].GetString());
                Assert.Equal(1, branch.GetProperty("properties").GetProperty("scheduleId").GetProperty("minimum").GetInt32());
                using var body = JsonDocument.Parse("{\"action\":\"presentation\",\"scheduleId\":1542917}");
                Assert.True(SchedulePresentationContract.ValidateRead(body.RootElement, out _));
            }
            Assert.True(found, "Native tool registry must publish the presentation action, not only list/detail.");
        }

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

        [Theory]
        [InlineData("{\"action\":\"presentation\",\"scheduleId\":41}", true)]
        [InlineData("{\"action\":\"presentation\",\"query\":\"air\"}", false)]
        [InlineData("{\"action\":\"presentation\",\"scheduleId\":true}", false)]
        [InlineData("{\"action\":\"presentation\",\"scheduleId\":-1}", false)]
        [InlineData("{\"action\":\"presentation\",\"scheduleId\":41,\"includeFields\":true}", false)]
        public void IndependentPresentationReadsRequireOneExactNativeTarget(string json, bool expected)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(expected, SchedulePresentationContract.ValidateRead(doc.RootElement, out _));
        }

        [Theory]
        [InlineData("{\"scheduleId\":41,\"fieldOrder\":[0,12]}", true)]
        [InlineData("{\"scheduleId\":true,\"fieldOrder\":[0,12]}", false)]
        [InlineData("{\"scheduleId\":41,\"appearance\":{\"titleTextTypeId\":70}}", true)]
        [InlineData("{\"scheduleId\":41,\"appearance\":{\"titleTextTypeId\":70,\"stripedRows\":true}}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldOrder\":[0,12],\"filters\":[]}", false)]
        public void ScopeCensusIsOnlyForTheReviewedPresentationSubset(string json, bool expected)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(expected, SchedulePresentationContract.IsBoundedPresentationEdit(doc.RootElement));
        }

        [Theory]
        [InlineData("{\"scheduleId\":41,\"columnWidths\":[{\"field\":\"Remarks\",\"widthFeet\":0.38}]}", true)]
        [InlineData("{\"scheduleId\":41,\"columnWidths\":[{\"field\":\"Remarks\",\"widthFeet\":0.38}],\"fieldOrder\":[1,2]}", true)]
        [InlineData("{\"scheduleId\":41,\"columnWidths\":[{\"field\":\"Remarks\",\"widthFeet\":0}]}", false)]
        [InlineData("{\"scheduleId\":41,\"columnWidths\":[{\"field\":\"Remarks\",\"widthFeet\":0.38},{\"field\":\"remarks\",\"widthFeet\":0.2}]}", false)]
        [InlineData("{\"scheduleId\":41,\"columnWidths\":[{\"field\":\"Remarks\",\"widthFeet\":0.38,\"invented\":true}]}", false)]
        public void WidthEditsHaveBoundedNativePreservationScope(string json, bool expected)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(expected, SchedulePresentationContract.IsBoundedPresentationEdit(doc.RootElement));
        }

        [Fact]
        public void LargeRequestsAreBoundedBeforeNativeWork()
        {
            using var doc = JsonDocument.Parse("{\"fieldOrder\":[" + string.Join(",", System.Linq.Enumerable.Range(0, 201)) + "]}");
            Assert.False(SchedulePresentationContract.Validate(doc.RootElement, out _));
        }
    }
}

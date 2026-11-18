using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ScheduleCombinedFieldContractTests
    {
        [Theory]
        [InlineData("{}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[0,12]}}", true)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[0,12],\"separator\":\"\",\"hideSourceFields\":false,\"widthFeet\":0.1,\"index\":2},\"dryRun\":false}", true)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":null}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\" \",\"sourceFieldIds\":[0,12]}}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[0,0]}}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[0]}}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[-1,12]}}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[0,12.5]}}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[0,12]},\"filters\":[]}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[0,12],\"index\":201}}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[0,12],\"widthFeet\":0}}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[0,12],\"hideSourceFields\":null}}", false)]
        [InlineData("{\"scheduleId\":41,\"combinedField\":{\"name\":\"Basis\",\"sourceFieldIds\":[0,12]},\"dryRun\":null}", false)]
        public void NativeAdmissionIsOneClosedBoundedOperation(string json, bool expected)
        {
            using var document = JsonDocument.Parse(json);
            Assert.Equal(expected, ScheduleCombinedFieldContract.ValidateEdit(document.RootElement, out _));
        }
        [Fact]
        public void PublishedCompositionPreservesLegacyWhileClosingTheCombinedBranch()
        {
            var root = new Dictionary<string, object> { ["type"]="object", ["additionalProperties"]=false,
                ["properties"]=new Dictionary<string, object> { ["query"]=new { type="string" }, ["combinedField"]=new {} } };
            OperatorConditionalRequestContracts.ApplyScheduleFragments(root);
            using var document=JsonDocument.Parse(JsonSerializer.Serialize(root));
            var value=document.RootElement; var legacy=value.GetProperty("oneOf")[0]; var combined=value.GetProperty("oneOf")[1];
            Assert.False(value.GetProperty("additionalProperties").GetBoolean());
            Assert.True(legacy.GetProperty("properties").TryGetProperty("query",out _));
            Assert.False(legacy.GetProperty("properties").TryGetProperty("combinedField",out _));
            Assert.False(combined.GetProperty("additionalProperties").GetBoolean());
            Assert.Equal(new[]{"scheduleId","combinedField"},combined.GetProperty("required").EnumerateArray().Select(p=>p.GetString()));
            Assert.False(combined.GetProperty("properties").TryGetProperty("query",out _));
            var fields=combined.GetProperty("properties").GetProperty("combinedField").GetProperty("properties").GetProperty("sourceFieldIds");
            Assert.True(fields.GetProperty("uniqueItems").GetBoolean()); Assert.Equal(8,fields.GetProperty("maxItems").GetInt32());
        }

        [Fact]
        public void PublishedFilterPropertyDocumentsCanonicalOperatorsWithoutRestrictingAcceptedSpellings()
        {
            var op = new Dictionary<string, object>
            {
                ["oneOf"] = new[] { new { type = "null" }, new { type = "string" } }
            };
            var filterArray = new Dictionary<string, object>
            {
                ["type"] = "array",
                ["items"] = new Dictionary<string, object>
                {
                    ["properties"] = new Dictionary<string, object> { ["op"] = op }
                }
            };
            var root = new Dictionary<string, object>
            {
                ["properties"] = new Dictionary<string, object>
                {
                    ["filters"] = new Dictionary<string, object>
                    {
                        ["oneOf"] = new object[] { new { type = "null" }, filterArray }
                    },
                    ["combinedField"] = new { }
                }
            };
            OperatorConditionalRequestContracts.ApplyScheduleFragments(root);
            using var doc = JsonDocument.Parse(JsonSerializer.Serialize(root));
            JsonElement FilterOperator(JsonElement schema) => schema.GetProperty("properties")
                .GetProperty("filters").GetProperty("oneOf")[1].GetProperty("items")
                .GetProperty("properties").GetProperty("op");
            var property = FilterOperator(doc.RootElement);
            var guidance = property.GetProperty("description").GetString();
            Assert.Contains("equals, not_equals, contains, not_contains, begins_with, ends_with, has_value, has_no_value", guidance);
            Assert.Contains("Omit for equals", guidance);
            Assert.False(property.TryGetProperty("enum", out _));
            Assert.Equal("null", property.GetProperty("oneOf")[0].GetProperty("type").GetString());
            Assert.Equal("string", property.GetProperty("oneOf")[1].GetProperty("type").GetString());
            Assert.Equal(property.GetRawText(), FilterOperator(doc.RootElement.GetProperty("oneOf")[0]).GetRawText());
        }
    }
}

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
            OperatorConditionalRequestContracts.ApplyScheduleCombinedFragment(root);
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
    }
}

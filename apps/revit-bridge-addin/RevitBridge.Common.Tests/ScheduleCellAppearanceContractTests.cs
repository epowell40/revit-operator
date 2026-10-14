using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ScheduleCellAppearanceContractTests
    {
        [Theory]
        [InlineData("{\"scheduleId\":41,\"cellStyles\":[{\"section\":\"body\",\"row\":4,\"column\":5,\"expectedText\":\"0 VA\",\"backgroundColorRgb\":[255,255,255]}]}", true)]
        [InlineData("{\"action\":\"cell_styles\",\"scheduleId\":41,\"cells\":[{\"section\":\"Header\",\"row\":0,\"column\":0}]}", false)]
        [InlineData("{\"scheduleId\":41,\"cellStyles\":[{\"section\":\"Body\",\"row\":4,\"column\":5,\"expectedText\":\"\",\"backgroundColorRgb\":[12,34,56]}],\"dryRun\":false}", true)]
        public void ExactBackgroundAndReadLocatorsValidate(string json, bool editing)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.True(ScheduleCellAppearanceContract.Validate(doc.RootElement, editing, out var error), error);
        }

        [Theory]
        [InlineData("{\"scheduleId\":true,\"cellStyles\":[]}")]
        [InlineData("{\"scheduleId\":-1,\"cellStyles\":[]}")]
        [InlineData("{\"scheduleId\":41,\"cellStyles\":[]}")]
        [InlineData("{\"scheduleId\":41,\"cellStyles\":[{\"section\":\"Body\",\"row\":4,\"column\":5,\"backgroundColorRgb\":[255,255,255]}]}")]
        [InlineData("{\"scheduleId\":41,\"cellStyles\":[{\"section\":\"None\",\"row\":4,\"column\":5,\"expectedText\":\"0 VA\",\"backgroundColorRgb\":[255,255,255]}]}")]
        [InlineData("{\"scheduleId\":41,\"cellStyles\":[{\"section\":\"Body\",\"row\":4.2,\"column\":5,\"expectedText\":\"0 VA\",\"backgroundColorRgb\":[255,255,255]}]}")]
        [InlineData("{\"scheduleId\":41,\"cellStyles\":[{\"section\":\"Body\",\"row\":4,\"column\":5,\"expectedText\":\"0 VA\",\"backgroundColorRgb\":[256,255,255]}]}")]
        [InlineData("{\"scheduleId\":41,\"cellStyles\":[{\"section\":\"Body\",\"row\":4,\"column\":5,\"expectedText\":\"0 VA\",\"backgroundColorRgb\":[255,255,255],\"value\":\"99 VA\"}]}")]
        [InlineData("{\"scheduleId\":41,\"cellStyles\":[{\"section\":\"Body\",\"row\":4,\"column\":5,\"expectedText\":\"0 VA\",\"backgroundColorRgb\":[255,255,255]}],\"appearance\":{\"stripedRows\":true}}")]
        public void UnsafeOrMixedEditsRefuseWithoutThrowing(string json)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.False(ScheduleCellAppearanceContract.Validate(doc.RootElement, true, out var error));
            Assert.NotEmpty(error);
        }

        [Fact]
        public void CanonicalAliasesStillRejectDuplicateCellsAndBoundWholeBatches()
        {
            var one="{\"section\":\"Body\",\"row\":4,\"column\":5,\"expectedText\":\"0 VA\",\"backgroundColorRgb\":[255,255,255]}";
            using var duplicate=JsonDocument.Parse("{\"scheduleId\":41,\"cellStyles\":["+one+","+one.Replace("Body","body")+"]}");
            Assert.False(ScheduleCellAppearanceContract.Validate(duplicate.RootElement,true,out _));
            using var oversized=JsonDocument.Parse("{\"scheduleId\":41,\"cellStyles\":["+string.Join(",",System.Linq.Enumerable.Repeat(one,65))+"]}");
            Assert.False(ScheduleCellAppearanceContract.Validate(oversized.RootElement,true,out _));
        }
    }
}

using System.Text.Json;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class ScheduleWidthPreservationContractTests
    {
        [Theory]
        [InlineData("{\"scheduleId\":41,\"columnWidths\":[{\"field\":\"Number\",\"widthFeet\":0.09375}]}", true)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Number\",\"widthFeet\":0.09375}],\"dryRun\":false}", true)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Number\",\"widthFeet\":0.1,\"heading\":\"New\"}]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Number\",\"hidden\":true}]}", false)]
        [InlineData("{\"scheduleId\":41,\"columnWidths\":[{\"field\":\"Number\",\"widthFeet\":0.1}],\"fieldOrder\":[0]}", false)]
        [InlineData("{\"scheduleId\":41,\"columnWidths\":[{\"field\":\"Number\",\"widthFeet\":0.1}],\"filters\":[]}", false)]
        [InlineData("{\"scheduleId\":41,\"columnWidths\":[{\"field\":\"Number\",\"widthFeet\":0}]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Number\",\"widthFeet\":0.1}],\"dryRun\":true}", false)]
        [InlineData("{\"scheduleId\":41,\"columnWidths\":[{\"field\":\"Number\",\"widthFeet\":0.1}],\"dryRun\":true}", false)]
        [InlineData("null", false)]
        public void OnlyWidthChangesHaveUnchangedTargetContentObligations(string json, bool expected)
        {
            using var document = JsonDocument.Parse(json);
            Assert.Equal(expected, ScheduleWidthPreservationContract.IsWidthOnlyEdit(document.RootElement));
        }
    }
}

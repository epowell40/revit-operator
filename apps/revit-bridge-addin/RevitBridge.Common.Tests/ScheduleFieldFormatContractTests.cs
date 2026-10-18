using System.Text.Json;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class ScheduleFieldFormatContractTests
    {
        [Theory]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Description\",\"heading\":\"DESCRIPTION\",\"widthFeet\":0.3,\"horizontalAlignment\":\"center\"},{\"field\":\"Count\",\"hidden\":true}]}", true)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Description\",\"heading\":\"\",\"headingOrientation\":\"Vertical\"}],\"dryRun\":false}", true)]
        [InlineData("{\"scheduleId\":true,\"fieldFormats\":[{\"field\":\"Count\",\"hidden\":true}]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Count\"}]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Count\",\"hidden\":null}]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Count\",\"hidden\":true},{\"field\":\" count \",\"hidden\":false}]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Count\",\"widthFeet\":0}]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Count\",\"heading\":null}]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Count\",\"horizontalAlignment\":\"diagonal\"}]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Count\",\"textColorRgb\":[0,0,0]}]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Count\",\"hidden\":true}],\"filters\":[]}", false)]
        [InlineData("{\"scheduleId\":41,\"fieldFormats\":[{\"field\":\"Count\",\"hidden\":true}],\"dryRun\":true}", false)]
        public void OnlyBoundedNonstructuralFormatEditsReceiveDefinitionCensus(string json, bool expected)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(expected, ScheduleFieldFormatContract.IsBoundedEdit(doc.RootElement));
            Assert.Equal(expected, SchedulePresentationContract.IsBoundedPresentationEdit(doc.RootElement));
        }
    }
}

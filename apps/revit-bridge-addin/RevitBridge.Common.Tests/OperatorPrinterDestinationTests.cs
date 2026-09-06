using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorPrinterDestinationTests
    {
        [Theory]
        [InlineData("PORTPROMPT:", "interactive_printer_destination")]
        [InlineData(" portprompt: ", "interactive_printer_destination")]
        [InlineData("IP_192.0.2.1,PORTPROMPT:", "interactive_printer_destination")]
        [InlineData(null, "printer_capability_unavailable")]
        [InlineData("", "printer_capability_unavailable")]
        [InlineData(" ", "printer_capability_unavailable")]
        [InlineData("IP_192.0.2.1", null)]
        [InlineData("USB001", null)]
        [InlineData("PORTPROMPT:renamed", null)]
        public void SpoolerPortCapabilityDoesNotDependOnPrinterDisplayName(string? ports, string? reason)
            => Assert.Equal(reason, OperatorPrinterDestination.BlockingReason(ports));
    }
}

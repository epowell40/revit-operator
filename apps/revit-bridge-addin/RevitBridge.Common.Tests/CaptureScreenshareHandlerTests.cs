using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class CaptureScreenshareHandlerTests
    {
        [Theory]
        [InlineData(false, true, "revit_window")]
        [InlineData(false, false, "active_view_export")]
        [InlineData(true, true, "active_view_export")]
        [InlineData(true, false, "active_view_export")]
        public void Capture_mode_prefers_renderable_window_and_falls_back_for_background_hosts(
            bool minimized,
            bool windowCaptureSucceeded,
            string expected)
        {
            Assert.Equal(expected, CaptureScreensharePolicy.SelectCaptureMode(minimized, windowCaptureSucceeded));
        }
    }
}

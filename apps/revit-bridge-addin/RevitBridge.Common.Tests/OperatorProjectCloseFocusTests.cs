using System;
using System.Collections.Generic;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorProjectCloseFocusTests
    {
        [Fact]
        public void ActiveDrawingWithBrowserFocusDoesNotInvokeTemporarilyDisabledActiveViewSetter()
        {
            var calls = new List<string>();
            OperatorProjectCloseFocus.PrepareAndPost("DrawingSheet",
                () => OperatorProjectCloseFocus.RestoreDrawingFocus(true,
                    () => throw new InvalidOperationException("Setting active view is temporarily disabled."),
                    () => calls.Add("keyboard-focus")),
                () => calls.Add("post"));
            Assert.Equal(new[] { "keyboard-focus", "post" }, calls);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void DifferentDrawingRequiresActivationBeforeFocusOrPosting(bool activationFails)
        {
            var calls = new List<string>();
            Action close = () => OperatorProjectCloseFocus.PrepareAndPost("ProjectBrowser",
                () => OperatorProjectCloseFocus.RestoreDrawingFocus(false,
                    () => { calls.Add("activate"); if (activationFails) throw new InvalidOperationException("Unavailable."); },
                    () => calls.Add("keyboard-focus")),
                () => calls.Add("post"));
            if (activationFails) Assert.Throws<InvalidOperationException>(close);
            else close();
            Assert.Equal(activationFails ? new[] { "activate" } : new[] { "activate", "keyboard-focus", "post" }, calls);
        }

        [Theory]
        [InlineData("ProjectBrowser")]
        [InlineData("SystemBrowser")]
        public void BrowserFocusIsRestoredBeforePostingExactlyOneClose(string viewType)
        {
            var calls = new List<string>();
            Assert.True(OperatorProjectCloseFocus.PrepareAndPost(viewType,
                () => calls.Add("restore"), () => calls.Add("post")));
            Assert.Equal(new[] { "restore", "post" }, calls);
        }

        [Theory]
        [InlineData("FloorPlan")]
        [InlineData("DrawingSheet")]
        [InlineData("Schedule")]
        [InlineData("ThreeD")]
        public void GraphicalActiveViewDoesNotProveKeyboardFocusAndMustRestoreBeforePosting(string viewType)
        {
            var calls = new List<string>();
            Assert.True(OperatorProjectCloseFocus.PrepareAndPost(viewType,
                () => calls.Add("restore"), () => calls.Add("post")));
            Assert.Equal(new[] { "restore", "post" }, calls);
        }

        [Theory]
        [InlineData("ProjectBrowser")]
        [InlineData("DrawingSheet")]
        public void MissingOrUnavailableGraphicalViewCannotFallThroughToClose(string viewType)
        {
            var posted = false;
            Assert.Throws<InvalidOperationException>(() => OperatorProjectCloseFocus.PrepareAndPost(
                viewType, () => throw new InvalidOperationException("No graphical view is available."),
                () => posted = true));
            Assert.False(posted);
        }

        [Fact]
        public void RejectedCloseIsNotRetriedOrReportedAsPosted()
        {
            var posts = 0;
            Assert.Throws<InvalidOperationException>(() => OperatorProjectCloseFocus.PrepareAndPost(
                "SystemBrowser", () => { }, () => { posts++; throw new InvalidOperationException("Cannot post."); }));
            Assert.Equal(1, posts);
        }
    }
}

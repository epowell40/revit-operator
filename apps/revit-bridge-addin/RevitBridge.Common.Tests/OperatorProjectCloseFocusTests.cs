using System;
using System.Collections.Generic;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorProjectCloseFocusTests
    {
        [Fact]
        public void DrawingFocusMustBeVerifiedBeforeArmingDiscardAndPosting()
        {
            var calls = new List<string>();
            OperatorProjectCloseFocus.PrepareAndPost("ProjectBrowser",
                () => calls.Add("keyboard-focus-verified"),
                () => { calls.Add("discard-guard"); calls.Add("post"); });
            Assert.Equal(new[] { "keyboard-focus-verified", "discard-guard", "post" }, calls);
            calls.Clear();
            Assert.Throws<InvalidOperationException>(() => OperatorProjectCloseFocus.PrepareAndPost("ProjectBrowser",
                () => throw new InvalidOperationException("Drawing focus verification failed."),
                () => { calls.Add("discard-guard"); calls.Add("post"); }));
            Assert.Empty(calls);
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

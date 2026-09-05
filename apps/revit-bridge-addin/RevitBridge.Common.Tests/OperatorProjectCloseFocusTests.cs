using System;
using System.Collections.Generic;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorProjectCloseFocusTests
    {
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
        public void OrdinaryViewsKeepTheirFocusAndPostExactlyOnce(string viewType)
        {
            var posts = 0;
            Assert.False(OperatorProjectCloseFocus.PrepareAndPost(viewType,
                () => throw new Exception("An ordinary view must not be changed."), () => posts++));
            Assert.Equal(1, posts);
        }

        [Fact]
        public void MissingOrUnavailableGraphicalViewCannotFallThroughToClose()
        {
            var posted = false;
            Assert.Throws<InvalidOperationException>(() => OperatorProjectCloseFocus.PrepareAndPost(
                "ProjectBrowser", () => throw new InvalidOperationException("No graphical view is available."),
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

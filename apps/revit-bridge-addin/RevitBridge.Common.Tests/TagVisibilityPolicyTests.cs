using RevitBridge.Common.Annotation;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TagVisibilityPolicyTests
    {
        [Fact]
        public void UsesTemplateAsVisibilityOwner()
        {
            var result = TagVisibilityPolicy.Decide(true, false, 10, 20, true, true);
            Assert.Equal(20, result.OwnerViewId);
            Assert.Equal("view_template", result.OwnerKind);
            Assert.True(result.ApplyChange);
        }

        [Fact]
        public void DryRunReportsWithoutApplying()
        {
            var result = TagVisibilityPolicy.Decide(true, true, 10, null, true, true);
            Assert.Equal("would_show", result.Status);
            Assert.True(result.WouldChange);
            Assert.False(result.ApplyChange);
        }

        [Fact]
        public void AlreadyVisibleIsNoOp()
        {
            var result = TagVisibilityPolicy.Decide(true, false, 10, null, true, false);
            Assert.Equal("already_visible", result.Status);
            Assert.False(result.WouldChange);
        }

        [Fact]
        public void UnsupportedCategoryFailsClosed()
        {
            var result = TagVisibilityPolicy.Decide(true, false, 10, null, false, true);
            Assert.Equal("unsupported", result.Status);
            Assert.False(result.ApplyChange);
        }
    }
}

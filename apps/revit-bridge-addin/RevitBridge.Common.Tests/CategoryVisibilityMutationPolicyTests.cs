using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class CategoryVisibilityMutationPolicyTests
    {
        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void Hideable_category_applies_requested_visibility(bool hideRequested)
        {
            Assert.Equal(
                CategoryVisibilityMutationDisposition.Apply,
                CategoryVisibilityMutationPolicy.Decide(hideRequested, canCategoryBeHidden: true));
        }

        [Fact]
        public void Showing_nonhideable_category_is_an_already_visible_noop()
        {
            Assert.Equal(
                CategoryVisibilityMutationDisposition.AlreadyVisible,
                CategoryVisibilityMutationPolicy.Decide(hideRequested: false, canCategoryBeHidden: false));
        }

        [Fact]
        public void Hiding_nonhideable_category_remains_unsupported()
        {
            Assert.Equal(
                CategoryVisibilityMutationDisposition.CannotHide,
                CategoryVisibilityMutationPolicy.Decide(hideRequested: true, canCategoryBeHidden: false));
        }
    }
}

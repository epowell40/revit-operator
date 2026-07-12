using RevitBridge.Common.Annotation;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TagWorkPolicyTests
    {
        [Fact]
        public void ApplyWithNoUntaggedWorkDoesNotResolveFamily()
        {
            Assert.False(TagWorkPolicy.RequiresFamilyResolution(dryRun: false, plannedToTag: 0));
        }

        [Fact]
        public void DryRunMayInspectFamilyEvenWhenNothingWouldBeTagged()
        {
            Assert.True(TagWorkPolicy.RequiresFamilyResolution(dryRun: true, plannedToTag: 0));
        }

        [Fact]
        public void ApplyWithPendingWorkResolvesFamily()
        {
            Assert.True(TagWorkPolicy.RequiresFamilyResolution(dryRun: false, plannedToTag: 1));
        }

        [Theory]
        [InlineData(false, false, false, true)]
        [InlineData(true, false, false, false)]
        [InlineData(true, true, false, false)]
        [InlineData(true, true, true, true)]
        public void GeometryAwareTagsRemainOnlyWithMeasuredCollisionFreeReadback(
            bool geometryAware,
            bool hasMeasurableGeometry,
            bool collisionFree,
            bool expected)
        {
            Assert.Equal(expected, TagWorkPolicy.KeepCreatedTag(geometryAware, hasMeasurableGeometry, collisionFree));
        }
    }
}

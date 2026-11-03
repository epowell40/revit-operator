using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryFootprintTests
    {
        [Fact] public void IndependentlyBoundDerivedCenterlineCanBePartOfExactExpectedFootprint()
            // Synthetic contract corresponding to the retained85 extra centerline;
            // the native caller must establish its parent before adding it here.
            => InlineAccessoryFootprint.RequireExpected(new[] { 11L, 12L, 13L }, new[] { 13L, 12L, 11L }, new[] { 10L, 14L },
                Array.Empty<long>(), new[] { 10L, 11L, 12L, 13L, 14L });
        [Fact] public void ExactSplitAndAccessoryWithPreservedOwnersAreEligibleForFurtherChecks()
            => InlineAccessoryFootprint.RequireExpected(new[] { 11L, 12L }, new[] { 12L, 11L }, new[] { 10L, 13L },
                Array.Empty<long>(), new[] { 10L, 11L, 12L, 13L });
        [Fact] public void DependentTagDeletionOrUnexpectedAutoFittingRequiresRollback()
        {
            Assert.Throws<InvalidOperationException>(() => InlineAccessoryFootprint.RequireExpected(new[] { 11L, 12L }, new[] { 11L, 12L },
                new[] { 10L }, new[] { 99L }, new[] { 10L, 11L, 12L }));
            Assert.Throws<InvalidOperationException>(() => InlineAccessoryFootprint.RequireExpected(new[] { 11L, 12L }, new[] { 11L, 12L, 13L },
                new[] { 10L }, Array.Empty<long>(), new[] { 10L, 11L, 12L }));
        }
        [Theory]
        [InlineData(99)] // unrelated owner
        [InlineData(0)]
        [InlineData(-1)]
        public void UnknownOrInvalidModifiedOwnerCannotBeIgnored(long owner)
            => Assert.Throws<InvalidOperationException>(() => InlineAccessoryFootprint.RequireExpected(new[] { 11L, 12L }, new[] { 11L, 12L },
                new[] { owner }, Array.Empty<long>(), new[] { 10L, 11L, 12L }));
        [Fact] public void DuplicateMissingOrExtraCreatedIdentitiesCannotPass()
        {
            foreach (var added in new[] { new[] { 11L, 11L }, new[] { 11L }, Array.Empty<long>() })
                Assert.Throws<InvalidOperationException>(() => InlineAccessoryFootprint.RequireExpected(new[] { 11L, 12L }, added,
                    new[] { 10L }, Array.Empty<long>(), new[] { 10L, 11L, 12L }));
        }
    }
}

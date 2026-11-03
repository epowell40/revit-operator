using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class CadGeometryPageWindowTests
    {
        [Fact]
        public void PagesRemainContiguousWithoutSplittingOrSkippingAnExpensiveCurve()
        {
            var page = new CadGeometryPageWindow(1, new CadGeometryReadBudget(4));
            Assert.False(page.Observe(100)); // Fully traversed but belongs to an earlier page.
            Assert.True(page.Observe(2));
            Assert.False(page.Observe(3));
            Assert.False(page.Observe(1)); // Must not skip the preceding whole curve.
            Assert.Equal(4, page.TotalCount); Assert.Equal(1, page.ReturnedCount);
            Assert.Equal(2, page.NextOffset); Assert.True(page.IsValidCompletePage);
            var next = new CadGeometryPageWindow(page.NextOffset!.Value, new CadGeometryReadBudget(4));
            Assert.False(next.Observe(100)); Assert.False(next.Observe(2));
            Assert.True(next.Observe(3)); Assert.True(next.Observe(1));
            Assert.Null(next.NextOffset); Assert.True(next.IsValidCompletePage);
        }
        [Fact]
        public void TooSmallBudgetCannotClaimAnEmptySuccessfulPageOrAdvancePastACurve()
        {
            var page = new CadGeometryPageWindow(0, new CadGeometryReadBudget(1));
            Assert.False(page.Observe(16)); Assert.False(page.IsValidCompletePage);
            Assert.Equal(0, page.NextOffset); Assert.Equal(0, page.ReturnedCount);
        }
        [Fact]
        public void OffsetBeyondCompleteInventoryCannotLookLikeAnEmptyValidResult()
        {
            var page = new CadGeometryPageWindow(2, new CadGeometryReadBudget(1));
            Assert.False(page.Observe(1)); Assert.False(page.IsValidCompletePage);
        }
        [Theory]
        [InlineData(-1)] [InlineData(20001)]
        public void UnboundedOffsetsRejectBeforeTraversal(int offset)
            => Assert.Throws<ArgumentOutOfRangeException>(() => new CadGeometryPageWindow(offset, new CadGeometryReadBudget(1)));
        [Theory]
        [InlineData(0)] [InlineData(-1)] [InlineData(1001)]
        public void APrimitiveCannotEscapeTheCompleteRecordBound(int cost)
            => Assert.Throws<ArgumentOutOfRangeException>(() => new CadGeometryPageWindow(0, new CadGeometryReadBudget(1000)).Observe(cost));
        [Fact]
        public void WholeImportTraversalStaysBoundedEvenWhenNoOutputIsRequestedYet()
        {
            var page = new CadGeometryPageWindow(20000, new CadGeometryReadBudget(1));
            for (int i = 0; i < 100; i++) Assert.False(page.Observe(1000));
            Assert.Throws<InvalidOperationException>(() => page.Observe(1));
            var count = new CadGeometryPageWindow(20000, new CadGeometryReadBudget(1));
            for (int i = 0; i < 20000; i++) Assert.False(count.Observe(1));
            Assert.Throws<InvalidOperationException>(() => count.Observe(1));
        }
    }
}

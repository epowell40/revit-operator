using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class CadGeometryReadBudgetTests
    {
        [Fact]
        public void SharedBudgetCannotBeResetByAnotherInstanceOrOversizedPolyline()
        {
            var budget = new CadGeometryReadBudget(4);
            Assert.True(budget.TryConsume(1));
            Assert.False(budget.TryConsume(4));
            Assert.Equal(3, budget.Remaining);
            Assert.True(budget.TryConsume(3));
            Assert.False(budget.TryConsume(1));
            Assert.Equal(0, budget.Remaining);
        }
        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(1001)]
        public void InvalidBudgetsFailBeforeNativeTraversal(int limit)
            => Assert.Throws<ArgumentOutOfRangeException>(() => new CadGeometryReadBudget(limit));
        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        public void InvalidCostsCannotIncreaseBudget(int cost)
            => Assert.Throws<ArgumentOutOfRangeException>(() => new CadGeometryReadBudget(null).TryConsume(cost));
    }
}

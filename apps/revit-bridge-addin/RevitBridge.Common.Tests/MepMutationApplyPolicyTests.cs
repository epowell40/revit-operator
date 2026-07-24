using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepMutationApplyPolicyTests
    {
        [Fact]
        public void ExplicitApplyPairAllowsMutation()
        {
            Assert.True(MepMutationApplyPolicy.ResolveShouldApply(apply: true, dryRun: false));
        }

        [Fact]
        public void DefaultDryRunPairDoesNotMutate()
        {
            Assert.False(MepMutationApplyPolicy.ResolveShouldApply(apply: false, dryRun: true));
        }

        [Theory]
        [InlineData(false, false)]
        [InlineData(true, true)]
        public void ContradictoryPairsFailClosed(bool apply, bool dryRun)
        {
            var error = Assert.Throws<ArgumentException>(() =>
                MepMutationApplyPolicy.ResolveShouldApply(apply, dryRun));

            Assert.Contains("contradictory", error.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}

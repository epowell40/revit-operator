using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class AbsolutePlacementCorrectionTests
    {
        [Fact]
        public void WholeAreaHruReplayRemovesObservedDoubleLevelElevation()
        {
            var requested = new[] { -37.78, -5.05, 42.32152230971508 };
            var observed = new[] { -37.78, -5.05, 74.48818897638554 };
            Assert.False(AbsolutePlacementCorrection.Matches(requested, observed));
            var delta = AbsolutePlacementCorrection.Delta(requested, observed);
            Assert.Equal(-32.16666666667046, delta[2], 8);
            Assert.True(AbsolutePlacementCorrection.Matches(requested,
                new[] { observed[0] + delta[0], observed[1] + delta[1], observed[2] + delta[2] }));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-12)]
        [InlineData(100)]
        public void NativeOverloadAlreadyUsingAbsoluteCoordinatesIsNotShifted(double elevation)
        {
            var point = new[] { 3.0, 4.0, elevation };
            Assert.True(AbsolutePlacementCorrection.Matches(point, point));
            Assert.Equal(new[] { 0.0, 0.0, 0.0 }, AbsolutePlacementCorrection.Delta(point, point));
        }

        [Fact]
        public void ConstraintThatPreventsCorrectionCannotBeReportedAsMatching()
        {
            Assert.False(AbsolutePlacementCorrection.Matches(new[] { 3.0, 4.0, 10.0 }, new[] { 3.0, 4.0, 42.0 }));
            Assert.Throws<ArgumentException>(() => AbsolutePlacementCorrection.Delta(new[] { double.NaN, 0.0, 0.0 }, new[] { 0.0, 0.0, 0.0 }));
            Assert.Throws<ArgumentException>(() => AbsolutePlacementCorrection.Delta(new[] { 0.0, 0.0, 0.0 }, new[] { 0.0, double.PositiveInfinity, 0.0 }));
        }
    }
}

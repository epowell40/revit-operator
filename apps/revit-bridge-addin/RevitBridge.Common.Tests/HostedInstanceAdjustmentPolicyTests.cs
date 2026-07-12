using System;
using RevitBridge.Common.Spatial;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class HostedInstanceAdjustmentPolicyTests
    {
        [Fact]
        public void ChainageAdjustmentPreservesMountingElevation()
        {
            var result = HostedInstanceAdjustmentPolicy.ResolveTargetElevationFt(
                currentElevationFt: 33.6666666667,
                resolvedTargetElevationFt: 32.1666666667,
                hasExplicitPoint: false);

            Assert.Equal(33.6666666667, result, 9);
        }

        [Fact]
        public void ExplicitPointMayChangeMountingElevation()
        {
            var result = HostedInstanceAdjustmentPolicy.ResolveTargetElevationFt(
                currentElevationFt: 33.6666666667,
                resolvedTargetElevationFt: 36.0,
                hasExplicitPoint: true);

            Assert.Equal(36.0, result, 9);
        }

        [Fact]
        public void LinkedFaceHostsRequireReplacementButOrdinaryWallsDoNot()
        {
            Assert.True(HostedInstanceAdjustmentPolicy.RequiresLinkedFaceReplacement(true, true));
            Assert.False(HostedInstanceAdjustmentPolicy.RequiresLinkedFaceReplacement(true, false));
            Assert.False(HostedInstanceAdjustmentPolicy.RequiresLinkedFaceReplacement(false, true));
        }

        [Fact]
        public void NonFiniteElevationsFailClosed()
        {
            Assert.Throws<ArgumentOutOfRangeException>(() =>
                HostedInstanceAdjustmentPolicy.ResolveTargetElevationFt(double.NaN, 32.0, false));
            Assert.Throws<ArgumentOutOfRangeException>(() =>
                HostedInstanceAdjustmentPolicy.ResolveTargetElevationFt(32.0, double.PositiveInfinity, true));
        }
    }
}

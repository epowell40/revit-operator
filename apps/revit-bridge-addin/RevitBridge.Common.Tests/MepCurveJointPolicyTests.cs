using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepCurveJointPolicyTests
    {
        [Fact]
        public void DirectRoomNativeRightAngleRequiresAnElbow()
        {
            Assert.False(MepCurveJointPolicy.AllowsDirectConnection(new[] {0.0,-1.0,0.0},
                new[] {-0.9999999945604684,-0.00010430274817383116,0.0}));
        }
        [Fact]
        public void OpposingPortsAllowStraightConnectionButSameDirectionDoesNot()
        {
            Assert.True(MepCurveJointPolicy.AllowsDirectConnection(new[] {2.0,0.0,0.0},new[] {-3.0,0.0,0.0}));
            Assert.False(MepCurveJointPolicy.AllowsDirectConnection(new[] {1.0,0.0,0.0},new[] {1.0,0.0,0.0}));
            Assert.False(MepCurveJointPolicy.AllowsDirectConnection(new[] {0.0,0.0,0.0},new[] {-1.0,0.0,0.0}));
            Assert.False(MepCurveJointPolicy.AllowsDirectConnection(new[] {double.NaN,0.0,0.0},new[] {-1.0,0.0,0.0}));
        }
    }
}

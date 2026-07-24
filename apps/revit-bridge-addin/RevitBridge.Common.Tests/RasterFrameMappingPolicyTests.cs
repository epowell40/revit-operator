using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class RasterFrameMappingPolicyTests
    {
        [Fact]
        public void GetRelativeAspectMismatch_ReturnsExpectedMismatchForInvalidCalibration()
        {
            var mismatch = RasterFrameMappingPolicy.GetRelativeAspectMismatch(0.791203, 1.100601);

            Assert.InRange(mismatch, 0.3910, 0.3911);
            Assert.True(mismatch > 0.01);
        }

        [Fact]
        public void GetRelativeAspectMismatch_AllowsMinorRasterRoundingDifference()
        {
            var mismatch = RasterFrameMappingPolicy.GetRelativeAspectMismatch(1.000000, 1.005000);

            Assert.InRange(mismatch, 0.0049, 0.0051);
            Assert.True(mismatch <= 0.01);
        }

        [Fact]
        public void GetRelativeAspectMismatch_FailsClosedWhenCropAspectIsInvalid()
        {
            var mismatch = RasterFrameMappingPolicy.GetRelativeAspectMismatch(0, 1.0);

            Assert.True(double.IsPositiveInfinity(mismatch));
        }
    }
}

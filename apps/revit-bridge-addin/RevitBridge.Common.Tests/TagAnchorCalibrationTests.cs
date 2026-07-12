using System;
using RevitBridge.Common.Annotation;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TagAnchorCalibrationTests
    {
        [Fact]
        public void CorrectsAnchorSoActualBoundsCenterMatchesCandidateCenter()
        {
            var measuredBounds = new TagRect2(10, 6, 14, 12);
            var calibration = TagAnchorCalibration.FromMeasurement(10, 10, measuredBounds);

            Assert.Equal(2, calibration.OffsetX, 9);
            Assert.Equal(-1, calibration.OffsetY, 9);
            Assert.Equal(18, calibration.AnchorXForCenter(20), 9);
            Assert.Equal(31, calibration.AnchorYForCenter(30), 9);
        }

        [Fact]
        public void CenterAnchoredTagRequiresNoCorrection()
        {
            var calibration = TagAnchorCalibration.FromMeasurement(5, 7, new TagRect2(4, 6, 6, 8));
            Assert.Equal(5, calibration.AnchorXForCenter(5), 9);
            Assert.Equal(7, calibration.AnchorYForCenter(7), 9);
        }

        [Fact]
        public void RejectsNonFiniteAnchor()
        {
            Assert.Throws<ArgumentException>(() => TagAnchorCalibration.FromMeasurement(double.NaN, 0, new TagRect2(0, 0, 1, 1)));
        }
    }
}

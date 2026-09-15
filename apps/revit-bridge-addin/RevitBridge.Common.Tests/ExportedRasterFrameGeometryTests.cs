using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class ExportedRasterFrameGeometryTests
    {
        private static readonly double[] Origin = { 0, 0, 32.16666666666667 };
        private static readonly double[] Right = { 1, 0, 0 };
        private static readonly double[] Up = { 0, 1, 0 };

        [Fact]
        public void RetainedSamePixelExportUsesDisplayedOutlineRatherThanShiftedCropCenter()
        {
            // Independently retained outline-plane extent. The prior crop-box
            // export shifted this identical raster by 3.5052156639 feet in X.
            const double left = -123.31686468322523, right = 89.8266420511672;
            const double top = 71.48585540021631, bottom = -47.01832591228737;
            var frame = ExportedRasterFrameGeometry.FromViewOutline(Origin, Right, Up,
                left / 96, bottom / 96, right / 96, top / 96, 96, 2600, 1446);
            Assert.InRange(Math.Abs(frame.TopLeft[0] - left), 0, 1e-9);
            Assert.InRange(Math.Abs(frame.TopRight[0] - right), 0, 1e-9);
            Assert.InRange(Math.Abs(frame.TopLeft[1] - top), 0, 1e-9);
            Assert.Equal(Origin[2], frame.TopLeft[2]);
            Assert.True(Math.Abs(frame.TopLeft[0] - (-119.81164901936643)) > 3.5);
        }

        [Fact]
        public void RotatedElevationBasisAndRasterRoundingPreserveDisplayedPlaneCenterAndHeight()
        {
            var frame = ExportedRasterFrameGeometry.FromViewOutline(new[] { 10.0, 20, 30 }, new[] { 0.0, 1, 0 }, new[] { 0.0, 0, 1 },
                -1, -2, 3, 2, 50, 1001, 501);
            Assert.Equal(new[] { 10.0, -130, 130 }, frame.TopLeft);
            Assert.Equal(new[] { 10.0, 270, 130 }, frame.TopRight);
            Assert.Equal(new[] { 10.0, -130, -70 }, frame.BottomLeft);
            Assert.Equal(new[] { 10.0, -30, 130 }, frame.SourceTopLeft);
            Assert.True(frame.AspectCorrectionApplied);
        }

        [Fact]
        public void UnavailableOrInvalidOutlineNeverFallsBackToASeeminglyValidCropMapping()
        {
            foreach (var invalid in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity })
                Assert.Throws<ArgumentException>(() => ExportedRasterFrameGeometry.FromViewOutline(Origin, Right, Up, invalid, 0, 1, 1, 50, 100, 100));
            Assert.Throws<ArgumentException>(() => ExportedRasterFrameGeometry.FromViewOutline(Origin, Right, Up, 1, 0, 1, 1, 50, 100, 100));
            Assert.Throws<ArgumentException>(() => ExportedRasterFrameGeometry.FromViewOutline(Origin, Right, Up, 0, 0, 1, 1, 0, 100, 100));
            Assert.Throws<ArgumentException>(() => ExportedRasterFrameGeometry.FromViewOutline(Origin, Right, Up, 0, 0, 1, 1, 50, 1, 100));
            Assert.Throws<ArgumentException>(() => ExportedRasterFrameGeometry.FromViewOutline(Origin, Right, Right, 0, 0, 1, 1, 50, 100, 100));
            Assert.Throws<ArgumentException>(() => ExportedRasterFrameGeometry.FromViewOutline(Origin, new[] { 2.0, 0, 0 }, Up, 0, 0, 1, 1, 50, 100, 100));
        }
    }
}

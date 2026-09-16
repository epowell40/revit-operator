using System;
using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class TemporaryAnnotationCropTests
    {
        private sealed class Settings : ITemporaryAnnotationCropSettings
        {
            public bool Supported { get; set; } = true;
            public bool CanActivate { get; set; } = true;
            public bool Active { get; set; }
            public double Left { get; set; } = 1.0 / 12;
            public double Right { get; set; } = 1.0 / 12;
            public double Top { get; set; } = 1.0 / 12;
            private double _bottom = 1.0 / 12;
            public bool IgnoreBottomWrite { get; set; }
            public bool ThrowBottomWrite { get; set; }
            public bool NonFiniteBottomRead { get; set; }
            public double Bottom
            {
                get => NonFiniteBottomRead ? double.NaN : _bottom;
                set { if (ThrowBottomWrite) throw new InvalidOperationException("Native edge is read-only"); if (!IgnoreBottomWrite) _bottom = value; }
            }
        }
        [Theory]
        [InlineData(0, 1.0 / 96)]
        [InlineData(0.001, 1.0 / 96)]
        [InlineData(0.125, 0.125)]
        public void BoundsAllFourEdgesInPaperFeetAndReadsThemBack(double requested, double expected)
        {
            var settings = new Settings(); var warnings = new List<string>();
            Assert.True(TemporaryAnnotationCrop.TryConfigure(settings, requested, warnings));
            Assert.True(settings.Active); Assert.Empty(warnings);
            Assert.Equal(expected, settings.Left); Assert.Equal(expected, settings.Right);
            Assert.Equal(expected, settings.Top); Assert.Equal(expected, settings.Bottom);
        }
        [Fact]
        public void UnsupportedOrInactiveReadOnlyViewsReportFailureWithoutChangingOffsets()
        {
            foreach (var settings in new[] { new Settings { Supported = false }, new Settings { CanActivate = false } })
            {
                var warnings = new List<string>();
                Assert.False(TemporaryAnnotationCrop.TryConfigure(settings, 0, warnings));
                Assert.Single(warnings); Assert.False(settings.Active); Assert.Equal(1.0 / 12, settings.Left);
            }
            Assert.True(TemporaryAnnotationCrop.TryConfigure(new Settings { Active = true, CanActivate = false }, 0, new List<string>()));
        }
        [Fact]
        public void ARejectedOrNonFiniteEdgeNeverReportsSuccessfulCropping()
        {
            foreach (var settings in new[] { new Settings { IgnoreBottomWrite = true }, new Settings { ThrowBottomWrite = true }, new Settings { NonFiniteBottomRead = true } })
            {
                var warnings = new List<string>();
                Assert.False(TemporaryAnnotationCrop.TryConfigure(settings, 0, warnings)); Assert.Single(warnings);
            }
        }
        [Fact]
        public void InvalidMarginIsRejectedBeforeAnySettingChanges()
        {
            foreach (var value in new[] { -1.0, double.NaN, double.PositiveInfinity, double.NegativeInfinity })
            {
                var settings = new Settings(); var warnings = new List<string>();
                Assert.False(TemporaryAnnotationCrop.TryConfigure(settings, value, warnings));
                Assert.False(settings.Active); Assert.Equal(1.0 / 12, settings.Left); Assert.Single(warnings);
            }
        }
    }
}

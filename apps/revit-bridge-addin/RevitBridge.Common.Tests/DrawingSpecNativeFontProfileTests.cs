using System;
using RevitBridge.Logic;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DrawingSpecNativeFontProfileTests
    {
        [Theory]
        [InlineData(1)]
        [InlineData(12)]
        [InlineData(120)]
        public void EmPointsConvertToPhysicalCapHeightAndRoundTrip(double points)
        {
            // A font whose capital M occupies 3/4 em: 12pt -> 9pt cap -> 1/8 inch.
            var profile = new DrawingSpecNativeFontProfile("Synthetic test font", .75);
            Assert.Equal(points / 96, profile.NativeSizeFeet(points) * 12, 12);
            Assert.Equal(points, profile.SourcePoints(profile.NativeSizeFeet(points)), 10);
        }

        [Fact]
        public void InstalledOutlinesAreFontSpecificAndDoNotSilentlySubstitute()
        {
            var times = DrawingSpecNativeFontProfile.Capture("Times New Roman");
            var arial = DrawingSpecNativeFontProfile.Capture("Arial");
            // Independent outline metrics retained with the native calibration; no Revit API needed.
            Assert.Equal(.662109375, times.CapitalMHeightEm, 8);
            Assert.Equal(.7158203125, arial.CapitalMHeightEm, 8);
            Assert.NotEqual(times.NativeSizeFeet(12), arial.NativeSizeFeet(12));
            Assert.Equal(times.Signature, DrawingSpecNativeFontProfile.Capture("Times New Roman").Signature);
            Assert.ThrowsAny<Exception>(() => DrawingSpecNativeFontProfile.Capture("Operator Missing Font 746c6e"));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(double.NaN)]
        [InlineData(double.PositiveInfinity)]
        public void InvalidMeasurementsCannotBecomeNativeTextSizes(double value)
        {
            Assert.Throws<ArgumentException>(() => new DrawingSpecNativeFontProfile("Synthetic", value));
            var profile = new DrawingSpecNativeFontProfile("Synthetic", .75);
            Assert.Throws<ArgumentException>(() => profile.NativeSizeFeet(value));
            Assert.Throws<ArgumentException>(() => profile.SourcePoints(value));
        }
    }
}

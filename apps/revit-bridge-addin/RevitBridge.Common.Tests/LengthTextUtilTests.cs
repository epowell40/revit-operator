using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class EngineeringLengthTextTests
    {
        [Theory]
        [InlineData("1/2 inch", 1.0 / 24.0)]
        [InlineData("1/2\"", 1.0 / 24.0)]
        [InlineData("1 1/2 inch", 1.0 / 8.0)]
        [InlineData("1-1/2 inches", 1.0 / 8.0)]
        [InlineData("3/4 inch", 1.0 / 16.0)]
        [InlineData("18 in", 1.5)]
        [InlineData("2 ft", 2.0)]
        [InlineData("304.8 mm", 1.0)]
        [InlineData("30.48 cm", 1.0)]
        [InlineData("1 m", 1.0 / 0.3048)]
        [InlineData("-1-1/2 inches", -1.0 / 8.0)]
        public void TryParseLengthToFeet_ParsesEngineeringFractions(string text, double expectedFeet)
        {
            Assert.True(EngineeringLengthText.TryParseLengthToFeet(text, unitlessIsInches: true, out var feet));
            Assert.True(Math.Abs(feet - expectedFeet) < 1e-9, $"Expected {expectedFeet}, got {feet}.");
        }

        [Fact]
        public void TryParseLengthToFeet_RejectsZeroDenominator()
        {
            Assert.False(EngineeringLengthText.TryParseLengthToFeet("1/0 inch", unitlessIsInches: true, out _));
        }
    }
}

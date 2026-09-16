using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepDuctProfilePolicyTests
    {
        [Theory]
        [InlineData(null, 1d, 0.8333333333, null, "rectangular")]
        [InlineData(null, null, null, 1d, "round")]
        [InlineData("oval", 1d, 0.5, null, "oval")]
        [InlineData(" Rectangle ", 1d, 1d, null, "rectangular")]
        public void ResolvesOnlyConsistentProfiles(string? shape, double? width, double? height, double? diameter, string expected)
        {
            Assert.Equal(expected, MepDuctProfilePolicy.Resolve(shape, width, height, diameter));
        }

        [Theory]
        [InlineData("round", 1d, 1d, null)]
        [InlineData("rectangular", null, null, 1d)]
        [InlineData("oval", null, null, 1d)]
        [InlineData("square", 1d, 1d, null)]
        [InlineData(null, 1d, null, null)]
        [InlineData(null, null, null, null)]
        [InlineData(null, 1d, 1d, 1d)]
        [InlineData(null, -1d, 1d, null)]
        [InlineData(null, double.NaN, 1d, null)]
        [InlineData(null, null, null, double.PositiveInfinity)]
        public void RejectsInvalidOrConflictingDimensions(string? shape, double? width, double? height, double? diameter)
        {
            Assert.Throws<ArgumentException>(() => MepDuctProfilePolicy.Resolve(shape, width, height, diameter));
        }
    }
}

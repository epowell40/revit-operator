using System;
using RevitBridge.Common.Electrical;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class CircuitMatchPolicyTests
    {
        [Theory]
        [InlineData(null, "none")]
        [InlineData("", "none")]
        [InlineData("NONE", "none")]
        [InlineData(" match_source_system ", "match_source_system")]
        public void NormalizesSupportedModes(string? value, string expected)
        {
            Assert.Equal(expected, CircuitMatchPolicy.NormalizeMode(value));
        }

        [Fact]
        public void RejectsUnsupportedMode()
        {
            Assert.Throws<ArgumentException>(() => CircuitMatchPolicy.NormalizeMode("copy_labels"));
        }

        [Theory]
        [InlineData("PowerCircuit", true)]
        [InlineData("PowerBalanced", true)]
        [InlineData("PowerUnBalanced", true)]
        [InlineData("Data", false)]
        [InlineData(null, false)]
        public void RecognizesOnlyPowerSystems(string? value, bool expected)
        {
            Assert.Equal(expected, CircuitMatchPolicy.IsPowerSystemType(value));
        }

        [Fact]
        public void ExactMembershipRequiresOneMatchingSystem()
        {
            Assert.True(CircuitMatchPolicy.HasExactMembership(42, new long[] { 42 }));
            Assert.False(CircuitMatchPolicy.HasExactMembership(42, Array.Empty<long>()));
            Assert.False(CircuitMatchPolicy.HasExactMembership(42, new long[] { 41 }));
            Assert.False(CircuitMatchPolicy.HasExactMembership(42, new long[] { 42, 43 }));
        }

        [Fact]
        public void FactualDeltaRejectsMissingOrNonFiniteValues()
        {
            Assert.Equal(12.5, CircuitMatchPolicy.FactualDelta(100, 112.5));
            Assert.Null(CircuitMatchPolicy.FactualDelta(null, 112.5));
            Assert.Null(CircuitMatchPolicy.FactualDelta(100, double.NaN));
        }
    }
}

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

        [Theory]
        [InlineData("PowerCircuit", true)]
        [InlineData(" powercircuit ", true)]
        [InlineData("PowerBalanced", false)]
        [InlineData("PowerUnBalanced", false)]
        [InlineData(null, false)]
        public void RecognizesOnlyExactPowerCircuitForNewCircuitCreation(string? value, bool expected)
        {
            Assert.Equal(expected, CircuitMatchPolicy.IsExactPowerCircuitType(value));
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
        public void ExactElementSetIsOrderIndependentAndRejectsMissingExtraOrDuplicateIds()
        {
            Assert.True(CircuitMatchPolicy.HasExactElementSet(
                new long[] { 30, 10, 20 },
                new long[] { 20, 30, 10 }));
            Assert.False(CircuitMatchPolicy.HasExactElementSet(
                new long[] { 10, 20 },
                new long[] { 10 }));
            Assert.False(CircuitMatchPolicy.HasExactElementSet(
                new long[] { 10, 20 },
                new long[] { 10, 20, 30 }));
            Assert.False(CircuitMatchPolicy.HasExactElementSet(
                new long[] { 10, 10 },
                new long[] { 10 }));
            Assert.False(CircuitMatchPolicy.HasExactElementSet(
                Array.Empty<long>(),
                Array.Empty<long>()));
        }

        [Theory]
        [InlineData(null, null, true)]
        [InlineData(null, 42L, false)]
        [InlineData(42L, null, false)]
        [InlineData(42L, 42L, true)]
        [InlineData(42L, 43L, false)]
        [InlineData(0L, 0L, false)]
        public void OptionalElementIdentityRequiresExactRequestedPanel(
            long? expectedElementId,
            long? actualElementId,
            bool expected)
        {
            Assert.Equal(
                expected,
                CircuitMatchPolicy.HasExactOptionalElementIdentity(expectedElementId, actualElementId));
        }

        [Theory]
        [InlineData(null, null, false)]
        [InlineData(0.0, null, true)]
        [InlineData(null, 0.0, true)]
        [InlineData(180.0, 180.0, true)]
        [InlineData(double.NaN, null, false)]
        [InlineData(null, double.PositiveInfinity, false)]
        public void FactualLoadReadbackRequiresAtLeastOneFiniteNativeValue(
            double? trueLoad,
            double? apparentLoad,
            bool expected)
        {
            Assert.Equal(expected, CircuitMatchPolicy.HasFactualLoadReadback(trueLoad, apparentLoad));
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

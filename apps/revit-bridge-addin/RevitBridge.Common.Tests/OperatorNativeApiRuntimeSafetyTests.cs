using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeApiRuntimeSafetyTests
    {
        [Theory]
        [InlineData("hosted", OperatorNativeApiRuntimeSafety.HostedPolicyLockReason)]
        [InlineData(" HOSTED ", OperatorNativeApiRuntimeSafety.HostedPolicyLockReason)]
        [InlineData("production", OperatorNativeApiRuntimeSafety.ProductionPolicyLockReason)]
        [InlineData(" PRODUCTION ", OperatorNativeApiRuntimeSafety.ProductionPolicyLockReason)]
        public void HostedAndProductionModesRequireAnExplicitPolicyLock(string mode, string expectedReason)
        {
            Assert.True(OperatorNativeApiRuntimeSafety.RequiresLockedNonMutatingPolicy(mode));
            Assert.Equal(expectedReason, OperatorNativeApiRuntimeSafety.GetPolicyLockReason(mode));
        }

        [Theory]
        [InlineData("")]
        [InlineData("local")]
        [InlineData("development")]
        [InlineData("self_hosted")]
        public void WorkstationModesRetainExplicitRuntimePolicyControl(string mode)
        {
            Assert.False(OperatorNativeApiRuntimeSafety.RequiresLockedNonMutatingPolicy(mode));
            Assert.Equal("", OperatorNativeApiRuntimeSafety.GetPolicyLockReason(mode));
        }

        [Fact]
        public void MissingModeNormalizesToPublicSafeLocalDefault()
        {
            Assert.Equal("local", OperatorNativeApiRuntimeSafety.NormalizeRuntimeMode(null));
        }

        [Theory]
        [InlineData("hosted", false, "runtime-mode:hosted", OperatorNativeApiRuntimeSafety.HostedPolicyLockReason)]
        [InlineData("hosted", true, "runtime-mode:hosted", OperatorNativeApiRuntimeSafety.HostedPolicyLockReason)]
        [InlineData("production", false, "runtime-mode:production", OperatorNativeApiRuntimeSafety.ProductionPolicyLockReason)]
        [InlineData("production", true, "runtime-mode:production", OperatorNativeApiRuntimeSafety.ProductionPolicyLockReason)]
        public void RuntimeBoundaryOverridesEveryUnsafeConfiguredValue(
            string mode,
            bool configuredLock,
            string expectedSource,
            string expectedReason)
        {
            var configured = new OperatorNativeApiRuntimePolicyState
            {
                Profile = "unrestricted",
                MaxRisk = OperatorActionRisk.High,
                AllowMutating = true,
                BlockFreezeRisk = false,
                Locked = configuredLock,
                LockReason = configuredLock ? "Native API policy is locked by enterprise settings." : "",
                Source = configuredLock ? "enterprise" : "env/default"
            };

            var bounded = OperatorNativeApiRuntimeSafety.ApplyAfterConfiguredOverrides(mode, configured);

            Assert.Equal("balanced", bounded.Profile);
            Assert.Equal(OperatorActionRisk.Medium, bounded.MaxRisk);
            Assert.False(bounded.AllowMutating);
            Assert.True(bounded.BlockFreezeRisk);
            Assert.True(bounded.Locked);
            Assert.Equal(expectedReason, bounded.LockReason);
            Assert.Equal(expectedSource, bounded.Source);
        }

        [Theory]
        [InlineData("local")]
        [InlineData("development")]
        [InlineData("self_hosted")]
        public void WorkstationModesPreserveConfiguredOverrides(string mode)
        {
            var configured = new OperatorNativeApiRuntimePolicyState
            {
                Profile = "unrestricted",
                MaxRisk = OperatorActionRisk.High,
                AllowMutating = true,
                BlockFreezeRisk = false,
                Source = "runtime"
            };

            var actual = OperatorNativeApiRuntimeSafety.ApplyAfterConfiguredOverrides(mode, configured);

            Assert.Same(configured, actual);
            Assert.Equal("unrestricted", actual.Profile);
            Assert.Equal(OperatorActionRisk.High, actual.MaxRisk);
            Assert.True(actual.AllowMutating);
            Assert.False(actual.BlockFreezeRisk);
            Assert.False(actual.Locked);
            Assert.Equal("runtime", actual.Source);
        }
    }
}

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
        [InlineData("prod", OperatorNativeApiRuntimeSafety.UnsupportedRuntimeModePolicyLockReason)]
        [InlineData("preview", OperatorNativeApiRuntimeSafety.UnsupportedRuntimeModePolicyLockReason)]
        public void RemoteAndUnsupportedModesRequireAnExplicitPolicyLock(string mode, string expectedReason)
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

        [Theory]
        [InlineData(null, null, false, "", "runtime")]
        [InlineData("local", "false", false, "", "runtime")]
        [InlineData("development", "0", false, "", "runtime")]
        [InlineData("self_hosted", "off", false, "", "runtime")]
        [InlineData("hosted", "false", true, OperatorNativeApiRuntimeSafety.HostedPolicyLockReason, "runtime-mode:hosted")]
        [InlineData("production", "false", true, OperatorNativeApiRuntimeSafety.ProductionPolicyLockReason, "runtime-mode:production")]
        [InlineData("prod", "false", true, OperatorNativeApiRuntimeSafety.UnsupportedRuntimeModePolicyLockReason, "runtime-mode:unsupported")]
        [InlineData("local", "true", true, OperatorNativeApiRuntimeSafety.HostedFlagPolicyLockReason, "hosted-flag:true")]
        [InlineData("development", "yes", true, OperatorNativeApiRuntimeSafety.HostedFlagPolicyLockReason, "hosted-flag:true")]
        [InlineData("self_hosted", "1", true, OperatorNativeApiRuntimeSafety.HostedFlagPolicyLockReason, "hosted-flag:true")]
        [InlineData("production", "true", true, OperatorNativeApiRuntimeSafety.ProductionPolicyLockReason, "runtime-mode:production")]
        [InlineData("local", "sometimes", true, OperatorNativeApiRuntimeSafety.InvalidHostedFlagPolicyLockReason, "hosted-flag:invalid")]
        [InlineData("hosted", "sometimes", true, OperatorNativeApiRuntimeSafety.InvalidHostedFlagPolicyLockReason, "hosted-flag:invalid")]
        public void RuntimeAndHostedEnvironmentMatrixFailsClosed(
            string? mode,
            string? hostedEnabled,
            bool expectedLocked,
            string expectedReason,
            string expectedSource)
        {
            var configured = CreateUnsafeConfiguredPolicy();

            var actual = OperatorNativeApiRuntimeSafety.ApplyAfterConfiguredOverrides(
                mode,
                hostedEnabled,
                configured);

            Assert.Equal(expectedLocked, actual.Locked);
            Assert.Equal(expectedReason, actual.LockReason);
            Assert.Equal(expectedSource, actual.Source);
            if (expectedLocked)
            {
                Assert.Equal("balanced", actual.Profile);
                Assert.Equal(OperatorActionRisk.Medium, actual.MaxRisk);
                Assert.False(actual.AllowMutating);
                Assert.True(actual.BlockFreezeRisk);
            }
            else
            {
                Assert.Same(configured, actual);
            }
        }

        [Theory]
        [InlineData("true", true)]
        [InlineData(" YES ", true)]
        [InlineData("1", true)]
        [InlineData("on", true)]
        [InlineData("false", false)]
        [InlineData(" NO ", false)]
        [InlineData("0", false)]
        [InlineData("off", false)]
        public void KnownBooleanSpellingsParseStrictly(string raw, bool expected)
        {
            Assert.True(OperatorNativeApiRuntimeSafety.TryParseBoolean(raw, out var actual));
            Assert.Equal(expected, actual);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("sometimes")]
        [InlineData("2")]
        public void MissingOrMalformedBooleanSpellingsAreNotSilentlyAccepted(string? raw)
        {
            Assert.False(OperatorNativeApiRuntimeSafety.TryParseBoolean(raw, out var actual));
            Assert.False(actual);
        }

        [Fact]
        public void RuntimeLockIsAppliedAfterEveryUnsafeConfiguredOverride()
        {
            var configured = CreateUnsafeConfiguredPolicy();

            var actual = OperatorNativeApiRuntimeSafety.ApplyAfterConfiguredOverrides(
                "local",
                "true",
                configured);

            Assert.NotSame(configured, actual);
            Assert.True(actual.Locked);
            Assert.Equal("balanced", actual.Profile);
            Assert.Equal(OperatorActionRisk.Medium, actual.MaxRisk);
            Assert.False(actual.AllowMutating);
            Assert.True(actual.BlockFreezeRisk);
            Assert.Equal(OperatorNativeApiRuntimeSafety.HostedFlagPolicyLockReason, actual.LockReason);
            Assert.Equal("hosted-flag:true", actual.Source);
        }

        private static OperatorNativeApiRuntimePolicyState CreateUnsafeConfiguredPolicy()
        {
            return new OperatorNativeApiRuntimePolicyState
            {
                Profile = "unrestricted",
                MaxRisk = OperatorActionRisk.High,
                AllowMutating = true,
                BlockFreezeRisk = false,
                Locked = false,
                LockReason = "",
                Source = "runtime"
            };
        }
    }
}

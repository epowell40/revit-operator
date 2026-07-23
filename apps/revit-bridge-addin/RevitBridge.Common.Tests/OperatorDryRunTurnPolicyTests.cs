using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorDryRunTurnPolicyTests
    {
        [Theory]
        [InlineData("Take one dry-run action and stop.")]
        [InlineData("Dry run only; do not apply anything.")]
        [InlineData("Preflight only this placement.")]
        [InlineData("Plan only, without applying changes.")]
        public void DetectsExplicitDryRunOnlyIntent(string text)
        {
            Assert.True(OperatorDryRunTurnPolicy.IsDryRunOnlyRequest(text));
        }

        [Theory]
        [InlineData("Dry-run this first, then apply it if valid.")]
        [InlineData("Dry-run only this exact action first, then apply it if native readback passes.")]
        [InlineData("Dry-run that one bounded action, then apply only if native readback passes.")]
        [InlineData("This is a staged write: dry run first and afterwards apply the identical action.")]
        [InlineData("Place the receptacle and verify it.")]
        [InlineData("")]
        public void DoesNotConflateNormalStagedWorkWithDryRunOnly(string text)
        {
            Assert.False(OperatorDryRunTurnPolicy.IsDryRunOnlyRequest(text));
        }

        [Theory]
        [InlineData("{\"dryRun\":true}")]
        [InlineData("{\"dry_run\":true}")]
        [InlineData("{\"apply\":false}")]
        public void AcceptsExplicitDryRunBodies(string body)
        {
            Assert.True(OperatorDryRunTurnPolicy.BodyRequestsDryRun(body));
        }

        [Theory]
        [InlineData("{\"dryRun\":false}")]
        [InlineData("{\"apply\":true}")]
        [InlineData("{}")]
        [InlineData("not-json")]
        public void RejectsApplyingOrAmbiguousBodies(string body)
        {
            Assert.False(OperatorDryRunTurnPolicy.BodyRequestsDryRun(body));
        }
    }
}

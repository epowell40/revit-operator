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

        [Theory]
        [InlineData("POST", "/revit/update-schedule-cell", "{\"dryRun\":true}", true)]
        [InlineData("post", "/REVIT/UPDATE-SCHEDULE-CELL", "{\"apply\":false}", true)]
        [InlineData("POST", "/revit/update-schedule-cell", "{\"apply\":true,\"dryRun\":false}", false)]
        [InlineData("POST", "/revit/delete-elements", "{\"dryRun\":true}", false)]
        [InlineData("GET", "/revit/update-schedule-cell", "{\"dryRun\":true}", false)]
        public void ScheduleCellPreviewOverrideIsNarrow(string method, string path, string body, bool expected)
        {
            Assert.Equal(expected, OperatorDryRunTurnPolicy.IsScheduleCellUpdatePreview(method, path, body));
        }
    }
}

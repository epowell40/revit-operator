using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeMutationScopePolicyTests
    {
        [Fact]
        public void Exact_existing_scope_is_allowed()
        {
            var decision = OperatorNativeMutationScopePolicy.Evaluate(
                addedElementIds: new long[0],
                modifiedElementIds: new long[] { 42 },
                deletedElementIds: new long[0],
                allowedExistingElementIds: new long[] { 42 },
                allowCreate: false,
                maxAffectedElements: 1);

            Assert.True(decision.Allowed);
            Assert.Equal(1, decision.AffectedElementCount);
        }

        [Fact]
        public void Unexpected_cascade_is_rejected()
        {
            var decision = OperatorNativeMutationScopePolicy.Evaluate(
                addedElementIds: new long[0],
                modifiedElementIds: new long[] { 42, 43 },
                deletedElementIds: new long[0],
                allowedExistingElementIds: new long[] { 42 },
                allowCreate: false,
                maxAffectedElements: 4);

            Assert.False(decision.Allowed);
            Assert.Equal("existing_element_out_of_scope", decision.Code);
            Assert.Equal(new long[] { 43 }, decision.UnexpectedExistingElementIds);
        }

        [Fact]
        public void Rollback_can_discover_unexpected_existing_scope_without_weakening_commit_policy()
        {
            var decision = OperatorNativeMutationScopePolicy.Evaluate(
                addedElementIds: new long[0],
                modifiedElementIds: new long[] { 42, 43 },
                deletedElementIds: new long[0],
                allowedExistingElementIds: new long[] { 42 },
                allowCreate: false,
                maxAffectedElements: 2,
                allowUnexpectedExistingForRollback: true);

            Assert.True(decision.Allowed);
            Assert.False(decision.ExistingScopeMatched);
            Assert.Equal("rollback_scope_discovered", decision.Code);
            Assert.Equal(new long[] { 43 }, decision.UnexpectedExistingElementIds);
        }

        [Fact]
        public void Creation_requires_explicit_permission()
        {
            var decision = OperatorNativeMutationScopePolicy.Evaluate(
                addedElementIds: new long[] { 100 },
                modifiedElementIds: new long[] { 100 },
                deletedElementIds: new long[0],
                allowedExistingElementIds: new long[0],
                allowCreate: false,
                maxAffectedElements: 1);

            Assert.False(decision.Allowed);
            Assert.Equal("creation_not_allowed", decision.Code);
            Assert.Empty(decision.ModifiedElementIds);
        }

        [Fact]
        public void Affected_element_cap_fails_closed_before_scope_details()
        {
            var decision = OperatorNativeMutationScopePolicy.Evaluate(
                addedElementIds: new long[] { 100, 101 },
                modifiedElementIds: new long[] { 42 },
                deletedElementIds: new long[0],
                allowedExistingElementIds: new long[] { 42 },
                allowCreate: true,
                maxAffectedElements: 2);

            Assert.False(decision.Allowed);
            Assert.Equal("affected_element_cap_exceeded", decision.Code);
            Assert.Equal(3, decision.AffectedElementCount);
        }

        [Fact]
        public void Allowed_creation_and_existing_scope_deduplicate_receipts()
        {
            var decision = OperatorNativeMutationScopePolicy.Evaluate(
                addedElementIds: new long[] { 100, 100 },
                modifiedElementIds: new long[] { 42, 100, 42 },
                deletedElementIds: new long[0],
                allowedExistingElementIds: new long[] { 42, 42 },
                allowCreate: true,
                maxAffectedElements: 2);

            Assert.True(decision.Allowed);
            Assert.Equal(new long[] { 100 }, decision.AddedElementIds);
            Assert.Equal(new long[] { 42 }, decision.ModifiedElementIds);
            Assert.Equal(2, decision.AffectedElementCount);
        }
    }
}

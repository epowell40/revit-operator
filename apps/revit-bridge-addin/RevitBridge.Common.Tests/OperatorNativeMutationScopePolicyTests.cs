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
            Assert.Contains("requires verified failure-processing rollback", decision.Error);
            Assert.DoesNotContain("was rolled back", decision.Error);
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
            Assert.Contains("requires verified failure-processing rollback", decision.Error);
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
            Assert.Contains("requires verified failure-processing rollback", decision.Error);
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

        [Fact]
        public void Pretransaction_baseline_distinguishes_deleted_transient_from_existing_collateral()
        {
            var decision = OperatorNativeMutationScopePolicy.Evaluate(
                new long[] { 1542918 }, new long[] { 101014, 669230, 1321945, 1410864 },
                new long[] { 1542917 }, new long[] { 1365188 }, true, 32,
                preexistingElementIds: new long[] { 101014, 669230, 1321945, 1365188, 1410864 });
            Assert.False(decision.Allowed);
            Assert.Equal(new long[] { 101014, 669230, 1321945, 1410864 }, decision.UnexpectedExistingElementIds);
            Assert.Equal(new long[] { 1542917, 1542918 }, decision.AddedElementIds);
            Assert.Equal(6, decision.AffectedElementCount);
        }

        [Theory]
        [InlineData(false, 2, "creation_not_allowed")]
        [InlineData(true, 1, "affected_element_cap_exceeded")]
        public void Inferred_creation_still_obeys_permission_and_cap(bool allowCreate, int cap, string code)
        {
            var d = OperatorNativeMutationScopePolicy.Evaluate(new long[0], new long[] { 10 },
                new long[] { 11 }, new long[0], allowCreate, cap, preexistingElementIds: new long[] { 42 });
            Assert.False(d.Allowed);
            Assert.Equal(code, d.Code);
        }

        [Fact]
        public void Added_event_cannot_hide_preexisting_element_from_scope_authorization()
        {
            var d = OperatorNativeMutationScopePolicy.Evaluate(new long[] { 42 }, new long[0],
                new long[0], new long[0], true, 4, preexistingElementIds: new long[] { 42 });
            Assert.False(d.Allowed);
            Assert.Equal(new long[] { 42 }, d.UnexpectedExistingElementIds);
        }

        [Fact]
        public void Newly_created_modified_copy_is_not_existing_collateral()
        {
            var d = OperatorNativeMutationScopePolicy.Evaluate(new long[0], new long[] { 1542920 },
                new long[0], new long[] { 1542919 }, true, 4, preexistingElementIds: new long[] { 1542919 });
            Assert.True(d.Allowed);
            Assert.Equal(new long[] { 1542920 }, d.AddedElementIds);
            Assert.Empty(d.UnexpectedExistingElementIds);
        }
    }
}

using System;
using System.Collections.Generic;
using RevitBridge.Common;
using RevitBridge.Common.Electrical;
using RevitBridge.Logic.Handlers;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class CircuitMoveCreateRequestBoundaryTests
    {
        [Theory]
        [InlineData(0, 40, 2, 21, false)]
        [InlineData(30, 0, 2, 21, false)]
        [InlineData(30, 40, 0, 21, false)]
        [InlineData(30, 40, 2, 0, false)]
        [InlineData(30, 40, 2, 21, true)]
        public void InvalidOrMixedMoveIsProvenNotStarted(long system, long panel, int slot, long member, bool mixed)
            => AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitMoveRequest(system, panel, slot, new[] { member }, mixed));

        [Fact]
        public void MoveRequiresExactExplicitPanelSlotAndMemberScope()
        {
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitMoveRequest(30, null, 2, new long[] { 21 }, false));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitMoveRequest(30, 40, null, new long[] { 21 }, false));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitMoveRequest(30, 40, 2, Array.Empty<long>(), false));
        }

        [Fact]
        public void CreateRejectsAmbiguousOrInvalidNativeRequestsBeforeEntry()
        {
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitCreateRequest(Array.Empty<long>(), null, null, null, null, false));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitCreateRequest(new long[] { 0 }, null, null, null, null, false));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitCreateRequest(new long[] { 21 }, 0, null, null, null, false));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitCreateRequest(new long[] { 21 }, null, 2, null, null, false));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitCreateRequest(new long[] { 21 }, 40, 0, null, null, false));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitCreateRequest(new long[] { 21 }, null, null, null, "2", false));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitCreateRequest(new long[] { 21, 22 }, null, null, 0, null, false));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitCreateRequest(new long[] { 21 }, null, null, -1, null, false));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireCircuitCreateRequest(new long[] { 21 }, null, null, null, null, true));
        }

        [Fact]
        public void ZeroBasedNativeConnectorIdAndMultiMemberCreateAreAdmittedWithoutInventingPanelOrSlot()
        {
            CircuitMatchPolicy.RequireCircuitCreateRequest(new long[] { 21 }, null, null, 0, null, false);
            CircuitMatchPolicy.RequireCircuitCreateRequest(new long[] { 21, 22 }, null, null, null, null, false);
            CircuitMatchPolicy.RequireCircuitMoveRequest(30, 40, 2, new long[] { 21, 22 }, false);
        }

        [Fact]
        public void AssignmentCannotSilentlyBecomeLabelWorkOrAcceptMultipleModes()
        {
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireNativeAssignmentMode(null, null, null, false, null, null));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireNativeAssignmentMode(20, 30, null, false, null, null));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireNativeAssignmentMode(20, null, "PowerCircuit", false, null, null));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireNativeAssignmentMode(null, null, "Data", false, null, null));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireNativeAssignmentMode(20, null, null, true, null, null));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireNativeAssignmentMode(null, null, null, true, "P1", "2"));
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireNativeAssignmentMode(20, null, null, false, "P1", "2"));
            CircuitMatchPolicy.RequireNativeAssignmentMode(20, null, null, false, null, null);
            CircuitMatchPolicy.RequireNativeAssignmentMode(null, 30, null, false, null, null);
            CircuitMatchPolicy.RequireNativeAssignmentMode(null, null, "PowerCircuit", false, null, null);
        }

        [Fact]
        public void BatchRejectsDuplicateOrOversizedMembersBeforeEntry()
        {
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireNativeMemberBatch(new long[] { 21, 21 }));
            var oversized = new long[101];
            for (int index = 0; index < oversized.Length; index++) oversized[index] = index + 1;
            AssertNoNativeEntry(() => CircuitMatchPolicy.RequireNativeMemberBatch(oversized));
            CircuitMatchPolicy.RequireNativeMemberBatch(new long[] { 21, 22 });
        }

        private static void AssertNoNativeEntry(Action validate)
        {
            int nativeEntries = 0;
            var result = NativeMutationPreflightBoundary.Execute(enter =>
            {
                validate(); enter(); nativeEntries++;
                throw new Exception("Native execution must remain unreachable");
            });
            Assert.Equal(0, nativeEntries);
            var blocked = Assert.IsType<Dictionary<string, object?>>(result);
            Assert.Equal("not_started", Assert.IsType<OperatorNativeTransactionReceipt>(blocked["transaction"]).Status);
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/assign-electrical-circuit").EffectState);
        }
    }
}

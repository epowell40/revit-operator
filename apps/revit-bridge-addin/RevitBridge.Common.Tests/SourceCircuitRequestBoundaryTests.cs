using System;
using System.Collections.Generic;
using RevitBridge.Common;
using RevitBridge.Common.Electrical;
using RevitBridge.Logic.Handlers;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class SourceCircuitRequestBoundaryTests
    {
        [Theory]
        [InlineData(0, false, 21)]
        [InlineData(-1, false, 21)]
        [InlineData(20, true, 21)]
        [InlineData(20, false, 0)]
        [InlineData(20, false, -1)]
        public void InvalidOrMixedSourceModeCannotFallThroughToLabelWrites(long sourceId, bool mixedMode, long targetId)
        {
            int nativeEntries = 0;
            var result = NativeMutationPreflightBoundary.Execute(enter =>
            {
                CircuitMatchPolicy.RequireSourceAssignmentRequest(sourceId, new[] { targetId }, mixedMode);
                enter(); nativeEntries++;
                throw new Exception("Native mutation must remain unreachable");
            });
            Assert.Equal(0, nativeEntries);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/assign-electrical-circuit");
            Assert.Equal("none", settlement.EffectState);
            var blocked = Assert.IsType<Dictionary<string, object?>>(result);
            Assert.Equal("not_started", Assert.IsType<OperatorNativeTransactionReceipt>(blocked["transaction"]).Status);
        }

        [Fact]
        public void EmptySourceTargetSetIsRejectedBeforeNativeEntry()
        {
            Assert.Throws<InvalidOperationException>(() => CircuitMatchPolicy.RequireSourceAssignmentRequest(20, Array.Empty<long>(), false));
        }

        [Fact]
        public void ValidMultiTargetSourceRequestReachesOnlyOneNativeScope()
        {
            int nativeEntries = 0;
            var result = NativeMutationPreflightBoundary.Execute(enter =>
            {
                CircuitMatchPolicy.RequireSourceAssignmentRequest(20, new long[] { 21, 22, 23 }, false);
                enter(); nativeEntries++;
                return new Dictionary<string, object?> { ["transaction"] = OperatorNativeTransactionReceipt.RolledBack(Array.Empty<long>()) };
            });
            Assert.Equal(1, nativeEntries);
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", "/revit/assign-electrical-circuit").EffectState);
        }
    }
}

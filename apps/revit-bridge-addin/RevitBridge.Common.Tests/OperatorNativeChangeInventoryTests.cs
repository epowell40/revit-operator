using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorNativeChangeInventoryTests
    {
        // Models Revit Document.Equals: same open native document, different managed wrappers.
        private sealed class DocumentWrapper
        {
            private readonly string openIdentity;
            public DocumentWrapper(string openIdentity) { this.openIdentity = openIdentity; }
            public override bool Equals(object? other) => other is DocumentWrapper d && d.openIdentity == openIdentity;
            public override int GetHashCode() => openIdentity.GetHashCode();
        }

        [Fact]
        public void DistinctWrappersForSameOpenDocumentCaptureAllChangeKinds()
        {
            var inventory = new OperatorNativeChangeInventory(new DocumentWrapper("open-1"));
            inventory.Observe(() => new DocumentWrapper("open-1"), () => new long[] { 1542917 },
                () => new long[] { 9946 }, () => new long[] { 70 });
            Assert.True(inventory.Exhaustive);
            Assert.Equal(1, inventory.DistinctWrapperMatchCount);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(
                new { transaction = inventory.CommittedReceipt() }, "apply", "POST", "/revit/create-view");
            Assert.Contains("element_id:1542917", settlement.AffectedTargetIdentities);
            Assert.Contains("element_id:9946", settlement.AffectedTargetIdentities);
            Assert.Contains("element_id:70", settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void OtherOpenDocumentAndMissingEventsCannotProveExhaustiveInventory()
        {
            var inventory = new OperatorNativeChangeInventory(new DocumentWrapper("open-1"));
            Assert.False(inventory.Exhaustive);
            inventory.Observe(() => new DocumentWrapper("open-2"),
                () => throw new Exception("Must not read another document's IDs"),
                () => Array.Empty<long>(), () => Array.Empty<long>());
            Assert.False(inventory.Exhaustive);
            Assert.Equal(1, inventory.EventCount);
            Assert.Equal(0, inventory.MatchingEventCount);
            Assert.Equal(0, inventory.CaptureFailureCount);
        }

        [Fact]
        public void LaterSuccessfulEventDoesNotEraseEarlierCaptureFailure()
        {
            var doc = new DocumentWrapper("open-1");
            var inventory = new OperatorNativeChangeInventory(doc);
            inventory.Observe(() => doc, () => new long[] { 1 },
                () => throw new Exception("Native enumeration failed"), () => Array.Empty<long>());
            inventory.Observe(() => doc, () => new long[] { 2 },
                () => Array.Empty<long>(), () => Array.Empty<long>());
            Assert.False(inventory.Exhaustive);
            Assert.Equal(1, inventory.CaptureFailureCount);
            Assert.Equal(2, inventory.MatchingEventCount);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void EventFailureCannotLoseCommitOrFabricateExhaustiveEvidence(bool failCapture)
        {
            var doc = new DocumentWrapper("open-1");
            var inventory = new OperatorNativeChangeInventory(doc);
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () =>
                {
                    inventory.Observe(() => new DocumentWrapper("open-1"), () => new long[] { 1542917 },
                        () => failCapture ? throw new Exception("Native read failed") : new long[] { 9946 },
                        () => Array.Empty<long>());
                    return "Committed";
                }, () => throw new Exception("Must not roll back committed work"), () => "Committed",
                () => new Dictionary<string, object?>(), inventory.CommittedReceipt,
                () => new long[] { 1542917 });
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/create-view");
            Assert.Equal("applied", settlement.EffectState);
            Assert.Contains("element_id:1542917", settlement.AffectedTargetIdentities);
            Assert.Equal(!failCapture, inventory.Exhaustive);
            Assert.Equal(!failCapture, settlement.AffectedTargetIdentities.Contains("element_id:9946"));
        }

        [Fact]
        public void ParameterMutationInventoryIncludesCollateralInsteadOfOnlyRequestedTarget()
        {
            var doc = new DocumentWrapper("parameter-document");
            var inventory = new OperatorNativeChangeInventory(doc);
            inventory.Observe(() => new DocumentWrapper("parameter-document"), () => new long[] { 200 },
                () => new long[] { 1365188, 49831 }, () => new long[] { 300 });
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new { transaction = inventory.CommittedReceipt() },
                "apply", "POST", "/revit/set-parameter");
            Assert.True(inventory.Exhaustive);
            Assert.Equal("applied", settlement.EffectState);
            foreach (var id in new[] { "element_id:1365188", "element_id:49831", "element_id:200", "element_id:300" })
                Assert.Contains(id, settlement.AffectedTargetIdentities);
        }
    }
}

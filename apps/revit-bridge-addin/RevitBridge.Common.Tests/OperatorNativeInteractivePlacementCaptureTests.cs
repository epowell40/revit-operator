using System;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorNativeInteractivePlacementCaptureTests
    {
        private static void Commit(OperatorNativeInteractivePlacementCapture capture, object doc,
            long[]? added = null, long[]? modified = null, long[]? deleted = null) =>
            capture.Observe(() => doc, () => "TransactionCommitted", () => added ?? Array.Empty<long>(),
                () => modified ?? Array.Empty<long>(), () => deleted ?? Array.Empty<long>());

        [Fact]
        public void NativePlacementIncludesSetupAndAllCollateralEffectsWithoutProvingFit()
        {
            // Shapes from native131: setup modifies symbol; insertion adds accessory,
            // split duct and ancillary element. This replay does NOT reattribute the
            // historical global observation to a new native operation.
            var doc = new object(); var capture = new OperatorNativeInteractivePlacementCapture(doc);
            Commit(capture, doc, modified: new long[] { 1545043 });
            Commit(capture, doc, new long[] { 1545993, 1545996, 1545997 },
                new long[] { 378358, 669230, 731023, 1321945, 1484304, 1485080, 1485081, 1485094, 1485097 });
            var receipt = capture.Finish(true, true);
            Assert.True(receipt.CommittedValue);
            Assert.Equal(13, receipt.AffectedElementIds.Count);
            Assert.Contains(1545043, receipt.ModifiedElementIds);
            using var diagnostics = JsonDocument.Parse(JsonSerializer.Serialize(capture.Diagnostics()));
            Assert.False(diagnostics.RootElement.GetProperty("postconditionVerified").GetBoolean());
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new { transaction = receipt },
                "apply", "POST", "/revit/create-family-instance");
            Assert.Equal("applied", settlement.EffectState);
            Assert.Equal(13, settlement.AffectedTargetIdentities.Count);
        }

        [Fact]
        public void EscapeAfterPlacementsDoesNotEraseCommitsAndNoEventIsNotNotStarted()
        {
            var doc = new object(); var capture = new OperatorNativeInteractivePlacementCapture(doc);
            Commit(capture, doc, new long[] { 10 }, new long[] { 2 });
            Commit(capture, doc, new long[] { 11 }, new long[] { 3 });
            // Native adapter treats the documented cancellation exception as invocation return.
            Assert.True(capture.Finish(true, true).CommittedValue);
            var empty = new OperatorNativeInteractivePlacementCapture(doc).Finish(true, true);
            Assert.Null(empty.CommittedValue);
            Assert.NotEqual("not_started", empty.Status);
        }

        [Theory]
        [InlineData("TransactionUndone")]
        [InlineData("TransactionRedone")]
        [InlineData("TransactionRolledBack")]
        [InlineData("TransactionGroupRolledBack")]
        [InlineData("unknown")]
        public void InterveningUndoRedoRollbackCannotBorrowEarlierCommit(string operation)
        {
            var doc = new object(); var capture = new OperatorNativeInteractivePlacementCapture(doc);
            Commit(capture, doc, new long[] { 10 }, new long[] { 2 });
            capture.Observe(() => doc, () => operation, () => Array.Empty<long>(),
                () => new long[] { 2 }, () => new long[] { 10 });
            var receipt = capture.Finish(true, true);
            Assert.Null(receipt.CommittedValue);
            Assert.Equal(new long[] { 2, 10 }, receipt.AffectedElementIds);
        }

        [Theory]
        [InlineData(false, true)]
        [InlineData(true, false)]
        public void NativeFaultOrActiveContextChangeKeepsKnownEffectsUnknown(bool returned, bool same)
        {
            var doc = new object(); var capture = new OperatorNativeInteractivePlacementCapture(doc);
            Commit(capture, doc, new long[] { 10 }, new long[] { 2 });
            var receipt = capture.Finish(returned, same);
            Assert.Null(receipt.CommittedValue);
            Assert.Equal(new long[] { 2, 10 }, receipt.AffectedElementIds);
        }

        [Fact]
        public void ForeignDocumentOrFailedEnumerationCannotBeRepairedByLaterGoodEvent()
        {
            foreach (var foreign in new[] { true, false })
            {
                var doc = new object(); var capture = new OperatorNativeInteractivePlacementCapture(doc);
                capture.Observe(() => foreign ? new object() : doc, () => "TransactionCommitted",
                    () => new long[] { 90 }, () => throw new InvalidOperationException(), () => Array.Empty<long>());
                Commit(capture, doc, new long[] { 10 });
                var receipt = capture.Finish(true, true);
                Assert.Null(receipt.CommittedValue);
                Assert.DoesNotContain(90, receipt.AffectedElementIds);
                Assert.Contains(10, receipt.AffectedElementIds);
            }
        }

        private sealed class Doc
        {
            private readonly int session;
            public Doc(int session) { this.session = session; }
            public override bool Equals(object? other) => other is Doc d && d.session == session;
            public override int GetHashCode() => session;
        }

        [Fact]
        public void NativeDocumentEqualityAndSingleSettlementAreRequired()
        {
            var capture = new OperatorNativeInteractivePlacementCapture(new Doc(1));
            Commit(capture, new Doc(1), new long[] { 10 });
            Assert.True(capture.Finish(true, true).CommittedValue);
            Assert.Throws<InvalidOperationException>(() => capture.Finish(true, true));
            Assert.Throws<InvalidOperationException>(() => Commit(capture, new Doc(1), new long[] { 11 }));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        public void InvalidIdsCannotDisappearIntoACommittedReceipt(long id)
        {
            var doc = new object(); var capture = new OperatorNativeInteractivePlacementCapture(doc);
            Commit(capture, doc, new[] { id }); Commit(capture, doc, new long[] { 10 });
            Assert.Null(capture.Finish(true, true).CommittedValue);
        }

        [Fact]
        public void BoundedCaptureRefusesOverflowsAndContradictoryEvents()
        {
            var doc = new object();
            var manyIds = new OperatorNativeInteractivePlacementCapture(doc);
            Commit(manyIds, doc, Enumerable.Range(1, 10001).Select(i => (long)i).ToArray());
            Assert.Null(manyIds.Finish(true, true).CommittedValue);
            var manyEvents = new OperatorNativeInteractivePlacementCapture(doc);
            for (var i = 0; i < 257; i++) Commit(manyEvents, doc, modified: new long[] { 2 });
            Assert.Null(manyEvents.Finish(true, true).CommittedValue);
            var contradictory = new OperatorNativeInteractivePlacementCapture(doc);
            Commit(contradictory, doc, new long[] { 10 }, deleted: new long[] { 10 });
            Assert.Null(contradictory.Finish(true, true).CommittedValue);
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class PlaceViewSettlementTests
    {
        [Theory]
        [InlineData("Committed", "applied", true)]
        [InlineData("RolledBack", "none", false)]
        [InlineData("Pending", "unknown", false)]
        public void ExactPlacedResponseRequiresObservedTransaction(string status, string effect, bool hasCreatedId)
        {
            // Campaign04 native payload, SHA256 a504f6fc9ffa8e8c93cdcb10881a3eaf43ca8dd88060c81f4fa99674ec64a2a1.
            var old = JsonSerializer.Deserialize<Dictionary<string, object?>>(
                File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "place-view-unsettled.json")))!;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(old, "apply", "POST", "/revit/place-view").EffectState);
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => status, () => "RolledBack", () => status,
                () => old, () => OperatorNativeTransactionReceipt.CommittedChanges(new long[] {1543012}, new long[] {1542982}, Array.Empty<long>()),
                () => new long[] {1543012});
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal(hasCreatedId, receipt.AddedElementIds.Contains(1543012));
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/place-view").EffectState);
            if (!hasCreatedId) Assert.False(result.ContainsKey("id"));
        }

        [Fact]
        public void RejectedPlacementRollsBackWithoutClaimingCreatedViewport()
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("must not commit"),
                () => "RolledBack", () => "Started", () => throw new InvalidOperationException("Cannot place schedule on sheet."),
                () => throw new Exception("must not collect committed inventory"));
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/place-view").EffectState);
            Assert.False((bool)result["success"]!);
            Assert.False(result.ContainsKey("id"));
        }
    }
}

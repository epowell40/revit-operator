using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class TransactionPlanSettlementTests
    {
        private static Dictionary<string, object?> Historical() =>
            JsonSerializer.Deserialize<Dictionary<string, object?>>(File.ReadAllText(
                Path.Combine(AppContext.BaseDirectory, "Fixtures", "transaction-plan-delete-unsettled.json")))!;

        [Theory]
        [InlineData("RolledBack", "none", true)]
        [InlineData("Pending", "unknown", false)]
        [InlineData("Started", "unknown", false)]
        [InlineData("Error", "unknown", false)]
        public void ExactDeletePreviewRequiresNativeRollback(string nativeStatus, string effect, bool retainsImpact)
        {
            var historical = Historical();
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(
                historical, "preview", "POST", "/revit/transaction-plan").EffectState);
            var calls = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("Preview must never commit"),
                () => { calls++; return nativeStatus; }, () => nativeStatus,
                () => historical, () => throw new Exception("No commit inventory"),
                disposition: NativeTransactionDisposition.Rollback);
            Assert.Equal(1, calls);
            Assert.Equal(retainsImpact, response.ContainsKey("impact"));
            Assert.Equal(retainsImpact, response["success"]);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(
                response, "preview", "POST", "/revit/transaction-plan").EffectState);
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(response["transaction"]);
            Assert.Empty(receipt.DeletedElementIds);
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void RollbackExceptionUsesObservedStatusWithoutRetry(string observed, string effect)
        {
            var calls = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("Never commit"),
                () => { calls++; throw new Exception("Rollback failed"); }, () => observed,
                Historical, () => throw new Exception("No commit inventory"),
                disposition: NativeTransactionDisposition.Rollback);
            Assert.Equal(1, calls);
            Assert.Equal(false, response["success"]);
            Assert.False(response.ContainsKey("impact"));
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(
                response, "preview", "POST", "/revit/transaction-plan").EffectState);
        }
    }
}

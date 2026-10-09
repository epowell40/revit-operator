using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class VisibilityPlanSettlementTests
    {
        [Theory]
        [InlineData("RolledBack", "none", true)]
        [InlineData("Pending", "unknown", false)]
        public void ExactViewRangePreviewRequiresActualRollback(string status, string effect, bool success)
        {
            var historical = JsonSerializer.Deserialize<Dictionary<string, object?>>(
                File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "view-range-preview-unsettled.json")))!;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(historical, "preview", "POST", "/revit/visibility").EffectState);
            int mutations = 0, rollbacks = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("preview must not commit"),
                () => { rollbacks++; return status; }, () => status,
                () => { mutations++; return historical; }, () => throw new Exception("no committed inventory"),
                disposition: NativeTransactionDisposition.Rollback);
            response["previewExecuted"] = response["success"] is true;
            Assert.Equal(1, mutations);
            Assert.Equal(1, rollbacks);
            Assert.Equal(success, response["previewExecuted"]);
            Assert.Equal(success, response.ContainsKey("proposed"));
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(response, "preview", "POST", "/revit/visibility").EffectState);
        }

        [Fact]
        public void RetainedPlanRequiresNativeNotStartedReceipt()
        {
            // Exact October7 opv2_95cdf002 payload, content SHA256
            // 3aadea7b6887e79f4d40049ef51ade6f8d09c0e3b3f0f230fb1344a2a7ae6362.
            var payload = JsonSerializer.Deserialize<Dictionary<string, object?>>(
                File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "visibility-plan-unsettled.json")))!;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(payload, "preview", "POST", "/revit/visibility").EffectState);
            payload["previewExecuted"] = false;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(payload, "preview", "POST", "/revit/visibility").EffectState);
            payload["transaction"] = OperatorNativeTransactionReceipt.NotStarted();
            var result = OperatorAttemptSuccessfulSettlement.Classify(payload, "preview", "POST", "/revit/visibility");
            Assert.Equal("none", result.EffectState);
            Assert.Equal("native_transaction_not_started", result.EffectReason);
            Assert.Empty(result.AffectedTargetIdentities);
        }
    }
}

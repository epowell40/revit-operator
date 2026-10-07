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

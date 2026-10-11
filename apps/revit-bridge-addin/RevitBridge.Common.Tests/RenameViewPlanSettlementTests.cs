using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class RenameViewPlanSettlementTests
    {
        [Fact]
        public void RetainedPlanRequiresNativeNotStartedReceipt()
        {
            // Exact October9 rename_batch plan-only payload, content SHA256
            // 1297bde88341cbc31284e5f0edb4b767409c364e38f36a23b1b15d90a80f14b2.
            var payload = JsonSerializer.Deserialize<Dictionary<string, object?>>(
                File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "rename-view-plan-unsettled.json")))!;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(payload, "preview", "POST", "/revit/create-view").EffectState);
            payload["previewExecuted"] = false;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(payload, "preview", "POST", "/revit/create-view").EffectState);
            payload["transaction"] = OperatorNativeTransactionReceipt.NotStarted();
            var result = OperatorAttemptSuccessfulSettlement.Classify(payload, "preview", "POST", "/revit/create-view");
            Assert.Equal("none", result.EffectState);
            Assert.Equal("native_transaction_not_started", result.EffectReason);
            Assert.Empty(result.AffectedTargetIdentities);
        }
    }
}

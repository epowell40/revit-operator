using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorOpenModelNoEffectTests
    {
        [Fact]
        public void RetainedRefusalNeedsNativeNotStartedTruthRatherThanStatusInference()
        {
            var retained = Environment.GetEnvironmentVariable("OPERATOR_TEST_RETAINED_OPEN_RESULT");
            var raw = string.IsNullOrWhiteSpace(retained)
                ? "{\"status\":\"Already Loaded As Link\",\"path\":\"C:/Models/Plumbing.rvt\",\"completionEligible\":false,\"requestedEffectSatisfied\":false,\"requiresExplicitUnloadAndOpen\":true}"
                : File.ReadAllText(retained);
            var original = JsonNode.Parse(raw)!;
            Assert.Equal("Already Loaded As Link", original["status"]!.GetValue<string>());
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(original, "apply", "POST", "/revit/open-model").EffectState);
            var current = JsonNode.Parse(raw)!;
            current["transaction"] = JsonNode.Parse(JsonSerializer.Serialize(OperatorNativeTransactionReceipt.NotStarted()));
            var result = OperatorAttemptSuccessfulSettlement.Classify(current, "apply", "POST", "/revit/open-model");
            Assert.Equal("none", result.EffectState);
            Assert.Equal("native_transaction_not_started", result.EffectReason);
            Assert.True(result.RequestDispatched);
            Assert.Empty(result.AffectedTargetIdentities);
            Assert.False(current["requestedEffectSatisfied"]!.GetValue<bool>());
            foreach (var status in new[] { "pending", "unknown", "started" })
            {
                var uncertain = JsonNode.Parse(current.ToJsonString())!;
                uncertain["transaction"]!["status"] = status;
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(uncertain, "apply", "POST", "/revit/open-model").EffectState);
            }
            var output = Environment.GetEnvironmentVariable("OPERATOR_TEST_OPEN_RESULT_OUTPUT");
            if (!string.IsNullOrWhiteSpace(output))
            {
                Directory.CreateDirectory(output);
                File.WriteAllText(Path.Combine(output, "native-produced-envelope.json"), JsonSerializer.Serialize(
                    OperatorAttemptSuccessfulSettlement.Attach(current, "apply", "POST", "/revit/open-model")));
            }
            if (!string.IsNullOrWhiteSpace(retained)) Assert.Equal(raw, File.ReadAllText(retained));
        }
    }
}

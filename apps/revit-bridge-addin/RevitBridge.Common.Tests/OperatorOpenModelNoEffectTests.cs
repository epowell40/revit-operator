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

        [Fact]
        public void CleanActivationRequiresTheVerifiedDestinationOfTheRequestedOpen()
        {
            var retained = Environment.GetEnvironmentVariable("OPERATOR_TEST_RETAINED_ACTIVATION_RESULT");
            var raw = string.IsNullOrWhiteSpace(retained)
                ? "{\"status\":\"Success\",\"path\":\"C:/Models/Door.rfa\"}"
                : File.ReadAllText(retained);
            var old = JsonNode.Parse(raw)!;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(old, "apply", "POST", "/revit/open-model").EffectState);

            var current = JsonNode.Parse(raw)!;
            var requestedPath = old["path"]!.GetValue<string>();
            current["document_activation_receipt"] = JsonSerializer.SerializeToNode(new
            {
                schema = "revit-operator.document-activation.v1",
                requested_path = requestedPath.Replace('\\', '/'),
                active_path = requestedPath,
                active_document_session_id = new string('a', 32),
                active_document_unmodified = true,
                scope = "open_existing_file_without_edits"
            });
            var result = OperatorAttemptSuccessfulSettlement.Classify(current, "apply", "POST", "/revit/open-model");
            Assert.Equal("none", result.EffectState);
            Assert.Equal("native_document_activation_confirmed", result.EffectReason);
            Assert.Equal("native_receipt", result.EffectAuthority);
            Assert.True(result.RequestDispatched);
            Assert.Empty(result.AffectedTargetIdentities);

            foreach (var field in new[] { "schema", "requested_path", "active_path", "active_document_session_id", "scope" })
            {
                var foreign = JsonNode.Parse(current.ToJsonString())!;
                foreign["document_activation_receipt"]![field] = "foreign";
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(foreign, "apply", "POST", "/revit/open-model").EffectState);
            }
            var dirty = JsonNode.Parse(current.ToJsonString())!;
            dirty["document_activation_receipt"]!["active_document_unmodified"] = false;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(dirty, "apply", "POST", "/revit/open-model").EffectState);
            var unloaded = JsonNode.Parse(current.ToJsonString())!;
            unloaded["status"] = "Unloaded Link and Activated";
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(unloaded, "apply", "POST", "/revit/open-model").EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(current, "apply", "POST", "/revit/save-as").EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(current, "preview", "POST", "/revit/open-model").EffectState);
            if (!string.IsNullOrWhiteSpace(retained)) Assert.Equal(raw, File.ReadAllText(retained));
        }

    }
}

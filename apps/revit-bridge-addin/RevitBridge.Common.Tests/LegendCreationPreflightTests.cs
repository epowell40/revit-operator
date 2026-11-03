using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class LegendCreationPreflightTests
    {
        [Fact]
        public void MissingNativeSourceReturnsAnActionableNotStartedReceipt()
        {
            var result = LegendCreationPreflight.CheckSource(false)!;
            Assert.Equal("Blocked", result["status"]);
            Assert.Equal(false, result["success"]);
            Assert.Equal(false, result["applied"]);
            Assert.Equal(false, result["verified"]);
            Assert.Equal("legend_source_required", result["errorCode"]);
            Assert.Contains("View > Legends > Legend", (string)result["correction"]!);
            Assert.Contains("Do not substitute", (string)result["correction"]!);
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal("not_started", receipt.Status);
            Assert.Equal(false, receipt.CommittedValue);
            Assert.Empty(receipt.AffectedElementIds);
            Assert.Empty(receipt.AddedElementIds);
        }

        [Fact]
        public void ResolvedSourceContinuesWithoutInventingCreationSuccess()
        {
            Assert.Null(LegendCreationPreflight.CheckSource(true));
        }

        [Theory]
        [InlineData("apply")]
        [InlineData("preview")]
        public void RealProducerSettlesAsDispatchedButNoTransaction(string effect)
        {
            var result = LegendCreationPreflight.CheckSource(false)!;
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, effect, "POST", "/revit/create-view");
            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("native_transaction_not_started", settlement.EffectReason);
            Assert.True(settlement.RequestDispatched);
            Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData("missing")]
        [InlineData("pending")]
        public void GuidanceOrErrorWordsCannotReplaceNativeReceipt(string variant)
        {
            var result = JsonNode.Parse(JsonSerializer.Serialize(LegendCreationPreflight.CheckSource(false)))!;
            if (variant == "missing") result.AsObject().Remove("transaction");
            else result["transaction"]!["status"] = "pending";
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/create-view").EffectState);
        }

        [Fact]
        public void Historical426ExceptionRemainsUnknown()
        {
            // Retained native426 failure shape, with no project-specific data.
            var historical = new { error = "create-view(create_legend) requires sourceViewId for a legend view, or at least one existing non-template legend view.", type = "System.InvalidOperationException", request_dispatched = true, outcome_unknown = true };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(historical, "apply", "POST", "/revit/create-view").EffectState);
        }

        [Fact]
        public void HandlerUsesNativeDiscoveryBeforePlanAndCreationTransaction()
        {
            var root = new DirectoryInfo(AppContext.BaseDirectory);
            while (root != null && !File.Exists(Path.Combine(root.FullName, "RevitBridge", "Handlers", "CreateViewHandler.cs"))) root = root.Parent;
            Assert.NotNull(root);
            var handler = File.ReadAllText(Path.Combine(root!.FullName, "RevitBridge", "Handlers", "CreateViewHandler.cs"));
            var preflight = handler.IndexOf("LegendCreationPreflight.CheckSource(", StringComparison.Ordinal);
            Assert.True(preflight >= 0);
            Assert.Contains("ResolveLegendSourceView(doc, p.sourceViewId) != null", handler);
            Assert.True(preflight < handler.IndexOf("var plan = BuildPlan", StringComparison.Ordinal));
            Assert.True(preflight < handler.IndexOf("var creation =", StringComparison.Ordinal));
            Assert.Contains("if (sourcePreflight != null) return Task.FromResult<object>(sourcePreflight);", handler);
        }
    }
}

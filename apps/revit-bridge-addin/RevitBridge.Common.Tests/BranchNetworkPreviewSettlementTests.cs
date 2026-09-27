using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class BranchNetworkPreviewSettlementTests
    {
        private const string Route = "/revit/mep-branch-network-workflow";
        private static readonly long[] TransientIds = { 1543300, 1543303, 1543306, 1543309, 1543312, 1543314, 1543316 };

        [Fact]
        public void ExactRetainedPreviewHasAChildRollbackButNoRootSettlement()
        {
            var bytes = File.ReadAllBytes(FixturePath());
            using var sha = SHA256.Create();
            Assert.Equal("68f33a8e4e0338406e1e61f55b0acd6c5cd8f8b6d2091a65311aba13d9564ff0",
                BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant());
            var exact = JsonNode.Parse(bytes)!;
            Assert.Equal("DryRunReady", exact["status"]!.GetValue<string>());
            Assert.Null(exact["transaction"]);
            Assert.Equal("rolled_back", exact["mainDryRun"]!["transaction"]!["status"]!.GetValue<string>());
            Assert.Equal(TransientIds, exact["mainDryRun"]!["transaction"]!["affected_element_ids"]!.AsArray().Select(x => x!.GetValue<long>()));
            Assert.Empty(exact["mainDryRun"]!["createdElementIds"]!.AsArray());
            Assert.Empty(exact["mainDryRun"]!["createdFittingIds"]!.AsArray());
            var legacy = OperatorAttemptSuccessfulSettlement.Classify(exact, "preview", "POST", Route);
            Assert.Equal("unknown", legacy.EffectState);
            Assert.Equal("native_handler_returned_without_authoritative_settlement", legacy.EffectReason);
        }

        [Fact]
        public void ForwardingTheExactAttemptedStagePreservesRollbackAndTransientIdentities()
        {
            var workflow = Exact();
            var stage = workflow["mainDryRun"]!;
            var receipt = OperatorNativeTransactionReceipt.LastAttemptedStage(stage, null, false);
            Assert.Equal(stage["transaction"]!.ToJsonString(), JsonSerializer.Serialize(receipt));
            workflow["transaction"] = JsonNode.Parse(JsonSerializer.Serialize(receipt));
            var settled = OperatorAttemptSuccessfulSettlement.Classify(workflow, "preview", "POST", Route);
            Assert.Equal("none", settled.EffectState);
            Assert.Equal("native_rollback", settled.EffectAuthority);
            Assert.Equal("verified_native_rollback", settled.EffectReason);
            foreach (var id in TransientIds) Assert.Contains("element_id:" + id, settled.AffectedTargetIdentities);
            Assert.Empty(workflow["mainDryRun"]!["createdElementIds"]!.AsArray());
            Assert.Equal("DryRunReady", workflow["status"]!.GetValue<string>());
        }

        [Theory]
        [InlineData("Uninitialized", "none", "native_transaction_not_started")]
        [InlineData("RolledBack", "none", "verified_native_rollback")]
        [InlineData("Committed", "applied", "native_transaction_committed")]
        [InlineData("Started", "unknown", "native_handler_returned_without_authoritative_settlement")]
        [InlineData("Pending", "unknown", "native_handler_returned_without_authoritative_settlement")]
        [InlineData("Error", "unknown", "native_handler_returned_without_authoritative_settlement")]
        public void DryRunPresentationCannotOverrideTheAttemptedStage(string nativeStatus, string effect, string reason)
        {
            var child = new { status = "Dry Run", rolledBack = true,
                transaction = OperatorNativeTransactionReceipt.FromObservedStatus(nativeStatus, TransientIds) };
            foreach (var display in new[] { "DryRunReady", "Blocked" })
            {
                var result = new { status = display, workflowMode = "dryRun",
                    transaction = OperatorNativeTransactionReceipt.LastAttemptedStage(child, null, false) };
                var settled = OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", Route);
                Assert.Equal(effect, settled.EffectState);
                Assert.Equal(reason, settled.EffectReason);
            }
        }

        [Fact]
        public void MissingOrUnrelatedNestedReceiptsRemainUnknown()
        {
            foreach (var child in new object[] {
                new { status = "Dry Run", rolledBack = true },
                new { unrelated = new { transaction = OperatorNativeTransactionReceipt.RolledBack(TransientIds) } }
            })
            {
                var forwarded = OperatorNativeTransactionReceipt.LastAttemptedStage(child, null, false);
                Assert.Null(forwarded);
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(new {
                    status = "DryRunReady", transaction = forwarded, mainDryRun = child
                }, "preview", "POST", Route).EffectState);
            }
        }

        [Fact]
        public void EarlierPreviewCannotHideAnAttemptedApplyOrUnknownOuterGroup()
        {
            var preview = new { transaction = OperatorNativeTransactionReceipt.RolledBack(TransientIds) };
            Assert.Null(OperatorNativeTransactionReceipt.LastAttemptedStage(preview, null, true));
            var failedOuter = new { status = "BlockedRollbackFailed", mainDryRun = preview,
                transaction = OperatorNativeTransactionReceipt.FromAtomicGroupRollback(false) };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(failedOuter, "apply", "POST", Route).EffectState);
            var committedOuter = new { status = "AppliedNetworkVerified", mainDryRun = preview,
                transaction = OperatorNativeTransactionReceipt.Committed(new[] { 99L }) };
            var settled = OperatorAttemptSuccessfulSettlement.Classify(committedOuter, "apply", "POST", Route);
            Assert.Equal("applied", settled.EffectState);
            Assert.Equal(new[] { "element_id:99" }, settled.AffectedTargetIdentities);
        }

        [Fact]
        public void PreflightValidationIsExplicitlyNotStartedForPreviewAndApply()
        {
            foreach (var effect in new[] { "preview", "apply" })
            {
                var blocked = new { status = "Blocked", error = "No level or insufficient mainPoints",
                    transaction = OperatorNativeTransactionReceipt.NotStarted() };
                var settled = OperatorAttemptSuccessfulSettlement.Classify(blocked, effect, "POST", Route);
                Assert.Equal("none", settled.EffectState);
                Assert.Equal("native_transaction_not_started", settled.EffectReason);
                Assert.Empty(settled.AffectedTargetIdentities);
            }
            var source = ReadHandlerSource();
            var beforeGroup = source.Substring(0, source.IndexOf("TransactionGroup? networkApplyGroup", StringComparison.Ordinal));
            Assert.Equal(2, beforeGroup.Split(new[] { "transaction = OperatorNativeTransactionReceipt.NotStarted()" }, StringSplitOptions.None).Length - 1);
        }

        [Fact]
        public void ProductionPreviewSuccessBlockedAndErrorPathsForwardTheTestedStageHelper()
        {
            var source = ReadHandlerSource();
            const string forwarding = "OperatorNativeTransactionReceipt.LastAttemptedStage(mainDryRun, null, false)";
            Assert.Equal(3, source.Split(new[] { forwarding }, StringSplitOptions.None).Length - 1);
            Assert.Contains("object? mainDryRun = null;", source);
            Assert.Contains(": mainDryRun == null ? null : " + forwarding, source);
            Assert.Contains("transaction = p.apply ? OperatorNativeTransactionReceipt.FromAtomicGroupRollback(rolledBack)", source);
            Assert.Contains("transaction = OperatorNativeTransactionReceipt.Committed(allModelIds.Concat(deletedAccessoryIds).Distinct().ToList())", source);
        }

        private static string FixturePath() => Path.Combine(AppContext.BaseDirectory, "Fixtures", "unit403-branch-network-preview-unsettled.json");
        private static JsonNode Exact() => JsonNode.Parse(File.ReadAllBytes(FixturePath()))!;
        private static string ReadHandlerSource()
        {
            var retained = Environment.GetEnvironmentVariable("OPERATOR_TEST_BRANCH_NETWORK_SOURCE");
            if (!string.IsNullOrWhiteSpace(retained)) return File.ReadAllText(retained);
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge.Logic/Handlers/MEP/MepBranchNetworkWorkflowHandler.cs");
                    if (File.Exists(file)) return File.ReadAllText(file);
                }
            throw new FileNotFoundException("Branch network handler source not found.");
        }
    }
}

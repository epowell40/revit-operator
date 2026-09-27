using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ConnectMepElementsTransactionTests
    {
        private const string Route = "/revit/connect-mep-elements";

        private static Dictionary<string, object?> Historical()
            => JsonSerializer.Deserialize<Dictionary<string, object?>>(File.ReadAllText(Path.Combine(
                AppContext.BaseDirectory, "Fixtures", "read-recovery-connect-mep-elements-applied-unsettled.json")))!;

        [Theory]
        [InlineData("Source element 1543155 was not found.")]
        [InlineData("No active Revit document.")]
        [InlineData("toleranceFt must be greater than 0 and no more than 2 feet.")]
        public void FailedReadOnlyPreflightSettlesNoneBeforeNativeEntry(string message)
        {
            var result = NativeMutationPreflightBoundary.Execute(_ => throw new InvalidOperationException(message));
            var response = Assert.IsType<Dictionary<string, object?>>(result);
            Assert.Equal(message, response["error"]);
            Assert.Equal("not_started", Assert.IsType<OperatorNativeTransactionReceipt>(response["transaction"]).Status);
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", Route).EffectState);
        }

        [Fact]
        public void ErrorAfterEnteringNativeExecutionCannotBeReclassifiedAsPreflight()
        {
            var error = new InvalidOperationException("native response lost");
            Assert.Same(error, Assert.Throws<InvalidOperationException>(() =>
                NativeMutationPreflightBoundary.Execute(enter => { enter(); throw error; })));
        }

        [Fact]
        public void ExactAppliedConnectionClaimWithoutNativeTransactionAuthorityRemainsUnknown()
        {
            // Recovery native correlation b8bf5a0e...f4308: the connection was
            // reported Applied but could not establish the transaction outcome.
            var historical = Historical();
            Assert.Equal("Applied", ((JsonElement)historical["status"]!).GetString());
            Assert.Equal(1, ((JsonElement)historical["verifiedConnectionCount"]!).GetInt32());
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(historical, "apply", "POST", Route);
            Assert.Equal("unknown", settlement.EffectState);
            Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData("Committed", "applied")]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void ExactPayloadGainsEffectOnlyFromObservedNativeSettlement(string nativeStatus, string expected)
        {
            int edits = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => nativeStatus,
                () => throw new Exception("must not retry native settlement"), () => nativeStatus,
                () => { edits++; return Historical(); },
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 1543159L }, new[] { 1543155L, 1542963L }, Array.Empty<long>()));
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", Route);
            Assert.Equal(1, edits);
            Assert.Equal(expected, settlement.EffectState);
            if (nativeStatus == "Committed")
                Assert.Equal(new[] { "element_id:1542963", "element_id:1543155", "element_id:1543159" }, settlement.AffectedTargetIdentities);
            else Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        public void PlanOnlyAndBlockedPreflightAreNotExecutedPreviews(bool feasible)
        {
            var result = new { status = feasible ? "Ready" : "Blocked", success = feasible,
                dryRun = true, previewExecuted = false, applied = false, verified = false,
                transaction = OperatorNativeTransactionReceipt.NotStarted() };
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", Route).EffectState);
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", Route).EffectState);
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        [InlineData("Started", "unknown")]
        public void FailedPhysicalConnectionNeverClaimsRollbackWithoutItsNativeStatus(string rollbackStatus, string expected)
        {
            int rollbacks = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("failed verification must not commit"),
                () => { rollbacks++; return rollbackStatus; }, () => "Started",
                () => throw new InvalidOperationException("Required physical target is unconnected."),
                () => throw new Exception("no committed inventory"));
            Assert.Equal(1, rollbacks);
            Assert.Equal(false, response["success"]);
            Assert.False(response.ContainsKey("verifiedTargetElementIds"));
            Assert.Equal(expected, OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", Route).EffectState);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void FreshReadFailureCannotEraseACommitOrReuseTransientVerification(bool commitThrows)
        {
            int edits = 0, readbacks = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => commitThrows ? throw new Exception("commit response lost") : "Committed",
                () => throw new Exception("must not roll back committed connection"), () => "Committed",
                () => { edits++; return new Dictionary<string, object?>(); },
                () => OperatorNativeTransactionReceipt.Committed(new[] { 1543155L, 1542963L }));
            OperatorNativeTransactionExecution.ReadCommitted(response, () => { readbacks++; throw new Exception("Persisted connector no longer readable."); });
            Assert.Equal(1, edits); Assert.Equal(1, readbacks);
            Assert.Equal(true, response["applied"]);
            Assert.Equal(false, response["verified"]);
            Assert.Equal(false, response["success"]);
            Assert.False(response.ContainsKey("verifiedTargetElementIds"));
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", Route).EffectState);
        }

        [Fact]
        public void CommitReadbackAndAutoCreatedFittingsUseTheSharedInventoryBoundary()
        {
            var document = new object();
            var inventory = new OperatorNativeChangeInventory(document);
            int reads = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () =>
                {
                    inventory.Observe(() => document, () => new[] { 1543159L }, () => new[] { 1542963L, 1543155L }, () => Array.Empty<long>());
                    return "Committed";
                }, () => "RolledBack", () => "Committed", () => new Dictionary<string, object?>(), inventory.CommittedReceipt);
            OperatorNativeTransactionExecution.ReadCommitted(response, () => { reads++; return new Dictionary<string, object?>
                { ["verifiedTargetElementIds"] = new[] { 1542963L }, ["verifiedConnectionCount"] = 1 }; });
            Assert.Equal(1, reads);
            Assert.Equal(true, response["verified"]);
            Assert.Equal(new[] { 1543159L }, Assert.IsType<OperatorNativeTransactionReceipt>(response["transaction"]).AddedElementIds);
            Assert.Contains("element_id:1543159", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", Route).AffectedTargetIdentities);
        }

        [Fact]
        public void HandlerWiresSharedSettlementAndFreshPhysicalReadsInsteadOfPresentationStatus()
        {
            string? source = null;
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null && source == null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge.Logic/Handlers/MEP/ConnectMepElementsHandler.cs");
                    if (File.Exists(file)) { source = File.ReadAllText(file); break; }
                }
            Assert.NotNull(source);
            Assert.Contains("NativeSingleTransaction.Execute", source!);
            Assert.Contains("NativeMutationPreflightBoundary.Execute", source!);
            Assert.Contains("enterNativeScope();", source!);
            Assert.Contains("OperatorNativeTransactionReceipt.NotStarted()", source!);
            Assert.Contains("OperatorNativeTransactionExecution.ReadCommitted", source!);
            Assert.Contains("ConnectedTargetOwnerIds(doc, p.sourceElementId, targetIds, receipt.AddedElementIds)", source!);
            Assert.Contains("connector.IsConnectedTo(reference)", source!);
            Assert.Contains("reference.IsConnectedTo(connector)", source!);
            Assert.DoesNotContain("tx.Commit()", source!);
            Assert.DoesNotContain("rolledBack = true", source!);
        }
    }
}

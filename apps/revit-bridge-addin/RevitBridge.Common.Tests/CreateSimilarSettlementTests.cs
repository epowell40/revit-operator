using System;
using System.Collections.Generic;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class CreateSimilarSettlementTests
    {
        [Theory]
        [InlineData(true, "none")]
        [InlineData(false, "unknown")]
        public void ChildCommitCannotProvePreviewWithoutObservedOuterRollback(bool confirmed, string expected)
        {
            var result = new Dictionary<string, object?> { ["status"] = "Planned", ["dryRun"] = true, ["transactionStatus"] = "Committed" };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", "/revit/create-similar-from-instance").EffectState);
            result["transaction"] = OperatorNativeTransactionReceipt.FromAtomicGroupRollback(confirmed);
            Assert.Equal(expected, OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", "/revit/create-similar-from-instance").EffectState);
        }

        [Fact]
        public void FailedReadbackAfterApplyRetainsCommitAndCreationIdentities()
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed", () => throw new Exception("must not retry"),
                () => "Committed", () => new Dictionary<string, object?>(), () => OperatorNativeTransactionReceipt.Committed(Array.Empty<long>()),
                nativeCreatedElements: () => new long[] { 1736522 });
            result["success"] = false;
            result["error"] = "Post-commit image read failed";
            var settled = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/create-similar-from-instance");
            Assert.Equal("applied", settled.EffectState);
            Assert.Contains("element_id:1736522", settled.AffectedTargetIdentities);
        }

        [Fact]
        public void HandlerUsesNativeReceiptAndChecksTemporaryElementRemoval()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            string? source = null;
            while (directory != null)
            {
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge.Logic/Handlers/HostedPlacementHandlers.cs");
                    if (File.Exists(file)) { source = File.ReadAllText(file); break; }
                }
                if (source != null) break;
                directory = directory.Parent;
            }
            Assert.NotNull(source);
            var start = source!.IndexOf("public class CreateSimilarFromInstanceHandler", StringComparison.Ordinal);
            var end = source.IndexOf("public class ProjectPointToHostFrameHandler", start, StringComparison.Ordinal);
            var handler = source.Substring(start, end - start);
            Assert.Contains("var rollbackStatus = tg.RollBack()", handler);
            Assert.Contains("tg.GetStatus() == TransactionStatus.RolledBack", handler);
            Assert.Contains("doc.GetElement(ElementIdCompat.Create(id)) != null", handler);
            Assert.Contains("residualCreatedIds.Length == 0", handler);
            Assert.Contains("OperatorNativeTransactionReceipt.FromAtomicGroupRollback(rollbackConfirmed)", handler);
            Assert.Contains("NativeSingleTransaction.Execute(app, doc", handler);
            Assert.Contains("nativeApply[\"status\"] = \"CommittedWithErrors\"", handler);
        }
    }
}

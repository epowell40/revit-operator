using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ChangeTypeFailureHandlingTests
    {
        [Fact]
        public void TypeChangeInstallsExistingFailureGuardWithinStartedTransaction()
        {
            var root = Path.Combine(Path.GetDirectoryName(ThisFile())!, "..");
            var source = File.ReadAllText(Path.Combine(root, "RevitBridge.Logic", "Handlers", "ChangeElementTypeHandler.cs"));
            Assert.Contains("configureTransaction: tx => NativeNonInteractiveFailureHandling.Configure(tx, failureGuard)", source);
            Assert.Contains("result[\"capturedFailures\"] = failureGuard.Failures", source);
            Assert.Contains("result[\"failureRollbackRequested\"] = failureGuard.RollbackRequested", source);
            Assert.DoesNotContain("DeleteWarning", source);
            var transaction = File.ReadAllText(Path.Combine(root, "RevitBridge.Logic", "Handlers", "NativeSingleTransaction.cs"));
            Assert.True(transaction.IndexOf("configureTransaction?.Invoke(tx)", StringComparison.Ordinal)
                < transaction.IndexOf("return mutate(nativeCreated)", StringComparison.Ordinal));
        }

        [Theory]
        [InlineData("Error", "RolledBack", "none")]
        [InlineData("Warning", "RolledBack", "none")]
        [InlineData("Error", "Pending", "unknown")]
        public void HostValidationAtCommitPreservesFailureAndActualSettlement(string severity, string commitStatus, string effect)
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
                "Fixtures", "change-type-host-modal-42.json")));
            var root = fixture.RootElement;
            var ids = root.GetProperty("request").GetProperty("elementIds").EnumerateArray().Select(id => id.GetInt64()).ToArray();
            var message = root.GetProperty("native_failure").GetString()!;
            var guard = new OperatorNativeFailureGuard();
            var status = "Uninitialized";
            var configured = false;
            var clearAfterRollback = false;
            var committedInventoryRead = false;
            var result = OperatorNativeTransactionExecution.Execute(
                () => status = "Started",
                () => {
                    Assert.True(configured);
                    Assert.True(clearAfterRollback);
                    Assert.True(guard.Preprocess(() => new[] { message }, _ => severity, text => text,
                        _ => ids, _ => "retained-host-validation"));
                    return status = commitStatus;
                },
                () => status = "RolledBack", () => status,
                () => {
                    guard.ConfigureAfterStart(() => status, clear => clearAfterRollback = clear, () => configured = true);
                    // The temporary in-transaction type read matches. It must
                    // not become a successful apply when commit fails.
                    return new Dictionary<string, object?> { ["count"] = 2, ["changedElementIds"] = ids };
                },
                () => { committedInventoryRead = true; return OperatorNativeTransactionReceipt.Committed(ids); });
            result["capturedFailures"] = guard.Failures;
            result["failureRollbackRequested"] = guard.RollbackRequested;
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.False(Assert.IsType<bool>(result["success"]));
            Assert.False(committedInventoryRead);
            Assert.False(result.ContainsKey("changedElementIds"));
            Assert.Empty(receipt.ModifiedElementIds);
            Assert.Equal(message, Assert.Single(guard.Failures).message);
            Assert.Equal(ids, guard.Failures.Single().elementIds);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", root.GetProperty("path").GetString()!).EffectState);
        }

        private static string ThisFile([System.Runtime.CompilerServices.CallerFilePath] string file = "") => file;
    }
}

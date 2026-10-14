using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class SetParameterFailureHandlingTests
    {
        [Fact]
        public void ParameterPreviewAndApplyInstallFailureCaptureBeforeAnySetOrRegeneration()
        {
            var source = File.ReadAllText(Path.Combine(SourceRoot(), "RevitBridge", "Handlers", "SetParameterHandler.cs"));
            var configure = source.IndexOf("NativeNonInteractiveFailureHandling.Configure(trans, failureGuard,", StringComparison.Ordinal);
            Assert.True(configure > source.IndexOf("trans.Start();", StringComparison.Ordinal));
            Assert.True(configure < source.IndexOf("ParameterValueUtil.TrySetFromString", StringComparison.Ordinal));
            Assert.Contains("capturedFailures = failureGuard.Failures", source);
            Assert.Contains("failureRollbackRequested = failureGuard.RollbackRequested", source);
            Assert.Contains("commitStatus == TransactionStatus.RolledBack", source);
            Assert.Contains("if (apply && (committed || unchanged))", source);
            Assert.Contains("verificationPerformed = apply && (committed || unchanged)", source);
            Assert.Contains("changedCount == 0 && transactionReceipt.Status == \"rolled_back\"", source);
            Assert.DoesNotContain("DeleteWarning", source);
            Assert.Contains("captureBeforeSilentRollback: true", source);
        }

        [Theory]
        [InlineData("Error")]
        [InlineData("Warning")]
        public void PreviewRetainsPostedFailureBeforeSilentRollback(string severity)
        {
            var guard = new OperatorNativeFailureGuard();
            bool? clearBeforeCapture = null;
            guard.ConfigureAfterStart(() => "Started", clear => clearBeforeCapture = clear,
                () => { }, captureBeforeSilentRollback: true);
            Assert.False(clearBeforeCapture);
            Assert.True(guard.Preprocess(() => new[] { "Can't use this type in this host." },
                _ => severity, value => value, _ => new long[] { 1582196, 1582261 },
                _ => "retained-host-incompatibility"));
            Assert.Equal(severity, Assert.Single(guard.Failures).severity);
            Assert.True(guard.RollbackRequested);
            var adapter = File.ReadAllText(Path.Combine(SourceRoot(), "RevitBridge.Logic", "Handlers",
                "NativeNonInteractiveFailureHandling.cs"));
            Assert.True(adapter.IndexOf("_guard.Preprocess", StringComparison.Ordinal)
                < adapter.IndexOf("options.SetClearAfterRollback(true)", StringComparison.Ordinal));
            Assert.Contains("accessor.SetFailureHandlingOptions(options)", adapter);
        }

        [Theory]
        [InlineData("preview", "Error", "RolledBack", "none")]
        [InlineData("apply", "Error", "RolledBack", "none")]
        [InlineData("preview", "Warning", "RolledBack", "none")]
        [InlineData("apply", "Warning", "RolledBack", "none")]
        [InlineData("preview", "Error", "Pending", "unknown")]
        [InlineData("apply", "Error", "Pending", "unknown")]
        public void IncompatibleHostFailureRetainsReasonAndRequiresObservedRollbackForNoEffect(
            string effect, string severity, string status, string expectedEffect)
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
                "Fixtures", "set-parameter-host-type-modal-preview.json")));
            var root = fixture.RootElement;
            var ids = root.GetProperty("request").GetProperty("changes").EnumerateArray()
                .Select(change => change.GetProperty("elementId").GetInt64()).ToArray();
            var message = root.GetProperty("native_failure").GetString()!;
            var guard = new OperatorNativeFailureGuard();
            var installed = false;
            var clearOnRollback = false;
            guard.ConfigureAfterStart(() => "Started", clear => clearOnRollback = clear,
                () => installed = true);
            Assert.True(installed);
            Assert.True(clearOnRollback);
            Assert.True(guard.Preprocess(() => new[] { message }, _ => severity, value => value,
                _ => ids, _ => "retained-host-incompatibility"));
            var receipt = OperatorNativeTransactionReceipt.FromObservedStatus(status, ids);
            var response = new { status = "Native Failure", success = false,
                capturedFailures = guard.Failures, failureRollbackRequested = guard.RollbackRequested,
                transaction = receipt, verificationPerformed = false, verifiedCount = 0 };
            var settled = OperatorAttemptSuccessfulSettlement.Classify(response, effect, "POST", root.GetProperty("path").GetString()!);
            Assert.Equal(expectedEffect, settled.EffectState);
            Assert.Equal(message, Assert.Single(guard.Failures).message);
            Assert.Equal(ids, guard.Failures.Single().elementIds);
            Assert.Empty(receipt.ModifiedElementIds);
        }

        private static string SourceRoot([System.Runtime.CompilerServices.CallerFilePath] string file = "")
            => Path.Combine(Path.GetDirectoryName(file)!, "..");
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class NativeFailureGuardTests
    {
        private const string Route = "/revit/connect-existing-mep-branch";

        [Theory]
        [InlineData("RotateElementsHandler.cs")]
        [InlineData("MoveElementsHandler.cs")]
        public void OrdinaryTransformInstallsFailureRollbackPolicyAndReturnsNativeDiagnostics(string handler)
        {
            // Allow the retained producer source to exercise this same boundary
            // without replacing the working handler during a regression replay.
            var retainedMoveSource = Environment.GetEnvironmentVariable("OPERATOR_MOVE_HANDLER_SOURCE_FOR_TEST");
            var source = handler == "MoveElementsHandler.cs" && !string.IsNullOrWhiteSpace(retainedMoveSource)
                ? File.ReadAllText(retainedMoveSource) : ReadHandlerSource(handler);
            Assert.Contains("configureTransaction: transaction => NativeNonInteractiveFailureHandling.Configure(transaction, failureGuard)", source);
            Assert.Contains("response[\"capturedFailures\"] = failureGuard.Failures", source);
            Assert.Contains("response[\"failureRollbackRequested\"] = failureGuard.RollbackRequested", source);
        }

        [Theory]
        [InlineData(true, "RolledBack", false, "none")]
        [InlineData(true, "Pending", false, "unknown")]
        [InlineData(true, "Started", true, "unknown")]
        [InlineData(false, "RolledBack", false, "none")]
        public void ShortLineMoveFailureUsesOneObservedRollbackAndRetainsNativeReason(
            bool preview, string rollbackStatus, bool rollbackThrows, string effect)
        {
            const string message = "Line is too short.";
            var guard = new OperatorNativeFailureGuard();
            var calls = new List<string>();
            int rollbacks = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("failed move must not commit"), () =>
                {
                    rollbacks++;
                    Assert.True(guard.Preprocess(() => new[] { message }, _ => "Error", text => text,
                        _ => new[] { 41L, 42L }, _ => "native-short-line"));
                    if (rollbackThrows) throw new Exception("rollback unavailable");
                    return rollbackStatus;
                }, () => "Started", () =>
                {
                    guard.ConfigureAfterStart(() => "Started", clear => calls.Add("clear:" + clear),
                        () => calls.Add("install"));
                    calls.Add("move/regenerate");
                    throw new InvalidOperationException(message);
                }, () => throw new Exception("failed move has no committed inventory"),
                nativeModifiedElements: () => new[] { 41L, 42L },
                disposition: preview ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit);
            response["capturedFailures"] = guard.Failures;
            response["failureRollbackRequested"] = guard.RollbackRequested;
            Assert.Equal(new[] { "clear:True", "install", "move/regenerate" }, calls);
            Assert.Equal(1, rollbacks);
            Assert.Equal(false, response["success"]);
            Assert.False(response.ContainsKey("movedIds"));
            Assert.False(response.ContainsKey("snapshots"));
            Assert.Equal(message, Assert.Single(guard.Failures).message);
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(response["transaction"]);
            Assert.Empty(receipt.AffectedElementIds);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(response,
                preview ? "preview" : "apply", "POST", "/revit/move-elements").EffectState);
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void MoveCommitFailureDoesNotCreditTransientGeometryOrRepeatSettlement(string status, string effect)
        {
            var guard = new OperatorNativeFailureGuard();
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () =>
                {
                    Assert.True(guard.Preprocess(() => new[] { "Line is too short." }, _ => "Error", text => text,
                        _ => new[] { 41L }, _ => "native-short-line"));
                    return status;
                }, () => throw new Exception("do not repeat commit-time rollback"), () => status,
                () => new Dictionary<string, object?> { ["movedIds"] = new[] { 41L }, ["snapshots"] = new[] { "transient" } },
                () => throw new Exception("rejected move has no committed inventory"));
            Assert.Equal(false, response["success"]);
            Assert.False(response.ContainsKey("movedIds"));
            Assert.False(response.ContainsKey("snapshots"));
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(response,
                "apply", "POST", "/revit/move-elements").EffectState);
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void ConnectedFamilyRotationFailureNeverCreditsTransientGeometry(string commitStatus, string effect)
        {
            // Exact Revit error text retained from the connected-cap rotation GUI failure.
            const string message = "The family is connected in a network and can no longer keep the connectivity. Disconnect the family from the network?";
            var guard = new OperatorNativeFailureGuard();
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () =>
                {
                    Assert.True(guard.Preprocess(() => new[] { message }, _ => "Error", text => text,
                        _ => new[] { 41L }, _ => "native-network-error"));
                    return commitStatus;
                }, () => throw new Exception("do not repeat commit-time rollback"), () => commitStatus,
                () => new Dictionary<string, object?> { ["rotatedIds"] = new[] { 41L }, ["snapshots"] = new[] { "transient" } },
                () => throw new Exception("rejected rotation has no committed inventory"));
            response["capturedFailures"] = guard.Failures;
            response["failureRollbackRequested"] = guard.RollbackRequested;
            Assert.False((bool)response["success"]!);
            Assert.False(response.ContainsKey("rotatedIds"));
            Assert.False(response.ContainsKey("snapshots"));
            Assert.Equal(message, Assert.Single(guard.Failures).message);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/rotate-elements").EffectState);
        }

        [Fact]
        public void ConfigurationRequiresStartedOwnerAndClearsOnlyOnRollbackBeforeInstalling()
        {
            var calls = new List<string>();
            var guard = new OperatorNativeFailureGuard();
            Assert.Throws<InvalidOperationException>(() => guard.ConfigureAfterStart(() => "Uninitialized",
                clear => calls.Add("clear:" + clear), () => calls.Add("install")));
            Assert.Empty(calls);
            guard.ConfigureAfterStart(() => "Started", clear => calls.Add("clear:" + clear), () => calls.Add("install"));
            Assert.Equal(new[] { "clear:True", "install" }, calls);
        }

        [Fact]
        public void ExactModalWarningIsRetainedAndRequiresRollbackIncludingOnLaterEmptyPass()
        {
            using var fixture = ReadFixture();
            var message = fixture.RootElement.GetProperty("gui_warning").GetProperty("message").GetString()!;
            var guard = new OperatorNativeFailureGuard();
            Assert.True(guard.Preprocess(() => new[] { message }, _ => "Warning", text => text,
                _ => Array.Empty<long>(), _ => null));
            Assert.Equal(message, Assert.Single(guard.Failures).message);
            Assert.Empty(guard.Failures[0].elementIds); // Old GUI evidence has no native failing IDs.
            Assert.True(guard.Preprocess(() => Array.Empty<string>(), _ => "Warning", text => text,
                _ => Array.Empty<long>(), _ => null));
            var legacy = fixture.RootElement.GetProperty("bridge_failure");
            Assert.True(legacy.GetProperty("outcome_unknown").GetBoolean());
            Assert.Equal("revit_action_deadline_elapsed_outcome_unknown", legacy.GetProperty("bridge_code").GetString());
        }

        [Theory]
        [InlineData("Warning")]
        [InlineData("Error")]
        [InlineData("DocumentCorruption")]
        [InlineData("FutureUnknownSeverity")]
        public void EveryUnresolvedNativeMessageCapturesItsNativeIdentityAndRequestsRollback(string severity)
        {
            var guard = new OperatorNativeFailureGuard();
            Assert.True(guard.Preprocess(() => new[] { "native message" }, _ => severity, text => text,
                _ => new[] { 41L, 42L, 41L }, _ => "native-definition"));
            var failure = Assert.Single(guard.Failures);
            Assert.Equal(severity, failure.severity);
            Assert.Equal(new[] { 41L, 42L }, failure.elementIds);
            Assert.Equal("native-definition", failure.failureDefinitionId);
            Assert.Empty(failure.captureErrors);
        }

        [Fact]
        public void MissingFailureFieldsDoNotDiscardAvailableNativeTextOrElementIds()
        {
            var guard = new OperatorNativeFailureGuard();
            Assert.True(guard.Preprocess(() => new[] { "available message" }, _ => throw new Exception("severity unavailable"),
                text => text, _ => new[] { 41L }, _ => throw new Exception("definition unavailable")));
            var failure = Assert.Single(guard.Failures);
            Assert.Equal("available message", failure.message);
            Assert.Equal(new[] { 41L }, failure.elementIds);
            Assert.Equal("unknown", failure.severity);
            Assert.Equal(2, failure.captureErrors.Length);
        }

        [Fact]
        public void FailedMessageEnumerationCannotFallThroughToAnInteractiveCommit()
        {
            var guard = new OperatorNativeFailureGuard();
            Assert.True(guard.Preprocess<string>(() => throw new Exception("accessor unavailable"), _ => "Warning",
                text => text, _ => Array.Empty<long>(), _ => null));
            Assert.Equal("capture_error", Assert.Single(guard.Failures).severity);
        }

        [Theory]
        [InlineData(false, "RolledBack", "none")]
        [InlineData(true, "RolledBack", "none")]
        [InlineData(true, "Started", "unknown")]
        [InlineData(true, "Pending", "unknown")]
        public void RejectedChildCommitRollsBackActiveOuterGroupWithoutCreditingTransientChanges(
            bool preview, string outerRollbackStatus, string expectedEffect)
        {
            using var fixture = ReadFixture();
            var message = fixture.RootElement.GetProperty("gui_warning").GetProperty("message").GetString()!;
            var guard = new OperatorNativeFailureGuard();
            int rollbacks = 0;
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("rejected child cannot assimilate"),
                () => { rollbacks++; return outerRollbackStatus; }, () => "Started", () =>
                {
                    guard.ConfigureAfterStart(() => "Started", _ => { }, () => { });
                    var rollbackChild = guard.Preprocess(() => new[] { message }, _ => "Warning", text => text,
                        _ => new[] { 41L, 42L }, _ => "synthetic-neighbor-definition");
                    if (rollbackChild) throw new InvalidOperationException("The native connection transaction did not commit.");
                    return new Dictionary<string, object?> { ["success"] = true };
                }, () => throw new Exception("no committed inventory"),
                nativeCreatedElements: () => new[] { 43L }, nativeModifiedElements: () => new[] { 41L, 42L },
                disposition: preview ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit);
            result["capturedFailures"] = guard.Failures;
            result["failureRollbackRequested"] = guard.RollbackRequested;
            Assert.Equal(1, rollbacks);
            Assert.Equal(false, result["success"]);
            Assert.Equal(message, Assert.Single(guard.Failures).message);
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Empty(receipt.AffectedElementIds);
            Assert.Equal(expectedEffect, OperatorAttemptSuccessfulSettlement.Classify(result,
                preview ? "preview" : "apply", "POST", Route).EffectState);
        }

        [Fact]
        public void NoPostedFailuresPermitsCommitAndPreservesKnownEffectDespiteReadbackFailure()
        {
            var guard = new OperatorNativeFailureGuard();
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("known commit must not roll back"), () => "Committed", () =>
                {
                    Assert.False(guard.Preprocess(() => Array.Empty<string>(), _ => "Warning", text => text,
                        _ => Array.Empty<long>(), _ => null));
                    return new Dictionary<string, object?> { ["success"] = true };
                }, () => OperatorNativeTransactionReceipt.Committed(new[] { 41L, 42L }));
            OperatorNativeTransactionExecution.ReadCommitted(result, () => throw new Exception("readback unavailable"));
            Assert.Equal(false, result["success"]);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", Route).EffectState);
            Assert.Empty(guard.Failures);
        }

        [Fact]
        public void RollbackRequestWithoutActualTransactionOutcomeCannotEstablishNone()
        {
            var result = new { success = false, failureRollbackRequested = true, capturedFailures = new[] { "warning" } };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", Route).EffectState);
        }

        private static string ReadHandlerSource(string handler,
            [System.Runtime.CompilerServices.CallerFilePath] string sourceFile = "")
            => File.ReadAllText(Path.Combine(Path.GetDirectoryName(sourceFile)!, "..", "RevitBridge.Logic", "Handlers", handler));

        private static JsonDocument ReadFixture() => JsonDocument.Parse(File.ReadAllText(Path.Combine(
            AppContext.BaseDirectory, "Fixtures", "branch-preview-modal-deadline.json")));
    }
}

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
    public sealed class NativeBranchConnectionTransactionTests
    {
        private const string Route = "/revit/connect-existing-mep-branch";

        [Theory]
        [InlineData("mainElementId 42 is not an MEP curve.")]
        [InlineData("connectionMode must be takeoff_fitting or air_terminal_on_duct.")]
        public void RejectedNativePreflightSettlesNoneWithoutGuessingFromTheErrorText(string message)
        {
            var response = NativeMutationPreflightBoundary.Execute(_ => throw new ArgumentException(message));
            var result = Assert.IsType<Dictionary<string, object?>>(response);
            Assert.Equal(message, result["error"]);
            Assert.Equal(false, result["success"]);
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal("not_started", receipt.Status);
            Assert.Empty(receipt.AffectedElementIds);
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", Route).EffectState);
        }

        [Fact]
        public void PostNativeExceptionCannotBeReclassifiedAsNotStarted()
        {
            var error = new InvalidOperationException("native group response lost");
            Assert.Same(error, Assert.Throws<InvalidOperationException>(() =>
                NativeMutationPreflightBoundary.Execute(enter => { enter(); throw error; })));
        }

        [Fact]
        public void PostNativeUnknownAndCommittedReceiptsPassThroughUnchanged()
        {
            foreach (var receipt in new[] { OperatorNativeTransactionReceipt.Unknown("Pending"),
                OperatorNativeTransactionReceipt.Committed(new[] { 41L, 42L }) })
            {
                var actual = new Dictionary<string, object?> { ["transaction"] = receipt, ["success"] = false };
                Assert.Same(actual, NativeMutationPreflightBoundary.Execute(enter => { enter(); return actual; }));
            }
        }

        [Theory]
        [InlineData("directApply", "apply")]
        [InlineData("directPreview", "preview")]
        [InlineData("takeoffApply", "apply")]
        public void LegacyConnectionClaimsDoNotEstablishNativeEffect(string fixture, string effect)
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(
                AppContext.BaseDirectory, "Fixtures", "branch-handler-legacy-shapes.json")));
            var response = document.RootElement.GetProperty("synthetic_handler_shapes").GetProperty(fixture);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(response, effect, "POST", Route).EffectState);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void OuterCommitRetainsConnectedOwnersAndObservedCollateralWithoutRequiringNewElements(bool takeoff)
        {
            var owner = new object();
            var changes = new OperatorNativeChangeInventory(owner);
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("committed group must not roll back"), () => "Committed", () =>
                {
                    changes.Observe(() => owner, () => Array.Empty<long>(), () => new[] { 99L }, () => Array.Empty<long>());
                    return new Dictionary<string, object?> { ["status"] = "Connected", ["connectedAfterCommit"] = true };
                }, changes.CommittedReceipt,
                nativeCreatedElements: () => takeoff ? new[] { 43L } : Array.Empty<long>(),
                nativeModifiedElements: () => new[] { 41L, 42L });
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal(takeoff ? new[] { 43L } : Array.Empty<long>(), receipt.AddedElementIds);
            Assert.Equal(new[] { 41L, 42L, 99L }, receipt.ModifiedElementIds);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", Route);
            Assert.Equal("applied", settlement.EffectState);
            Assert.Contains("element_id:41", settlement.AffectedTargetIdentities);
            Assert.Contains("element_id:42", settlement.AffectedTargetIdentities);
            Assert.Contains("element_id:99", settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        [InlineData("Started", "unknown")]
        public void SuccessfulChildCommitCannotOverrideTheOuterPreviewOutcome(string groupStatus, string effect)
        {
            int childCommits = 0, groupRollbacks = 0;
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("preview must not assimilate"),
                () => { groupRollbacks++; return groupStatus; }, () => groupStatus, () =>
                {
                    childCommits++;
                    return new Dictionary<string, object?> { ["connectedAfterCommit"] = true };
                }, () => throw new Exception("child commit is not persistent authority"),
                nativeCreatedElements: () => new[] { 43L }, nativeModifiedElements: () => new[] { 41L, 42L },
                disposition: NativeTransactionDisposition.Rollback);
            Assert.Equal(1, childCommits);
            Assert.Equal(1, groupRollbacks);
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Empty(receipt.AddedElementIds);
            Assert.Empty(receipt.ModifiedElementIds);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", Route).EffectState);
        }

        [Fact]
        public void VerificationFailureAfterChildCommitRollsBackTheGroupOnce()
        {
            int rollbacks = 0;
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("failed verification must not assimilate"),
                () => { rollbacks++; return "RolledBack"; }, () => "Started",
                () => throw new Exception("The direct terminal connection did not survive child commit."),
                () => throw new Exception("no persistent changes"));
            Assert.Equal(1, rollbacks);
            Assert.Equal(false, result["success"]);
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", Route).EffectState);
        }

        [Theory]
        [InlineData("Started", "unknown")]
        [InlineData("RolledBack", "none")]
        public void RollbackExceptionRetainsObservedOuterOutcomeWithoutRetry(string observed, string effect)
        {
            int rollbacks = 0;
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("must not assimilate"),
                () => { rollbacks++; throw new Exception("outer rollback response lost"); }, () => observed,
                () => new Dictionary<string, object?> { ["connectedAfterCommit"] = true },
                () => throw new Exception("must not credit child commit"), disposition: NativeTransactionDisposition.Rollback);
            Assert.Equal(1, rollbacks);
            Assert.Equal(false, result["success"]);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", Route).EffectState);
        }

        [Fact]
        public void ObservedAssimilationSurvivesResponseAndReadbackFailure()
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("assimilation response lost"),
                () => throw new Exception("known commit must not roll back"), () => "Committed",
                () => new Dictionary<string, object?> { ["connectedAfterCommit"] = true },
                () => OperatorNativeTransactionReceipt.Committed(Array.Empty<long>()),
                nativeModifiedElements: () => new[] { 41L, 42L });
            OperatorNativeTransactionExecution.ReadCommitted(result, () => throw new Exception("fresh connector readback unavailable"));
            Assert.Equal(false, result["success"]);
            Assert.Equal(false, result["verified"]);
            Assert.Contains("assimilation response lost", Assert.IsType<string>(result["error"]));
            Assert.Contains("fresh connector readback unavailable", Assert.IsType<string>(result["error"]));
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", Route);
            Assert.Equal("applied", settlement.EffectState);
            Assert.Equal(new[] { "element_id:41", "element_id:42" }, settlement.AffectedTargetIdentities);
        }
    }
}

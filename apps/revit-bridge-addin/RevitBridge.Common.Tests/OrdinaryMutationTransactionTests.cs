using System;
using System.Collections.Generic;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OrdinaryMutationTransactionTests
    {
        [Fact]
        public void DeleteCascadeNativeReturnSurvivesMissingInventoryAndFailedReadback()
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("known commit must not roll back"), () => "Committed",
                () => new Dictionary<string, object?> { ["status"] = "Deleted" },
                () => throw new Exception("inventory unavailable"), nativeDeletedElements: () => new[] { 41L, 42L });
            OperatorNativeTransactionExecution.ReadCommitted(result, () => throw new Exception("readback unavailable"));
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal(new[] { 41L, 42L }, receipt.DeletedElementIds);
            Assert.Empty(receipt.AddedElementIds);
            Assert.Equal(false, result["success"]);
            Assert.Equal(false, result["verified"]);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/delete");
            Assert.Equal("applied", settlement.EffectState);
            Assert.Equal(new[] { "element_id:41", "element_id:42" }, settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void DeletePreviewDoesNotPromoteItsTransientCascade(string observed, string effect)
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("preview must not commit"), () => observed, () => observed,
                () => new Dictionary<string, object?> { ["impactedIds"] = new[] { 41L, 42L } },
                () => throw new Exception("preview has no persistent inventory"),
                disposition: NativeTransactionDisposition.Rollback,
                nativeDeletedElements: () => throw new Exception("transient IDs must not become deleted identities"));
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Empty(receipt.DeletedElementIds);
            Assert.Empty(receipt.AffectedElementIds);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", "/revit/delete").EffectState);
            Assert.Equal(observed == "RolledBack", result.ContainsKey("impactedIds"));
        }

        [Fact]
        public void DeletedIdentitySupplementDoesNotEraseObservedCollateralOrCreateModifiedIds()
        {
            var receipt = OperatorNativeTransactionReceipt.CommittedChanges(new[] { 31L }, new[] { 32L }, new[] { 33L })
                .WithNativeDeletedElements(new[] { 34L, 33L });
            Assert.Equal(new[] { 31L }, receipt.AddedElementIds);
            Assert.Equal(new[] { 32L }, receipt.ModifiedElementIds);
            Assert.Equal(new[] { 33L, 34L }, receipt.DeletedElementIds);
            Assert.Equal(new[] { 31L, 32L, 33L, 34L }, receipt.AffectedElementIds);
            Assert.Throws<InvalidOperationException>(() => OperatorNativeTransactionReceipt.RolledBack(Array.Empty<long>())
                .WithNativeDeletedElements(new[] { 34L }));
        }

        [Fact]
        public void NativeTypeReplacementReportsNewTypeAndReplacementPlusDeletedOriginal()
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("must not roll back"), () => "Committed",
                () => new Dictionary<string, object?> { ["newTypeId"] = 51L, ["resultingInstanceId"] = 52L },
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), new[] { 53L }, Array.Empty<long>()),
                nativeCreatedElements: () => new[] { 51L, 52L }, nativeDeletedElements: () => new[] { 41L });
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal(new[] { 51L, 52L }, receipt.AddedElementIds);
            Assert.Equal(new[] { 41L }, receipt.DeletedElementIds);
            Assert.Equal(new[] { 53L }, receipt.ModifiedElementIds);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST",
                "/revit/duplicate-type-and-swap-instance").EffectState);
        }

        [Fact]
        public void FailedBatchMutationRollsBackBeforeAnyNativeSupplementBecomesPersistent()
        {
            int rollbacks = 0;
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("failed batch cannot commit"), () => { rollbacks++; return "RolledBack"; }, () => "Started",
                () => throw new Exception("second target failed after first target changed"),
                () => throw new Exception("no committed inventory"), nativeCreatedElements: () => new[] { 51L },
                nativeModifiedElements: () => new[] { 41L }, nativeDeletedElements: () => new[] { 42L });
            Assert.Equal(1, rollbacks);
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Empty(receipt.AffectedElementIds);
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/change-element-type").EffectState);
        }

        [Fact]
        public void BulkConfirmationRemainsActionableWithoutAdmittingAMutation()
        {
            var result = Assert.IsType<Dictionary<string, object?>>(NativeMutationPreflightBoundary.Execute(_ =>
                throw new OperatorToolUserErrorException("Bulk delete requires typed confirmation.", "bulk_confirm_required",
                    "DELETE 26 ELEMENTS", "", 10, "Use the returned confirmation value.")));
            Assert.Equal("bulk_confirm_required", result["code"]);
            Assert.Equal("DELETE 26 ELEMENTS", result["requiredConfirm"]);
            Assert.Equal("", result["confirmReceived"]);
            Assert.Equal(10, result["maxChangesPerCall"]);
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/delete").EffectState);
        }

        [Fact]
        public void PartialParameterCommitCannotClaimWholeRequestVerification()
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("partial writes preserve existing commit semantics"), () => "Committed",
                () => new Dictionary<string, object?> { ["success"] = false, ["parameterChangesComplete"] = false },
                () => OperatorNativeTransactionReceipt.Committed(new[] { 41L }));
            OperatorNativeTransactionExecution.ReadCommitted(result,
                () => new Dictionary<string, object?> { ["successfulParameterReadbacksVerified"] = true }, requestedChangesComplete: false);
            Assert.Equal(false, result["success"]);
            Assert.Equal(false, result["ok"]);
            Assert.Equal(false, result["verified"]);
            Assert.Equal(true, result["successfulParameterReadbacksVerified"]);
            Assert.Equal("CommittedWithErrors", OperatorNativeTransactionExecution.OutcomeStatus(result, "Applied"));
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/set-type-parameters").EffectState);
        }

        [Fact]
        public void PresentationDistinguishesUnknownFromObservedRollback()
        {
            var result = new Dictionary<string, object?> { ["success"] = false, ["transaction"] = OperatorNativeTransactionReceipt.Unknown("Pending") };
            Assert.Equal("UnknownEffect", OperatorNativeTransactionExecution.OutcomeStatus(result, "Applied"));
            result["transaction"] = OperatorNativeTransactionReceipt.RolledBack(Array.Empty<long>());
            Assert.Equal("Blocked", OperatorNativeTransactionExecution.OutcomeStatus(result, "Applied"));
        }
    }
}

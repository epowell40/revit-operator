using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorAttemptSettlementTests
    {
        [Fact]
        public void PreDispatchFailureIsAuthoritativeNone()
        {
            var failure = OperatorCourierFailureClassifier.Classify(
                new OperatorToolUserErrorException(
                    "Typed confirmation is required.",
                    "confirmation_required",
                    requiredConfirm: "confirm",
                    confirmReceived: "wrong",
                    hint: "Confirm the exact mutation."));
            var settlement = OperatorAttemptFailureSettlement.FromFailure(failure, "apply", "POST", "/revit/move-elements");

            Assert.False(settlement.RequestDispatched);
            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("schema_validator", settlement.EffectAuthority);
        }

        [Fact]
        public void CorrectableTextConfirmationRejectionIsNoEffectAndRetryable()
        {
            var failure = OperatorCourierFailureClassifier.Classify(
                new OperatorToolUserErrorException(
                    "TextNote edit requires typed confirmation.",
                    "bulk_confirm_required",
                    requiredConfirm: "APPLY 1 TEXT NOTE CHANGE",
                    confirmReceived: ""));
            var settlement = OperatorAttemptFailureSettlement.FromFailure(
                failure, "apply", "POST", "/revit/replace-text-note");

            Assert.True(failure.Retryable);
            Assert.False(settlement.RequestDispatched);
            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("schema_validator", settlement.EffectAuthority);
            Assert.Equal("bulk_confirm_required", settlement.EffectReason);
        }

        [Fact]
        public void PostDispatchTimeoutIsUnknownAndNotRetryable()
        {
            var failure = OperatorCourierFailureClassifier.Classify(
                new OperatorActionDeadlineExceededException("model_mutation", 85_000, "attempt-1"));
            var settlement = OperatorAttemptFailureSettlement.FromFailure(failure, "apply", "POST", "/revit/move-elements");

            Assert.True(settlement.RequestDispatched);
            Assert.Equal("unknown", settlement.EffectState);
            Assert.False(failure.Retryable);
        }

        [Fact]
        public void NativeTransactionCommitAndRollbackProduceDifferentTruth()
        {
            var committed = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = new { status = "committed", committed = true, modified_element_ids = new[] { 42L } }
            }, "apply", "POST", "/revit/native-api-mutation-ops");
            var rolledBack = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = new { status = "rolled_back", committed = false, modified_element_ids = new[] { 42L } }
            }, "preview", "POST", "/revit/native-api-mutation-ops");

            Assert.Equal("applied", committed.EffectState);
            Assert.Equal("native_transaction", committed.EffectAuthority);
            Assert.Contains("element_id:42", committed.AffectedTargetIdentities);
            Assert.Equal("none", rolledBack.EffectState);
            Assert.Equal("native_rollback", rolledBack.EffectAuthority);
        }

        [Fact]
        public void UnprovenMutationSuccessRemainsUnknown()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(
                new { status = "Moved", rolledBack = false },
                "apply", "POST", "/revit/move-elements");

            Assert.True(settlement.RequestDispatched);
            Assert.Equal("unknown", settlement.EffectState);
            Assert.Equal("native_host", settlement.EffectAuthority);
        }

        [Fact]
        public void NativeNotStartedTransactionIsAuthoritativeNoEffect()
        {
            var noEffect = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = new { status = "not_started", committed = false, modified_element_ids = new long[0] }
            }, "apply", "POST", "/revit/replace-text-note");

            Assert.Equal("none", noEffect.EffectState);
            Assert.Equal("native_transaction", noEffect.EffectAuthority);
            Assert.Equal("native_transaction_not_started", noEffect.EffectReason);
        }

        [Fact]
        public void TextNoteTransactionReceiptFactoriesPreserveCommittedRollbackAndNoEffectTruth()
        {
            var committed = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = OperatorNativeTransactionReceipt.Committed(new[] { 42L })
            }, "apply", "POST", "/revit/replace-text-note");
            var preview = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = OperatorNativeTransactionReceipt.RolledBack(new[] { 42L })
            }, "preview", "POST", "/revit/replace-text-note");
            var unchanged = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = OperatorNativeTransactionReceipt.NotStarted(new[] { 42L })
            }, "apply", "POST", "/revit/set-text-note-text");

            Assert.Equal("applied", committed.EffectState);
            Assert.Equal("none", preview.EffectState);
            Assert.Equal("none", unchanged.EffectState);
            Assert.Contains("element_id:42", committed.AffectedTargetIdentities);
        }

        [Fact]
        public void GenericParameterPreviewRollbackIsAuthoritativeNoEffect()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Dry Run",
                dryRun = true,
                changedCount = 1,
                transaction = OperatorNativeTransactionReceipt.RolledBack(new[] { 42L })
            }, "preview", "POST", "/revit/set-parameter");

            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("native_rollback", settlement.EffectAuthority);
            Assert.Equal("verified_native_rollback", settlement.EffectReason);
            Assert.Contains("element_id:42", settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void GenericParameterApplyCommitIsAuthoritativeApplied()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Applied and Verified",
                dryRun = false,
                changedCount = 1,
                transaction = OperatorNativeTransactionReceipt.Committed(new[] { 42L })
            }, "apply", "POST", "/revit/set-parameter");

            Assert.Equal("applied", settlement.EffectState);
            Assert.Equal("native_transaction", settlement.EffectAuthority);
            Assert.Contains("element_id:42", settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void GenericParameterNoChangeAndPreconditionRollbackRemainRetrySafe()
        {
            foreach (var response in new object[]
            {
                new { status = "No Change Required", transaction = OperatorNativeTransactionReceipt.RolledBack(new[] { 42L }) },
                new { status = "Precondition Failed", transaction = OperatorNativeTransactionReceipt.RolledBack(new[] { 42L }) }
            })
            {
                var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/set-parameter");
                Assert.Equal("none", settlement.EffectState);
                Assert.Equal("native_rollback", settlement.EffectAuthority);
            }
        }

        [Fact]
        public void GenericParameterMutationWithoutTransactionTruthRemainsUnknown()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Applied and Verified",
                dryRun = false,
                changedCount = 1,
                changedElementIds = new[] { 42L }
            }, "apply", "POST", "/revit/set-parameter");

            Assert.Equal("unknown", settlement.EffectState);
            Assert.Equal("native_handler_returned_without_authoritative_settlement", settlement.EffectReason);
        }

        [Fact]
        public void UnrelatedReadIgnoresPresentationTransactionFieldsAndRemainsNoEffect()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Inventory Complete",
                transaction = new { status = "committed", committed = true, modified_element_ids = new[] { 42L } }
            }, "read", "POST", "/revit/find-text-notes");

            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("read_has_no_persistent_effect", settlement.EffectReason);
        }

        [Theory]
        [InlineData("committed", false)]
        [InlineData("rolled_back", true)]
        [InlineData("pending", false)]
        public void ContradictoryOrUnrecognizedTransactionSettlementRemainsUnknown(string status, bool committed)
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = new { status, committed, modified_element_ids = new[] { 42L } }
            }, "apply", "POST", "/revit/replace-text-note");

            Assert.Equal("unknown", settlement.EffectState);
        }

        [Fact]
        public void AttachedEnvelopeCarriesAssignmentFenceAndCannotBeSpoofedByHandler()
        {
            var attached = OperatorAttemptSuccessfulSettlement.Attach(
                new Dictionary<string, object?>
                {
                    ["status"] = "ok",
                    ["canonical_attempt_settlement"] = new { effect_state = "applied" }
                },
                "read", "GET", "/revit/context",
                "assignment-1", "attempt-1", "run-1", 7, "sha256:action", "sha256:target");
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(attached));
            var settlement = document.RootElement.GetProperty("canonical_attempt_settlement");

            Assert.Equal(1, document.RootElement.EnumerateObject().Count(property => property.Name == "canonical_attempt_settlement"));
            Assert.Equal("assignment-1", settlement.GetProperty("assignment_id").GetString());
            Assert.Equal(7, settlement.GetProperty("generation").GetInt32());
            Assert.Equal("none", settlement.GetProperty("effect_state").GetString());
        }
    }
}

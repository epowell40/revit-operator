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

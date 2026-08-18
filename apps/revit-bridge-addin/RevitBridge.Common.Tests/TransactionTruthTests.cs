using System;
using System.Collections.Generic;
using System.Text.Json;
using RevitBridge.Logic.Handlers;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class TransactionTruthTests
    {
        [Theory]
        [InlineData("null")]
        [InlineData("{}")]
        [InlineData("{\"kind\":\"\"}")]
        [InlineData("{\"kind\":\"notSupported\"}")]
        [InlineData("{\"kind\":\"delete\"}")]
        [InlineData("{\"kind\":\"delete\",\"ids\":[]}")]
        [InlineData("{\"kind\":\"setParameters\",\"changes\":[]}")]
        [InlineData("{\"kind\":\"placeFamilies\",\"levelName\":\"L1\",\"symbolName\":\"Desk\",\"instances\":[]}")]
        public void InvalidActionShapesReturnFailedOutcomes(string json)
        {
            using var document = JsonDocument.Parse(json);
            var warnings = new List<string>();

            var outcome = TransactionActionRunner.ValidateAction(document.RootElement, warnings, 0);

            Assert.False(outcome.Success);
            Assert.NotEmpty(outcome.Errors);
            Assert.NotEmpty(warnings);
        }

        [Fact]
        public void PartialOperationFailureCannotReportActionSuccess()
        {
            var warnings = new List<string>();
            var outcome = new TransactionActionRunner.ActionOutcome(2, "setParameters");

            outcome.Attempt();
            outcome.Succeed();
            outcome.Attempt();
            outcome.Fail(warnings, "Action[2] failed its second change.");

            Assert.False(outcome.Success);
            Assert.Equal(2, outcome.AttemptedOperations);
            Assert.Equal(1, outcome.SucceededOperations);
            Assert.Single(outcome.Errors);
            Assert.Single(warnings);
        }

        [Fact]
        public void RollbackFailureReceiptPreservesPrimaryAndRollbackErrors()
        {
            var receipt = new TransactionActionRunner.TransactionOperationReceipt
            {
                Attempted = true,
                Succeeded = false,
                Status = "Pending",
                Error = "rollback exception",
                VerifiedRolledBack = false
            };

            var error = TransactionActionRunner.BuildFailureError("action failed", receipt);

            Assert.True(receipt.Failed);
            Assert.Contains("action failed", error);
            Assert.Contains("Rollback failed", error);
            Assert.Contains("rollback exception", error);
        }

        [Fact]
        public void VerifiedRollbackWithoutExplicitAttemptIsNotClaimedAsAttemptSuccess()
        {
            var receipt = new TransactionActionRunner.TransactionOperationReceipt
            {
                Attempted = false,
                Succeeded = false,
                Status = "RolledBack",
                VerifiedRolledBack = true
            };

            Assert.False(receipt.Attempted);
            Assert.False(receipt.Succeeded);
            Assert.False(receipt.Failed);
            Assert.True(receipt.VerifiedRolledBack);
            Assert.Equal("action failed", TransactionActionRunner.BuildFailureError("action failed", receipt));
        }

        [Fact]
        public void FaultBeforeAssimilationUsesVerifiedRollbackAndCannotClaimCommit()
        {
            var phase = new TransactionApplyPhaseState();
            var assimilate = new TransactionActionRunner.TransactionOperationReceipt();
            var rollback = new TransactionActionRunner.TransactionOperationReceipt();
            var rollbackCalls = 0;

            var disposition = phase.ResolveFailure(
                InjectFault("before assimilation"),
                assimilate,
                rollback,
                () =>
                {
                    rollbackCalls++;
                    rollback.Attempted = true;
                    TransactionOperationTruth.RecordExpectedStatus(
                        rollback,
                        "RolledBack",
                        "RolledBack");
                });

            Assert.Equal(1, rollbackCalls);
            Assert.False(disposition.Committed);
            Assert.True(disposition.RolledBack);
            Assert.Equal("rolledBack", disposition.ImpactState);
            Assert.Equal("before assimilation", disposition.FailureError);
            Assert.Null(disposition.PostCommitWarning);
            Assert.True(rollback.Attempted);
            Assert.True(rollback.Succeeded);
            Assert.True(rollback.VerifiedRolledBack);
        }

        [Theory]
        [InlineData("artifact serialization")]
        [InlineData("response construction")]
        public void FaultAfterAssimilationPreservesCommitAndSkipsRollback(string fault)
        {
            var phase = new TransactionApplyPhaseState();
            var assimilate = SuccessfulReceipt("Committed");
            var rollback = new TransactionActionRunner.TransactionOperationReceipt();
            var rollbackCalls = 0;
            phase.ObserveAssimilateReceipt(assimilate);

            var disposition = phase.ResolveFailure(
                InjectFault(fault),
                assimilate,
                rollback,
                () => rollbackCalls++);

            Assert.Equal(0, rollbackCalls);
            Assert.True(disposition.Committed);
            Assert.False(disposition.RolledBack);
            Assert.Equal("committed", disposition.ImpactState);
            Assert.Null(disposition.FailureError);
            Assert.Contains(fault, disposition.PostCommitWarning);
            Assert.False(rollback.Attempted);
            Assert.False(rollback.VerifiedRolledBack);
        }

        [Fact]
        public void AssimilateExceptionWithCommittedStatusStillPreservesCommit()
        {
            var phase = new TransactionApplyPhaseState();
            var assimilate = SuccessfulReceipt("Committed");
            assimilate.Error = "Assimilate threw after committing.";
            var rollback = new TransactionActionRunner.TransactionOperationReceipt();
            var rollbackCalls = 0;

            var disposition = phase.ResolveFailure(
                InjectFault(assimilate.Error),
                assimilate,
                rollback,
                () => rollbackCalls++);

            Assert.Equal(0, rollbackCalls);
            Assert.True(phase.IsCommitted);
            Assert.True(disposition.Committed);
            Assert.Equal("committed", disposition.ImpactState);
            Assert.False(disposition.RolledBack);
        }

        [Fact]
        public void AssimilateExceptionPromotesCommittedStatusObservedByRollbackProbe()
        {
            var phase = new TransactionApplyPhaseState();
            var assimilate = new TransactionActionRunner.TransactionOperationReceipt
            {
                Attempted = true,
                Succeeded = false,
                Status = "StatusUnavailable",
                Error = "Assimilate outcome was initially unavailable."
            };
            var rollback = new TransactionActionRunner.TransactionOperationReceipt();
            var rollbackProbeCalls = 0;

            var disposition = phase.ResolveFailure(
                InjectFault(assimilate.Error),
                assimilate,
                rollback,
                () =>
                {
                    rollbackProbeCalls++;
                    rollback.Attempted = false;
                    rollback.Succeeded = false;
                    rollback.Status = "Committed";
                    rollback.Error = "Rollback was not attempted because the group is committed.";
                });

            Assert.Equal(1, rollbackProbeCalls);
            Assert.True(phase.IsCommitted);
            Assert.True(disposition.Committed);
            Assert.Equal("committed", disposition.ImpactState);
            Assert.False(disposition.RolledBack);
            Assert.False(rollback.Attempted);
            Assert.False(rollback.VerifiedRolledBack);
        }

        [Fact]
        public void RollbackFailureIsNotReportedAsRollbackSuccess()
        {
            var phase = new TransactionApplyPhaseState();
            var assimilate = new TransactionActionRunner.TransactionOperationReceipt();
            var rollback = new TransactionActionRunner.TransactionOperationReceipt();

            var disposition = phase.ResolveFailure(
                InjectFault("action failed"),
                assimilate,
                rollback,
                () =>
                {
                    rollback.Attempted = true;
                    rollback.Succeeded = false;
                    rollback.Status = "Error";
                    rollback.Error = "rollback exception";
                    rollback.VerifiedRolledBack = false;
                });

            Assert.False(disposition.Committed);
            Assert.False(disposition.RolledBack);
            Assert.Equal("notCommittedOrUnknown", disposition.ImpactState);
            Assert.Contains("Rollback failed", disposition.FailureError);
            Assert.Contains("rollback exception", disposition.FailureError);
            Assert.True(rollback.Attempted);
            Assert.False(rollback.VerifiedRolledBack);
        }

        [Fact]
        public void UnknownRollbackOutcomeIsNotReportedAsAttemptOrSuccess()
        {
            var phase = new TransactionApplyPhaseState();
            var assimilate = new TransactionActionRunner.TransactionOperationReceipt();
            var rollback = new TransactionActionRunner.TransactionOperationReceipt();

            var disposition = phase.ResolveFailure(
                InjectFault("action failed"),
                assimilate,
                rollback,
                () =>
                {
                    rollback.Attempted = false;
                    rollback.Succeeded = false;
                    rollback.Status = "StatusUnavailable";
                    rollback.Error = "status read failed";
                    rollback.VerifiedRolledBack = false;
                });

            Assert.False(disposition.Committed);
            Assert.False(disposition.RolledBack);
            Assert.Equal("notCommittedOrUnknown", disposition.ImpactState);
            Assert.Contains("Rollback outcome unknown", disposition.FailureError);
            Assert.Contains("status read failed", disposition.FailureError);
            Assert.False(rollback.Attempted);
            Assert.False(rollback.VerifiedRolledBack);
        }

        [Fact]
        public void OperationStatusesOnlySucceedForTheirExpectedPhase()
        {
            var start = new TransactionActionRunner.TransactionOperationReceipt { Attempted = true };
            var commit = new TransactionActionRunner.TransactionOperationReceipt { Attempted = true };
            var assimilate = new TransactionActionRunner.TransactionOperationReceipt { Attempted = true };
            var rollback = new TransactionActionRunner.TransactionOperationReceipt { Attempted = true };
            var wrongCommit = new TransactionActionRunner.TransactionOperationReceipt { Attempted = true };

            TransactionOperationTruth.RecordExpectedStatus(start, "Started", "Started");
            TransactionOperationTruth.RecordExpectedStatus(commit, "Committed", "Committed");
            TransactionOperationTruth.RecordExpectedStatus(assimilate, "Committed", "Committed");
            TransactionOperationTruth.RecordExpectedStatus(rollback, "RolledBack", "RolledBack");
            TransactionOperationTruth.RecordExpectedStatus(wrongCommit, "Pending", "Committed");

            Assert.True(start.Succeeded);
            Assert.Equal("Started", start.Status);
            Assert.True(commit.Succeeded);
            Assert.Equal("Committed", commit.Status);
            Assert.True(assimilate.Succeeded);
            Assert.Equal("Committed", assimilate.Status);
            Assert.True(rollback.Succeeded);
            Assert.True(rollback.VerifiedRolledBack);
            Assert.False(wrongCommit.Succeeded);
            Assert.Equal("Pending", wrongCommit.Status);
        }

        [Fact]
        public void ActionFailureKeepsFailedOutcomeAndVerifiedRollbackMetadata()
        {
            var warnings = new List<string>();
            var outcome = new TransactionActionRunner.ActionOutcome(3, "setParameters");
            outcome.Attempt();
            outcome.Fail(warnings, "native action failed");

            var rollback = new TransactionActionRunner.TransactionOperationReceipt { Attempted = true };
            TransactionOperationTruth.RecordExpectedStatus(rollback, "RolledBack", "RolledBack");

            Assert.False(outcome.Success);
            Assert.Single(outcome.Errors);
            Assert.True(rollback.Succeeded);
            Assert.True(rollback.VerifiedRolledBack);
            Assert.Equal("RolledBack", rollback.Status);
        }

        [Theory]
        [InlineData("{\"kind\":\"createDependentView\",\"sourceViewId\":1363403,\"resultRef\":\"enlarged\"}")]
        [InlineData("{\"kind\":\"setViewCrop\",\"viewId\":\"$enlarged\",\"cropBox\":{\"min\":{\"x\":0,\"y\":0},\"max\":{\"x\":10,\"y\":8}}}")]
        [InlineData("{\"kind\":\"setViewScale\",\"viewRef\":\"enlarged\",\"scale\":48}")]
        [InlineData("{\"kind\":\"createSheet\",\"number\":\"M1.10\",\"resultRef\":\"sheet\"}")]
        [InlineData("{\"kind\":\"placeView\",\"sheetId\":\"$sheet\",\"viewId\":\"$enlarged\",\"x\":1.5,\"y\":1.0,\"resultRef\":\"viewport\"}")]
        public void ViewAndSheetCompositionShapesAreAdmitted(string json)
        {
            using var document = JsonDocument.Parse(json);
            var warnings = new List<string>();

            var outcome = TransactionActionRunner.ValidateAction(document.RootElement, warnings, 2);

            Assert.Empty(outcome.Errors);
            Assert.Empty(warnings);
        }

        [Theory]
        [InlineData("{\"kind\":\"createDependentView\",\"sourceViewId\":0}")]
        [InlineData("{\"kind\":\"setViewCrop\",\"viewId\":\"$missing\"}")]
        [InlineData("{\"kind\":\"setViewScale\",\"viewId\":\"$view\",\"scale\":0}")]
        [InlineData("{\"kind\":\"placeView\",\"sheetId\":\"$sheet\"}")]
        [InlineData("{\"kind\":\"createSheet\",\"resultRef\":\"bad\\nref\"}")]
        public void InvalidViewAndSheetCompositionShapesFailClosed(string json)
        {
            using var document = JsonDocument.Parse(json);
            var warnings = new List<string>();

            var outcome = TransactionActionRunner.ValidateAction(document.RootElement, warnings, 4);

            Assert.NotEmpty(outcome.Errors);
            Assert.NotEmpty(warnings);
        }

        [Fact]
        public void ActionReferencesAreBackwardOnlyAndCannotBeRebound()
        {
            var context = new TransactionActionRunner.ActionExecutionContext();

            Assert.False(context.TryResolve("$enlarged", out _));
            Assert.True(context.TryRegister("enlarged", 1363403, out var firstError));
            Assert.Equal(string.Empty, firstError);
            Assert.True(context.TryResolve("$enlarged", out var resolved));
            Assert.Equal(1363403, resolved);
            Assert.False(context.TryRegister("$enlarged", 1363404, out var duplicateError));
            Assert.Contains("already bound", duplicateError);
        }

        private static TransactionActionRunner.TransactionOperationReceipt SuccessfulReceipt(string status)
        {
            var receipt = new TransactionActionRunner.TransactionOperationReceipt { Attempted = true };
            TransactionOperationTruth.RecordExpectedStatus(receipt, status, status);
            return receipt;
        }

        private static Exception InjectFault(string message)
        {
            try
            {
                throw new InvalidOperationException(message);
            }
            catch (Exception ex)
            {
                return ex;
            }
        }
    }
}

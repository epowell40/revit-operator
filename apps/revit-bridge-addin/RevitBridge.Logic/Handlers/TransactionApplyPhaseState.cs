using System;

namespace RevitBridge.Logic.Handlers
{
    internal enum TransactionApplyPhase
    {
        BeforeAssimilation,
        Committed
    }

    internal sealed class TransactionFailureDisposition
    {
        internal TransactionFailureDisposition(
            bool committed,
            bool rolledBack,
            string impactState,
            string? failureError,
            string? postCommitWarning)
        {
            Committed = committed;
            RolledBack = rolledBack;
            ImpactState = impactState;
            FailureError = failureError;
            PostCommitWarning = postCommitWarning;
        }

        internal bool Committed { get; }
        internal bool RolledBack { get; }
        internal string ImpactState { get; }
        internal string? FailureError { get; }
        internal string? PostCommitWarning { get; }
    }

    internal sealed class TransactionApplyPhaseState
    {
        private const string CommittedStatus = "Committed";

        internal TransactionApplyPhase Phase { get; private set; } = TransactionApplyPhase.BeforeAssimilation;
        internal bool IsCommitted => Phase == TransactionApplyPhase.Committed;
        internal string WireName => IsCommitted ? "committed" : "beforeAssimilation";

        internal void ObserveAssimilateReceipt(TransactionActionRunner.TransactionOperationReceipt receipt)
        {
            if (ReceiptProvesCommitted(receipt))
                Phase = TransactionApplyPhase.Committed;
        }

        internal TransactionFailureDisposition ResolveFailure(
            Exception failure,
            TransactionActionRunner.TransactionOperationReceipt assimilateReceipt,
            TransactionActionRunner.TransactionOperationReceipt rollbackReceipt,
            Action attemptRollback)
        {
            ObserveAssimilateReceipt(assimilateReceipt);
            if (IsCommitted)
                return CommittedDisposition(failure);

            try
            {
                attemptRollback();
            }
            catch (Exception rollbackException)
            {
                rollbackReceipt.Attempted = true;
                rollbackReceipt.Succeeded = false;
                rollbackReceipt.VerifiedRolledBack = false;
                rollbackReceipt.Status = "StatusUnavailable";
                rollbackReceipt.Error = rollbackException.Message;
            }

            // Assimilate can throw after Revit has committed the group. A
            // status read performed by the rollback path is still valid proof
            // of commitment and must win over the exception path.
            if (string.Equals(rollbackReceipt.Status, CommittedStatus, StringComparison.Ordinal))
            {
                Phase = TransactionApplyPhase.Committed;
                return CommittedDisposition(failure);
            }

            var rolledBack = rollbackReceipt.VerifiedRolledBack;
            return new TransactionFailureDisposition(
                committed: false,
                rolledBack: rolledBack,
                impactState: rolledBack ? "rolledBack" : "notCommittedOrUnknown",
                failureError: BuildPreCommitFailureError(failure.Message, rollbackReceipt),
                postCommitWarning: null);
        }

        private static bool ReceiptProvesCommitted(TransactionActionRunner.TransactionOperationReceipt receipt)
        {
            return receipt.Attempted &&
                receipt.Succeeded &&
                string.Equals(receipt.Status, CommittedStatus, StringComparison.Ordinal) &&
                !receipt.VerifiedRolledBack;
        }

        private static TransactionFailureDisposition CommittedDisposition(Exception failure)
        {
            return new TransactionFailureDisposition(
                committed: true,
                rolledBack: false,
                impactState: "committed",
                failureError: null,
                postCommitWarning: $"Transaction committed, but post-commit processing failed: {failure.Message}");
        }

        private static string BuildPreCommitFailureError(
            string primaryError,
            TransactionActionRunner.TransactionOperationReceipt rollbackReceipt)
        {
            if (rollbackReceipt.VerifiedRolledBack)
                return primaryError;

            var rollbackDetail = string.IsNullOrWhiteSpace(rollbackReceipt.Error)
                ? $"transaction group status is '{rollbackReceipt.Status}'"
                : rollbackReceipt.Error;

            return rollbackReceipt.Attempted
                ? $"{primaryError} Rollback failed: {rollbackDetail}"
                : $"{primaryError} Rollback outcome unknown: {rollbackDetail}";
        }
    }

    internal static class TransactionOperationTruth
    {
        internal static void RecordExpectedStatus(
            TransactionActionRunner.TransactionOperationReceipt receipt,
            string actual,
            string expected)
        {
            receipt.Status = actual;
            receipt.Succeeded = string.Equals(actual, expected, StringComparison.Ordinal);
            receipt.VerifiedRolledBack = string.Equals(actual, "RolledBack", StringComparison.Ordinal);
        }
    }
}

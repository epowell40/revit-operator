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
    }
}

using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorActionDeadlinePolicyTests
    {
        [Theory]
        [InlineData("POST", "/revit/tool-search", "low", "control_plane", 10000)]
        [InlineData("POST", "/revit/sheets", "low", "bounded_read", 60000)]
        [InlineData("POST", "/revit/create-text", "medium", "interactive_or_export", 75000)]
        [InlineData("POST", "/revit/update-parameter-by-query", "high", "model_mutation", 85000)]
        [InlineData("POST", "/revit/export-ifc", "low", "extended", 210000)]
        public void Resolves_stable_per_class_deadlines(string method, string path, string risk, string expectedClass, int expectedMs)
        {
            var deadline = OperatorActionDeadlinePolicy.Resolve(method, path, risk);

            Assert.Equal(expectedClass, deadline.DeadlineClass);
            Assert.Equal(expectedMs, deadline.BudgetMilliseconds);
        }

        [Fact]
        public void Durable_job_budget_constrains_but_does_not_reclassify_an_action()
        {
            var deadline = OperatorActionDeadlinePolicy
                .Resolve("POST", "/revit/export-ifc", "low")
                .ConstrainTo(TimeSpan.FromSeconds(42));

            Assert.Equal("extended", deadline.DeadlineClass);
            Assert.Equal(42000, deadline.BudgetMilliseconds);
        }

        [Fact]
        public void Correlation_ids_accept_only_bounded_transport_safe_characters()
        {
            Assert.True(OperatorCorrelationId.IsValid("job-123:attempt_1.v2"));
            Assert.False(OperatorCorrelationId.IsValid("job 123"));
            Assert.False(OperatorCorrelationId.IsValid(new string('a', 161)));
            Assert.Equal("fallback-1", OperatorCorrelationId.NormalizeOrCreate("bad value", "fallback-1"));
        }

        [Fact]
        public void Deadline_exception_preserves_class_budget_and_correlation_in_the_failure_receipt()
        {
            var error = OperatorActionDeadlinePolicy
                .Resolve("POST", "/revit/sheets", "low")
                .CreateTimeoutException("job-789");

            var receipt = OperatorCourierFailureClassifier.Classify(error);

            Assert.Equal("revit_action_deadline_elapsed_outcome_unknown", receipt.Code);
            Assert.Equal("bounded_read", receipt.DeadlineClass);
            Assert.Equal(60000, receipt.DeadlineMs);
            Assert.Equal("job-789", receipt.CorrelationId);
            Assert.True(receipt.OpensCircuit);
            Assert.True(receipt.OutcomeUnknown);
            Assert.False(receipt.Retryable);
        }
    }
}

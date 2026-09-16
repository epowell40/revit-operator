using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorActionDeadlinePolicyTests
    {
        [Fact]
        public void QueueCancellationBeforeStartSurvivesNestedHttpAndCourierDeadlineBoundaries()
        {
            var deadline = OperatorActionDeadlinePolicy.Resolve("POST", "/revit/get-parameters", "low");
            var before = new RevitEventCanceledBeforeDispatchException("queued-read-1");
            var first = deadline.ClassifyCancellation(before, "queued-read-1");
            Assert.Same(before, first);
            Assert.Same(before, deadline.ClassifyCancellation((OperationCanceledException)first, "queued-read-1"));
            var receipt = OperatorCourierFailureClassifier.Classify(first);
            Assert.Equal("revit_action_deadline_elapsed_before_dispatch", receipt.Code);
            Assert.Equal("pre_dispatch", receipt.Phase);
            Assert.False(receipt.OutcomeUnknown);
            Assert.False(receipt.OpensCircuit);
            Assert.True(receipt.Retryable);
            Assert.Equal("queued-read-1", receipt.CorrelationId);
        }

        [Theory]
        [InlineData("Cancelled after callback start")]
        [InlineData("The Revit action deadline elapsed before the ExternalEvent callback started; no mutation was dispatched.")]
        public void GenericCancellationAndMatchingProseRemainUnknown(string message)
        {
            var deadline = OperatorActionDeadlinePolicy.Resolve("POST", "/revit/set-parameter", "high");
            var receipt = OperatorCourierFailureClassifier.Classify(deadline.ClassifyCancellation(new OperationCanceledException(message), "mutation-1"));
            Assert.Equal("revit_action_deadline_elapsed_outcome_unknown", receipt.Code);
            Assert.True(receipt.OutcomeUnknown);
            Assert.True(receipt.OpensCircuit);
            Assert.False(receipt.Retryable);
        }

        [Theory]
        [InlineData("POST", "/revit/tool-search", "low", "control_plane", 10000)]
        [InlineData("POST", "/revit/sheets", "low", "bounded_read", 60000)]
        [InlineData("POST", "/revit/create-text", "medium", "interactive_or_export", 75000)]
        [InlineData("POST", "/revit/update-parameter-by-query", "high", "model_mutation", 85000)]
        [InlineData("POST", "/revit/native-api-mutation-ops", "high", "model_mutation", 85000)]
        [InlineData("POST", "/revit/export-ifc", "low", "extended", 210000)]
        [InlineData("POST", "/revit/create-similar-from-instance", "high", "extended", 210000)]
        [InlineData("POST", "/revit/place-family-instance-on-host", "high", "extended", 210000)]
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

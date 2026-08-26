using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorRevitHostCircuitTests
    {
        [Fact]
        public void Circuit_opens_backs_off_and_closes_only_after_a_successful_probe()
        {
            var now = new DateTimeOffset(2026, 7, 25, 16, 0, 0, TimeSpan.Zero);
            var circuit = new OperatorRevitHostCircuit(TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(8));

            circuit.Open("revit_external_event_raise_timed_out", now);
            var opened = circuit.Snapshot();
            Assert.True(opened.Open);
            Assert.Equal("unavailable", opened.HostHealth);
            Assert.Equal(now.AddSeconds(2), opened.ProbeAfter);
            Assert.False(circuit.TryBeginProbe(now.AddSeconds(1)));
            Assert.True(circuit.TryBeginProbe(now.AddSeconds(2)));
            Assert.False(circuit.TryBeginProbe(now.AddSeconds(2)));

            circuit.RecordProbeFailure("revit_external_event_busy", now.AddSeconds(2));
            var retried = circuit.Snapshot();
            Assert.Equal(2, retried.ConsecutiveFailures);
            Assert.Equal(now.AddSeconds(6), retried.ProbeAfter);

            Assert.True(circuit.TryBeginProbe(now.AddSeconds(6)));
            circuit.RecordProbeSuccess();
            var healthy = circuit.Snapshot();
            Assert.False(healthy.Open);
            Assert.Equal("healthy", healthy.HostHealth);
            Assert.Null(healthy.ProbeAfter);
            Assert.Equal(0, healthy.ConsecutiveFailures);
        }

        [Fact]
        public void Timeout_is_non_retryable_outcome_unknown_and_opens_the_host_circuit()
        {
            var receipt = OperatorCourierFailureClassifier.Classify(
                new TimeoutException("deadline elapsed"),
                "job-123");

            Assert.False(receipt.Ok);
            Assert.Equal("revit_action_deadline_elapsed_outcome_unknown", receipt.Code);
            Assert.False(receipt.Retryable);
            Assert.True(receipt.OutcomeUnknown);
            Assert.True(receipt.OpensCircuit);
            Assert.Equal("revit_external_event", receipt.Phase);
            Assert.Equal("unavailable", receipt.HostHealth);
            Assert.Equal("job-123", receipt.CorrelationId);
        }

        [Fact]
        public void Structured_host_metadata_is_preserved_without_message_heuristics()
        {
            var receipt = OperatorCourierFailureClassifier.Classify(new TestHostException(), "job-456");

            Assert.Equal("revit_external_event_busy", receipt.Code);
            Assert.True(receipt.Retryable);
            Assert.False(receipt.OpensCircuit);
            Assert.False(receipt.OutcomeUnknown);
            Assert.Equal("degraded", receipt.HostHealth);
            Assert.Equal("revit_external_event", receipt.Phase);
        }

        [Fact]
        public void User_actionable_confirmation_metadata_survives_the_courier_boundary()
        {
            var receipt = OperatorCourierFailureClassifier.Classify(new OperatorToolUserErrorException(
                "TextNote edit requires typed confirmation.",
                "bulk_confirm_required",
                requiredConfirm: "APPLY 1 TEXT NOTE CHANGE",
                confirmReceived: "REPLACE",
                maxChangesPerCall: 1,
                hint: "Retry with confirm set to requiredConfirm."));

            Assert.Equal("bulk_confirm_required", receipt.Code);
            Assert.Equal("bulk_confirm_required", receipt.UserErrorCode);
            Assert.Equal("APPLY 1 TEXT NOTE CHANGE", receipt.RequiredConfirm);
            Assert.Equal("REPLACE", receipt.ConfirmReceived);
            Assert.Equal(1, receipt.MaxChangesPerCall);
            Assert.Equal("Retry with confirm set to requiredConfirm.", receipt.Hint);
            Assert.True(receipt.Retryable);
            Assert.False(receipt.OpensCircuit);
            Assert.Equal("healthy", receipt.HostHealth);
            Assert.Equal("revit_validation", receipt.Phase);
        }

        private sealed class TestHostException : InvalidOperationException, IOperatorRevitFailureMetadata
        {
            public TestHostException() : base("host is busy") { }
            public string Code => "revit_external_event_busy";
            public bool Retryable => true;
            public string Phase => "revit_external_event";
            public string HostHealth => "degraded";
            public bool OpensCircuit => false;
            public bool OutcomeUnknown => false;
        }
    }
}

using System;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ActivateViewRecoveryContractTests
    {
        private static bool TemporarilyDisabled(Exception error) => error.Message.IndexOf("temporarily disabled", StringComparison.OrdinalIgnoreCase) >= 0;

        [Fact]
        public void ExactRetainedFocusRequestCanQueueWithoutClaimingTheRequestedViewIsActive()
        {
            // Exact request from the retained native 2026-09-26 09:02:27 failure.
            using var request = JsonDocument.Parse("{\"zoomToFit\":false,\"viewId\":1363433,\"showElementIds\":[1543137]}");
            var requested = request.RootElement.GetProperty("viewId").GetInt64();
            long? actual = 42; var queues = 0;
            var result = OperatorViewActivation.Attempt(requested, () => actual,
                () => throw new InvalidOperationException("Setting active view is temporarily disabled."),
                () => queues++, TemporarilyDisabled);
            Assert.Equal(1, queues); Assert.True(result.DeferredRequestAccepted);
            Assert.True(result.ActivationPending); Assert.Equal(42, result.ActiveViewId);
            Assert.Equal(requested, result.RequestedViewId);
            // A later request, after Revit's event loop, confirms the same target.
            actual = requested;
            var retry = OperatorViewActivation.Attempt(requested, () => actual,
                () => throw new Exception("Already active: do not set again"),
                () => throw new Exception("Already active: do not queue again"), TemporarilyDisabled);
            Assert.False(retry.ActivationPending); Assert.False(retry.DeferredRequestAccepted);
        }

        [Fact]
        public void SuccessfulSetterStillRequiresObservedTarget()
        {
            long? actual = 1;
            var pending = OperatorViewActivation.Attempt(2, () => actual, () => { }, () => throw new Exception(), TemporarilyDisabled);
            Assert.True(pending.ActivationPending); Assert.Equal(1, pending.ActiveViewId);
            var active = OperatorViewActivation.Attempt(2, () => actual, () => actual = 2, () => throw new Exception(), TemporarilyDisabled);
            Assert.False(active.ActivationPending); Assert.Equal(2, active.ActiveViewId);
        }

        [Fact]
        public void OnlyRecognizedTemporaryFailureCanDeferAndQueueFailureRemainsFailure()
        {
            var queues = 0;
            Assert.Throws<ArgumentException>(() => OperatorViewActivation.Attempt(2, () => 1,
                () => throw new ArgumentException("View cannot be activated"), () => queues++, TemporarilyDisabled));
            Assert.Equal(0, queues);
            Assert.Throws<InvalidOperationException>(() => OperatorViewActivation.Attempt(2, () => 1,
                () => throw new InvalidOperationException("Setting active view is temporarily disabled."),
                () => throw new InvalidOperationException("Document is modifiable"), TemporarilyDisabled));
        }

        [Fact]
        public void MissingObservedActiveViewAndInvalidTargetNeverClaimActivation()
        {
            Assert.True(OperatorViewActivation.Attempt(2, () => null, () => { }, () => { }, TemporarilyDisabled).ActivationPending);
            Assert.Throws<ArgumentException>(() => OperatorViewActivation.Attempt(0, () => throw new Exception(), () => { }, () => { }, TemporarilyDisabled));
        }
    }
}

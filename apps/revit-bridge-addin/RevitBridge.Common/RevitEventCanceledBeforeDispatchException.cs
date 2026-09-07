using System;

namespace RevitBridge.Common
{
    /// <summary>The queue atomically cancelled the item before its API callback started.</summary>
    public sealed class RevitEventCanceledBeforeDispatchException : OperationCanceledException,
        IOperatorRevitFailureMetadata, IOperatorCorrelationMetadata
    {
        public RevitEventCanceledBeforeDispatchException(string? correlationId)
            : base("The Revit action deadline elapsed before the ExternalEvent callback started; no mutation was dispatched.")
        {
            CorrelationId = OperatorCorrelationId.IsValid(correlationId) ? correlationId!.Trim() : null;
        }

        public string Code => "revit_action_deadline_elapsed_before_dispatch";
        public bool Retryable => true;
        public string Phase => "pre_dispatch";
        public string HostHealth => "degraded";
        public bool OpensCircuit => false;
        public bool OutcomeUnknown => false;
        public string? CorrelationId { get; }
    }
}

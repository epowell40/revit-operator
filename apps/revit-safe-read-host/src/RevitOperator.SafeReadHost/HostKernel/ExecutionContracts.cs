using System;
using System.Threading;
using System.Threading.Tasks;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal enum CertifiedFailureCode
    {
        None = 0,
        BadRequest,
        Unauthorized,
        Busy,
        NoActiveDocument,
        DocumentChanged,
        NotReadOnly,
        CountLimitExceeded,
        AuthorizationUnavailable,
        RevitUnavailable,
        DeadlineExceeded,
        InternalFailure
    }

    internal enum CertifiedExecutionPhase
    {
        None = 0,
        CaptureBinding,
        VerifyFinalReceipt,
        CountSheets,
        Completed
    }

    internal enum CertifiedExecutionOutcome
    {
        Pending = 0,
        Succeeded,
        Denied,
        Failed,
        Cancelled
    }

    internal sealed class CertifiedExecutionResult
    {
        private CertifiedExecutionResult(
            CertifiedExecutionPhase phase,
            CertifiedExecutionOutcome outcome,
            CertifiedFailureCode failure,
            DocumentBinding? binding,
            int count,
            bool requestDispatched,
            bool outcomeUnknown)
        {
            Phase = phase;
            Outcome = outcome;
            FailureCode = failure;
            Binding = binding;
            Count = count;
            RequestDispatched = requestDispatched;
            OutcomeUnknown = outcomeUnknown;
        }

        public CertifiedExecutionPhase Phase { get; }
        public CertifiedExecutionOutcome Outcome { get; }
        public CertifiedFailureCode FailureCode { get; }
        public DocumentBinding? Binding { get; }
        public int Count { get; }
        public bool RequestDispatched { get; }
        public bool OutcomeUnknown { get; }
        public bool Succeeded => Outcome == CertifiedExecutionOutcome.Succeeded;

        public static CertifiedExecutionResult Captured(DocumentBinding binding) =>
            new CertifiedExecutionResult(CertifiedExecutionPhase.CaptureBinding, CertifiedExecutionOutcome.Succeeded, CertifiedFailureCode.None, binding, 0, true, false);

        public static CertifiedExecutionResult Counted(DocumentBinding binding, int count) =>
            new CertifiedExecutionResult(CertifiedExecutionPhase.Completed, CertifiedExecutionOutcome.Succeeded, CertifiedFailureCode.None, binding, count, true, false);

        public static CertifiedExecutionResult Failure(CertifiedExecutionPhase phase, CertifiedFailureCode code, bool requestDispatched = false) =>
            new CertifiedExecutionResult(
                phase,
                code == CertifiedFailureCode.AuthorizationUnavailable ? CertifiedExecutionOutcome.Denied : CertifiedExecutionOutcome.Failed,
                code,
                null,
                0,
                requestDispatched,
                false);

        public static CertifiedExecutionResult Unknown(CertifiedExecutionPhase phase) =>
            new CertifiedExecutionResult(phase, CertifiedExecutionOutcome.Cancelled, CertifiedFailureCode.DeadlineExceeded, null, 0, true, true);

        public static CertifiedExecutionResult CancelledKnown(CertifiedExecutionPhase phase) =>
            new CertifiedExecutionResult(phase, CertifiedExecutionOutcome.Cancelled, CertifiedFailureCode.DeadlineExceeded, null, 0, false, false);
    }

    internal sealed class CertifiedExternalWorkItem
    {
        private int _state;
        private readonly TaskCompletionSource<CertifiedExecutionResult> _completion =
            new TaskCompletionSource<CertifiedExecutionResult>(TaskCreationOptions.RunContinuationsAsynchronously);

        private CertifiedExternalWorkItem(CertifiedExecutionPhase phase, DocumentBinding binding, VerifiedFinalAuthorizationToken? token)
        {
            Phase = phase;
            ExpectedBinding = binding;
            AuthorizationToken = token;
        }

        public CertifiedExecutionPhase Phase { get; }
        public DocumentBinding ExpectedBinding { get; }
        public VerifiedFinalAuthorizationToken? AuthorizationToken { get; }
        public Task<CertifiedExecutionResult> Completion => _completion.Task;
        public bool IsClaimed => Volatile.Read(ref _state) == 1;

        public static CertifiedExternalWorkItem Capture(DocumentBinding binding) =>
            new CertifiedExternalWorkItem(CertifiedExecutionPhase.CaptureBinding, binding, null);

        public static CertifiedExternalWorkItem Count(DocumentBinding binding, VerifiedFinalAuthorizationToken token) =>
            new CertifiedExternalWorkItem(CertifiedExecutionPhase.CountSheets, binding, token);

        internal bool TryClaim() => Interlocked.CompareExchange(ref _state, 1, 0) == 0;

        internal bool TryCancelPending()
        {
            if (Interlocked.CompareExchange(ref _state, 3, 0) != 0)
                return false;
            _completion.TrySetResult(CertifiedExecutionResult.CancelledKnown(Phase));
            return true;
        }

        internal void Complete(CertifiedExecutionResult result)
        {
            if (Interlocked.CompareExchange(ref _state, 2, 1) == 1)
                _completion.TrySetResult(result);
        }
    }

    internal sealed class CertifiedExternalWorkSlot
    {
        private CertifiedExternalWorkItem? _occupied;

        public bool TryQueue(CertifiedExternalWorkItem item) =>
            Interlocked.CompareExchange(ref _occupied, item, null) == null;

        internal CertifiedExternalWorkItem? Take()
        {
            CertifiedExternalWorkItem? item = Volatile.Read(ref _occupied);
            if (item == null)
                return null;
            if (item.TryClaim())
                return item;
            Interlocked.CompareExchange(ref _occupied, null, item);
            return null;
        }

        internal void Release(CertifiedExternalWorkItem item) =>
            Interlocked.CompareExchange(ref _occupied, null, item);

        public bool TryCancelPending(CertifiedExternalWorkItem item)
        {
            if (!ReferenceEquals(Volatile.Read(ref _occupied), item) || !item.TryCancelPending())
                return false;
            Interlocked.CompareExchange(ref _occupied, null, item);
            return true;
        }

        public void FailPending(CertifiedFailureCode code)
        {
            CertifiedExternalWorkItem? item = Volatile.Read(ref _occupied);
            if (item == null)
                return;
            if (item.TryClaim())
            {
                item.Complete(CertifiedExecutionResult.Failure(item.Phase, code, true));
                Release(item);
            }
            else if (item.TryCancelPending())
            {
                Interlocked.CompareExchange(ref _occupied, null, item);
            }
        }
    }
}

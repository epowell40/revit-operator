using System;
using System.Threading;
using System.Threading.Tasks;

namespace RevitOperator.SafeReadCertifiedExecution
{
    public sealed class CertifiedExternalWorkItem
    {
        private int _state;
        private readonly TaskCompletionSource<CertifiedExecutionResult> _completion = new TaskCompletionSource<CertifiedExecutionResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        private CertifiedExternalWorkItem(CertifiedExecutionPhase phase, DocumentBinding binding, VerifiedFinalAuthorizationToken? token)
        { Phase = phase; ExpectedBinding = binding; AuthorizationToken = token; }
        public CertifiedExecutionPhase Phase { get; }
        public DocumentBinding ExpectedBinding { get; }
        public VerifiedFinalAuthorizationToken? AuthorizationToken { get; }
        public Task<CertifiedExecutionResult> Completion => _completion.Task;
        public static CertifiedExternalWorkItem Capture(DocumentBinding binding) => new CertifiedExternalWorkItem(CertifiedExecutionPhase.CaptureBinding, binding, null);
        public static CertifiedExternalWorkItem Count(DocumentBinding binding, VerifiedFinalAuthorizationToken token) => new CertifiedExternalWorkItem(CertifiedExecutionPhase.CountSheets, binding, token);
        internal bool TryClaim() => Interlocked.CompareExchange(ref _state, 1, 0) == 0;
        public bool TryCancel() { if (Interlocked.CompareExchange(ref _state, 3, 0) != 0) return false; _completion.TrySetResult(CertifiedExecutionResult.Cancelled(Phase)); return true; }
        internal void Complete(CertifiedExecutionResult result) { if (Interlocked.CompareExchange(ref _state, 2, 1) == 1) _completion.TrySetResult(result); }
    }

    public sealed class CertifiedExternalWorkSlot
    {
        private CertifiedExternalWorkItem? _occupied;
        public bool TryQueue(CertifiedExternalWorkItem item) => Interlocked.CompareExchange(ref _occupied, item, null) == null;
        internal CertifiedExternalWorkItem? Take()
        {
            CertifiedExternalWorkItem? item = Volatile.Read(ref _occupied);
            return item != null && item.TryClaim() ? item : null;
        }
        internal void Release(CertifiedExternalWorkItem item) => Interlocked.CompareExchange(ref _occupied, null, item);
        public bool TryCancelPending(CertifiedExternalWorkItem item)
        {
            if (Interlocked.CompareExchange(ref _occupied, null, item) != item) return false;
            return item.TryCancel();
        }
        public void FailPending(CertifiedFailureCode code)
        {
            CertifiedExternalWorkItem? item = Interlocked.Exchange(ref _occupied, null);
            if (item != null && item.TryClaim()) item.Complete(CertifiedExecutionResult.Failure(item.Phase, code));
        }
    }
}

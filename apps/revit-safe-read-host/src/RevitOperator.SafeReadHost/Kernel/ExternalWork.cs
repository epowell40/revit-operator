using System;
using System.Threading;
using System.Threading.Tasks;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal enum CertifiedExternalWorkPhase
    {
        CaptureBinding = 1,
        CountSheets = 2
    }

    internal sealed class CertifiedExternalWorkResult
    {
        private CertifiedExternalWorkResult(
            bool succeeded,
            DocumentBinding? binding,
            int count,
            FailureCode failureCode)
        {
            Succeeded = succeeded;
            Binding = binding;
            Count = count;
            FailureCode = failureCode;
        }

        public bool Succeeded { get; private set; }
        public DocumentBinding? Binding { get; private set; }
        public int Count { get; private set; }
        public FailureCode FailureCode { get; private set; }

        public static CertifiedExternalWorkResult Captured(DocumentBinding binding)
        {
            return new CertifiedExternalWorkResult(true, binding, 0, FailureCode.None);
        }

        public static CertifiedExternalWorkResult Counted(DocumentBinding binding, int count)
        {
            return new CertifiedExternalWorkResult(true, binding, count, FailureCode.None);
        }

        public static CertifiedExternalWorkResult Failure(FailureCode failureCode)
        {
            return new CertifiedExternalWorkResult(false, null, 0, failureCode);
        }
    }

    internal sealed class CertifiedExternalWorkItem
    {
        public CertifiedExternalWorkItem(
            CertifiedExternalWorkPhase phase,
            DocumentBinding expectedBinding,
            DateTimeOffset authorizationExpiresAtUtc)
        {
            Phase = phase;
            ExpectedBinding = expectedBinding ?? throw new ArgumentNullException(nameof(expectedBinding));
            AuthorizationExpiresAtUtc = authorizationExpiresAtUtc;
            Completion = new TaskCompletionSource<CertifiedExternalWorkResult>(
                TaskCreationOptions.RunContinuationsAsynchronously);
        }

        public CertifiedExternalWorkPhase Phase { get; private set; }
        public DocumentBinding ExpectedBinding { get; private set; }
        public DateTimeOffset AuthorizationExpiresAtUtc { get; private set; }
        public TaskCompletionSource<CertifiedExternalWorkResult> Completion { get; private set; }

        public void Complete(CertifiedExternalWorkResult result)
        {
            Completion.TrySetResult(result);
        }

        public static CertifiedExternalWorkItem Capture(DocumentBinding expectedBinding)
        {
            return new CertifiedExternalWorkItem(
                CertifiedExternalWorkPhase.CaptureBinding,
                expectedBinding,
                DateTimeOffset.MinValue);
        }

        public static CertifiedExternalWorkItem Count(
            DocumentBinding expectedBinding,
            DateTimeOffset authorizationExpiresAtUtc)
        {
            return new CertifiedExternalWorkItem(
                CertifiedExternalWorkPhase.CountSheets,
                expectedBinding,
                authorizationExpiresAtUtc);
        }
    }

    internal sealed class CertifiedExternalWorkSlot
    {
        private CertifiedExternalWorkItem? _pending;

        public bool TryQueue(CertifiedExternalWorkItem workItem)
        {
            if (workItem == null)
                return false;
            return Interlocked.CompareExchange(ref _pending, workItem, null) == null;
        }

        public CertifiedExternalWorkItem? Take()
        {
            return Interlocked.Exchange(ref _pending, null);
        }

        public void FailPending(FailureCode failureCode)
        {
            CertifiedExternalWorkItem? pending = Take();
            if (pending != null)
                pending.Complete(CertifiedExternalWorkResult.Failure(failureCode));
        }
    }
}

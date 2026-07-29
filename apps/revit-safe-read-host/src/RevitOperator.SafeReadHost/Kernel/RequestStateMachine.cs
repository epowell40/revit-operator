using System.Threading;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal enum CertifiedRequestState
    {
        Created = 0,
        WireAdmitted = 1,
        SlotAcquired = 2,
        CaptureQueued = 3,
        BindingCaptured = 4,
        AuthorizationVerified = 5,
        CountQueued = 6,
        Completed = 7,
        Failed = 8,
        Released = 9
    }

    internal sealed class CertifiedRequestStateMachine
    {
        private int _state = (int)CertifiedRequestState.Created;

        public CertifiedRequestState State
        {
            get { return (CertifiedRequestState)Volatile.Read(ref _state); }
        }

        public bool TryAdvance(CertifiedRequestState next)
        {
            while (true)
            {
                CertifiedRequestState current = State;
                if (!IsAllowed(current, next))
                    return false;
                if (Interlocked.CompareExchange(ref _state, (int)next, (int)current) == (int)current)
                    return true;
            }
        }

        public bool TryFail()
        {
            while (true)
            {
                CertifiedRequestState current = State;
                if (current == CertifiedRequestState.Failed)
                    return true;
                if (current == CertifiedRequestState.Completed || current == CertifiedRequestState.Released)
                    return false;
                if (Interlocked.CompareExchange(ref _state, (int)CertifiedRequestState.Failed, (int)current) == (int)current)
                    return true;
            }
        }

        private static bool IsAllowed(CertifiedRequestState current, CertifiedRequestState next)
        {
            if (current == CertifiedRequestState.Created && next == CertifiedRequestState.WireAdmitted)
                return true;
            if (current == CertifiedRequestState.WireAdmitted && next == CertifiedRequestState.SlotAcquired)
                return true;
            if (current == CertifiedRequestState.SlotAcquired && next == CertifiedRequestState.CaptureQueued)
                return true;
            if (current == CertifiedRequestState.CaptureQueued && next == CertifiedRequestState.BindingCaptured)
                return true;
            if (current == CertifiedRequestState.BindingCaptured && next == CertifiedRequestState.AuthorizationVerified)
                return true;
            if (current == CertifiedRequestState.AuthorizationVerified && next == CertifiedRequestState.CountQueued)
                return true;
            if (current == CertifiedRequestState.CountQueued && next == CertifiedRequestState.Completed)
                return true;
            if ((current == CertifiedRequestState.Completed || current == CertifiedRequestState.Failed) &&
                next == CertifiedRequestState.Released)
                return true;
            return false;
        }
    }
}

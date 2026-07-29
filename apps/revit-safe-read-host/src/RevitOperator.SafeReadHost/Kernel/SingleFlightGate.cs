using System;
using System.Threading;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal sealed class SingleFlightGate
    {
        private int _occupied;

        public bool TryEnter()
        {
            return Interlocked.CompareExchange(ref _occupied, 1, 0) == 0;
        }

        public void Exit()
        {
            if (Interlocked.CompareExchange(ref _occupied, 0, 1) != 1)
                throw new InvalidOperationException("The single-flight gate was not occupied.");
        }

        public bool IsOccupied
        {
            get { return Volatile.Read(ref _occupied) == 1; }
        }
    }
}

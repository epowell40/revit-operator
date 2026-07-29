using System;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal interface ISheetFactIterator
    {
        bool MoveNext();
        bool CurrentIsPlaceholder { get; }
    }

    internal interface IDocumentInvariantProbe
    {
        FailureCode Verify();
    }

    internal sealed class SheetCountOutcome
    {
        private SheetCountOutcome(bool succeeded, int count, FailureCode failureCode)
        {
            Succeeded = succeeded;
            Count = count;
            FailureCode = failureCode;
        }

        public bool Succeeded { get; private set; }
        public int Count { get; private set; }
        public FailureCode FailureCode { get; private set; }

        public static SheetCountOutcome Success(int count)
        {
            return new SheetCountOutcome(true, count, FailureCode.None);
        }

        public static SheetCountOutcome Failure(FailureCode failureCode)
        {
            return new SheetCountOutcome(false, 0, failureCode);
        }
    }

    internal static class SheetCountKernel
    {
        public static SheetCountOutcome Count(ISheetFactIterator iterator, IDocumentInvariantProbe invariantProbe)
        {
            if (iterator == null || invariantProbe == null)
                return SheetCountOutcome.Failure(FailureCode.InternalFailure);

            FailureCode before = invariantProbe.Verify();
            if (before != FailureCode.None)
                return SheetCountOutcome.Failure(before);

            int count = 0;
            while (iterator.MoveNext())
            {
                FailureCode inside = invariantProbe.Verify();
                if (inside != FailureCode.None)
                    return SheetCountOutcome.Failure(inside);
                if (iterator.CurrentIsPlaceholder)
                    continue;
                count++;
                if (count > SafeReadContract.MaximumSheetCount)
                    return SheetCountOutcome.Failure(FailureCode.CountLimitExceeded);
            }

            FailureCode after = invariantProbe.Verify();
            if (after != FailureCode.None)
                return SheetCountOutcome.Failure(after);
            return SheetCountOutcome.Success(count);
        }
    }
}

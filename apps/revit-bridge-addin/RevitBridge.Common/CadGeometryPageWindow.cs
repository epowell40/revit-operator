using System;

namespace RevitBridge.Common
{
    /// <summary>One contiguous page of complete primitives. Skipped primitives still
    /// count against bounded whole-import traversal; output limits never split a curve.</summary>
    public sealed class CadGeometryPageWindow
    {
        public const int MaximumPrimitives = 20000;
        public const int MaximumTotalCost = 100000;
        private readonly CadGeometryReadBudget budget;
        public int Offset { get; }
        public int TotalCount { get; private set; }
        public int TotalCost { get; private set; }
        public int ReturnedCount { get; private set; }
        public int? NextOffset { get; private set; }
        public CadGeometryPageWindow(int offset, CadGeometryReadBudget outputBudget)
        {
            if (offset < 0 || offset > MaximumPrimitives) throw new ArgumentOutOfRangeException(nameof(offset));
            Offset = offset; budget = outputBudget ?? throw new ArgumentNullException(nameof(outputBudget));
        }
        public bool Observe(int cost)
        {
            if (cost < 1 || cost > 1000) throw new ArgumentOutOfRangeException(nameof(cost), "Complete primitive exceeds the maximum response budget.");
            if (TotalCount >= MaximumPrimitives || (long)TotalCost + cost > MaximumTotalCost)
                throw new InvalidOperationException("Complete CAD inventory exceeds bounded traversal.");
            var index = TotalCount++; TotalCost += cost;
            if (index < Offset || NextOffset.HasValue) return false;
            if (!budget.TryConsume(cost)) { NextOffset = index; return false; }
            ReturnedCount++; return true;
        }
        public bool IsValidCompletePage => Offset <= TotalCount && (ReturnedCount > 0 || Offset == TotalCount);
    }
}

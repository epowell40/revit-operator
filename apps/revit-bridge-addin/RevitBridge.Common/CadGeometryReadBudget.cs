using System;

namespace RevitBridge.Common
{
    /// <summary>A single response budget shared by all requested views and CAD instances.</summary>
    public sealed class CadGeometryReadBudget
    {
        public const int MaximumDepth = 8;
        public int Remaining { get; private set; }
        public CadGeometryReadBudget(int? requested)
        {
            var limit = requested ?? 200;
            if (limit < 1 || limit > 1000) throw new ArgumentOutOfRangeException(nameof(requested), "CAD geometry limit must be 1..1000.");
            Remaining = limit;
        }
        public bool TryConsume(int cost)
        {
            if (cost < 1) throw new ArgumentOutOfRangeException(nameof(cost));
            if (cost > Remaining) return false;
            Remaining -= cost;
            return true;
        }
    }
}

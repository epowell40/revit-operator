using System;

namespace RevitBridge.Common
{
    /// <summary>Bounded schedule discovery, distinct from detail-cell paging.</summary>
    public sealed class ScheduleInventoryWindow
    {
        public string Kind { get; private set; } = "regular";
        public int Offset { get; private set; }
        public int Max { get; private set; }

        public static bool TryCreate(string? kind, int? offset, int? max,
            out ScheduleInventoryWindow? window, out string error)
        {
            window = null; error = "";
            var k = kind == null ? "regular" : kind.Trim().ToLowerInvariant();
            var start = offset ?? 0; var size = max ?? 200;
            if ((k != "regular" && k != "panel" && k != "all") || start < 0 || start > 100000 || size < 1 || size > 2000)
            {
                error = "Schedule list requires kind=regular|panel|all, offset 0..100000, and max 1..2000. Use an inventory scheduleId for panel detail.";
                return false;
            }
            window = new ScheduleInventoryWindow { Kind = k, Offset = start, Max = size };
            return true;
        }

        public int Returned(int matched)
        {
            if (matched < 0) throw new ArgumentOutOfRangeException(nameof(matched));
            return Math.Max(0, Math.Min(Max, matched - Offset));
        }
        public bool HasMore(int matched) => (long)Offset + Returned(matched) < matched;
        // A final page is not a complete whole-model enumeration by itself.
        public bool Complete(int matched) => Offset == 0 && Returned(matched) == matched;
        public int? NextOffset(int matched) => HasMore(matched) ? Offset + Returned(matched) : (int?)null;
    }
}

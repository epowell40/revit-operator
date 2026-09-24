using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>Bounds an exact owner-view inventory without presenting a prefix as complete.</summary>
    public static class ViewOwnedDetailingInventoryContract
    {
        // Per-view Revit housekeeping is not user-authored drafting and need not
        // have copy-stable geometry under Duplicate with Detailing.
        public static bool IsNonDraftingInfrastructure(string className, string? builtInCategory, bool isAnnotation,
            string? elementName = null)
        {
            if (isAnnotation) return false;
            return className == "SketchPlane" || className == "SunAndShadowSettings"
                || (className == "Element" && elementName == "ExtentElem")
                || builtInCategory == "OST_SunStudy";
        }
        public const int DefaultLimit = 1000;
        public const int MaximumLimit = 5000;

        public static int ValidateLimit(int? requested)
        {
            var limit = requested ?? DefaultLimit;
            if (limit < 1 || limit > MaximumLimit)
                throw new ArgumentOutOfRangeException(nameof(requested),
                    $"view-owned-detailing limit must be 1..{MaximumLimit}.");
            return limit;
        }

        public static BoundedInventory<T> Bound<T>(IReadOnlyList<T> sortedItems, int limit, int unreadableCount = 0)
        {
            if (sortedItems == null) throw new ArgumentNullException(nameof(sortedItems));
            ValidateLimit(limit);
            if (unreadableCount < 0) throw new ArgumentOutOfRangeException(nameof(unreadableCount));
            return new BoundedInventory<T>(sortedItems.Take(limit).ToArray(),
                sortedItems.Count + unreadableCount,
                sortedItems.Count > limit,
                unreadableCount == 0 && sortedItems.Count <= limit,
                unreadableCount);
        }
    }

    public sealed class BoundedInventory<T>
    {
        public IReadOnlyList<T> Items { get; }
        public int TotalOwnedCount { get; }
        public bool Truncated { get; }
        public bool ItemsComplete { get; }
        public int UnreadableCount { get; }

        public BoundedInventory(IReadOnlyList<T> items, int totalOwnedCount, bool truncated,
            bool itemsComplete, int unreadableCount)
        {
            Items = items;
            TotalOwnedCount = totalOwnedCount;
            Truncated = truncated;
            ItemsComplete = itemsComplete;
            UnreadableCount = unreadableCount;
        }
    }
}

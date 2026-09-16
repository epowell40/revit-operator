using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>Transaction-scoped event inventory. Document.Equals identifies the native open document,
    /// unlike managed wrapper reference equality. Capture failures never erase commit authority.</summary>
    public sealed class OperatorNativeChangeInventory
    {
        private readonly object document;
        private readonly HashSet<long> added = new HashSet<long>();
        private readonly HashSet<long> modified = new HashSet<long>();
        private readonly HashSet<long> deleted = new HashSet<long>();
        public int EventCount { get; private set; }
        public int MatchingEventCount { get; private set; }
        public int DistinctWrapperMatchCount { get; private set; }
        public int CaptureFailureCount { get; private set; }
        public bool Exhaustive => MatchingEventCount > 0 && CaptureFailureCount == 0;

        public OperatorNativeChangeInventory(object document)
        {
            this.document = document ?? throw new ArgumentNullException(nameof(document));
        }

        public void Observe(Func<object?> changedDocument, Func<IEnumerable<long>> addedIds,
            Func<IEnumerable<long>> modifiedIds, Func<IEnumerable<long>> deletedIds)
        {
            EventCount++;
            try
            {
                var candidate = changedDocument();
                if (candidate == null) throw new InvalidOperationException("Change event document unavailable.");
                if (!document.Equals(candidate)) return;
                MatchingEventCount++;
                if (!ReferenceEquals(document, candidate)) DistinctWrapperMatchCount++;
                // Materialize all three sets first so a failed enumeration cannot look complete.
                var a = addedIds().ToArray();
                var m = modifiedIds().ToArray();
                var d = deletedIds().ToArray();
                added.UnionWith(a);
                modified.UnionWith(m);
                deleted.UnionWith(d);
            }
            catch { CaptureFailureCount++; }
        }

        public OperatorNativeTransactionReceipt CommittedReceipt() =>
            OperatorNativeTransactionReceipt.CommittedChanges(added, modified, deleted);

        public object Diagnostics() => new
        {
            documentChangedObserved = MatchingEventCount > 0,
            exhaustiveChangeInventory = Exhaustive,
            eventCount = EventCount,
            matchingEventCount = MatchingEventCount,
            distinctWrapperMatchCount = DistinctWrapperMatchCount,
            captureFailureCount = CaptureFailureCount
        };
    }
}

using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>
    /// Capture owned by one synchronous native placement invocation. This is not
    /// a converter for the global DocumentChanged journal or caller evidence.
    /// The native adapter subscribes immediately around PromptForFamilyInstancePlacement.
    /// A commit proves effects, never correct placement, fit or preservation.
    /// </summary>
    public sealed class OperatorNativeInteractivePlacementCapture
    {
        private readonly object document;
        private readonly HashSet<long> added = new HashSet<long>();
        private readonly HashSet<long> modified = new HashSet<long>();
        private readonly HashSet<long> deleted = new HashSet<long>();
        private readonly List<string> problems = new List<string>();
        private bool finished;
        private int eventCount;
        private int commits;
        private const int MaxEvents = 256;
        private const int MaxIdentities = 10000;

        public OperatorNativeInteractivePlacementCapture(object document)
        {
            this.document = document ?? throw new ArgumentNullException(nameof(document));
        }

        public void Observe(Func<object?> changedDocument, Func<string> operation,
            Func<IEnumerable<long>> addedIds, Func<IEnumerable<long>> modifiedIds,
            Func<IEnumerable<long>> deletedIds)
        {
            if (finished) throw new InvalidOperationException("Placement capture is already closed.");
            eventCount++;
            if (eventCount > MaxEvents) { Problem("event_limit"); return; }
            try
            {
                var changed = changedDocument();
                if (changed == null || !document.Equals(changed))
                {
                    Problem("document_changed");
                    return;
                }
                // Materialize a whole event before unioning; a partial enumeration
                // cannot supply an apparently exhaustive changed-ID receipt.
                var a = Ids(addedIds());
                var m = Ids(modifiedIds());
                var d = Ids(deletedIds());
                if (a.Intersect(d).Any()) Problem("contradictory_event_ids");
                if (added.Union(modified).Union(deleted).Union(a).Union(m).Union(d).Count() > MaxIdentities)
                {
                    Problem("identity_limit");
                    return;
                }
                added.UnionWith(a); modified.UnionWith(m); deleted.UnionWith(d);
                if (operation() == "TransactionCommitted") commits++;
                else Problem("non_commit_event"); // Undo/redo/rollback needs reconciliation, not a guessed net commit.
            }
            catch { Problem("event_capture_failed"); }
        }

        public OperatorNativeTransactionReceipt Finish(bool nativeInvocationReturned,
            bool sameActiveDocumentAndView)
        {
            if (finished) throw new InvalidOperationException("Placement capture cannot settle twice.");
            finished = true;
            if (!nativeInvocationReturned) Problem("invocation_failed");
            if (!sameActiveDocumentAndView) Problem("active_context_changed");
            if (commits == 0) Problem("no_commit_observed");
            // Escape may finish an invocation AFTER one or more successful placements.
            // Conversely, no event does not establish that no transaction started.
            return problems.Count == 0
                ? OperatorNativeTransactionReceipt.CommittedChanges(added, modified, deleted)
                : OperatorNativeTransactionReceipt.Unknown("interactive_placement_reconciliation_required",
                    added.Concat(modified).Concat(deleted));
        }

        public long[] ObservedAddedIds => added.OrderBy(id => id).ToArray();

        public object Diagnostics() => new
        {
            scope = "synchronous_native_placement_invocation",
            eventCount, committedEventCount = commits, closed = finished,
            problems = problems.ToArray(),
            observedAddedIds = added.OrderBy(id => id).ToArray(),
            observedModifiedIds = modified.OrderBy(id => id).ToArray(),
            observedDeletedIds = deleted.OrderBy(id => id).ToArray(),
            postconditionVerified = false
        };

        private static long[] Ids(IEnumerable<long> ids)
        {
            var values = ids.Take(MaxIdentities + 1).ToArray();
            if (values.Length > MaxIdentities || values.Any(id => id <= 0))
                throw new InvalidOperationException("Invalid or unbounded native event identities.");
            return values.Distinct().ToArray();
        }

        private void Problem(string value)
        {
            if (!problems.Contains(value)) problems.Add(value);
        }
    }
}

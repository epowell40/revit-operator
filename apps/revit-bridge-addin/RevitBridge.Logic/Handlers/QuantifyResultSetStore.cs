using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Logic.Handlers
{
    internal static class QuantifyResultSetStore
    {
        private sealed class Entry
        {
            public DateTime CreatedAtUtc { get; set; }
            public List<long> HostElementIds { get; set; } = new List<long>();
        }

        private static readonly object Gate = new object();
        private static readonly Dictionary<string, Entry> Entries = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);

        private const int MaxEntries = 50;
        private static readonly TimeSpan MaxAge = TimeSpan.FromHours(12);

        public static string Put(List<long> hostElementIds)
        {
            var ids = hostElementIds ?? new List<long>();
            // Keep order stable for repeatable visualization (selection order doesn't matter, but determinism helps debugging).
            var stable = ids.Where(x => x > 0).Distinct().OrderBy(x => x).ToList();

            var id = Guid.NewGuid().ToString("N");
            lock (Gate)
            {
                Prune_NoLock();
                Entries[id] = new Entry { CreatedAtUtc = DateTime.UtcNow, HostElementIds = stable };
                EnforceCapacity_NoLock();
            }
            return id;
        }

        public static bool TryGetHostIds(string resultSetId, out List<long> hostElementIds)
        {
            hostElementIds = new List<long>();
            var key = (resultSetId ?? "").Trim();
            if (key.Length == 0) return false;

            lock (Gate)
            {
                Prune_NoLock();
                if (!Entries.TryGetValue(key, out var e)) return false;
                hostElementIds = e.HostElementIds?.ToList() ?? new List<long>();
                return true;
            }
        }

        public static bool Forget(string resultSetId)
        {
            var key = (resultSetId ?? "").Trim();
            if (key.Length == 0) return false;

            lock (Gate)
            {
                return Entries.Remove(key);
            }
        }

        private static void Prune_NoLock()
        {
            if (Entries.Count == 0) return;
            var cutoff = DateTime.UtcNow.Subtract(MaxAge);
            var toRemove = Entries.Where(kv => kv.Value.CreatedAtUtc < cutoff).Select(kv => kv.Key).ToList();
            foreach (var k in toRemove) Entries.Remove(k);
        }

        private static void EnforceCapacity_NoLock()
        {
            if (Entries.Count <= MaxEntries) return;
            // Remove oldest first.
            var ordered = Entries.OrderBy(kv => kv.Value.CreatedAtUtc).ToList();
            var removeCount = Math.Max(0, ordered.Count - MaxEntries);
            for (int i = 0; i < removeCount; i++)
            {
                Entries.Remove(ordered[i].Key);
            }
        }
    }
}


using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Bounded observations, never transaction authority, actor attribution or postcondition proof.</summary>
    public sealed class OperatorDocumentChangeObservationStore
    {
        public const int MaxEvents = 16;
        public const int MaxIdsPerEvent = 64;
        private readonly object _gate = new object();
        private readonly Queue<Entry> _events = new Queue<Entry>();
        private readonly string _epoch = Guid.NewGuid().ToString("N");
        private readonly int _processId;
        private long _sequence;

        private sealed class Entry
        {
            public long sequence { get; set; }
            public string? documentSessionId { get; set; }
            public string observedAtUtc { get; set; } = "";
            public string operation { get; set; } = "";
            public string[] transactionNames { get; set; } = Array.Empty<string>();
            public bool transactionNamesTruncated { get; set; }
            public long[] addedIds { get; set; } = Array.Empty<long>();
            public long[] modifiedIds { get; set; } = Array.Empty<long>();
            public long[] deletedIds { get; set; } = Array.Empty<long>();
            public bool complete { get; set; }
            public string? unavailableReason { get; set; }
        }

        public OperatorDocumentChangeObservationStore(int processId)
        {
            if (processId <= 0) throw new ArgumentOutOfRangeException(nameof(processId));
            _processId = processId;
        }

        public void Record(string documentSessionId, string operation, IEnumerable<string> transactionNames,
            IEnumerable<long> added, IEnumerable<long> modified, IEnumerable<long> deleted, DateTimeOffset at)
        {
            if (string.IsNullOrWhiteSpace(documentSessionId) || documentSessionId.Length > 200)
                throw new ArgumentException("A native document session is required.", nameof(documentSessionId));
            var remaining = MaxIdsPerEvent;
            var complete = true;
            var addedIds = BoundedIds(added, ref remaining, ref complete);
            var modifiedIds = BoundedIds(modified, ref remaining, ref complete);
            var deletedIds = BoundedIds(deleted, ref remaining, ref complete);
            var names = transactionNames.Take(5).ToArray();
            var namesTruncated = names.Length > 4 || names.Any(n => n == null || n.Length > 120);
            var entry = new Entry { documentSessionId = documentSessionId, operation = (operation ?? "").Substring(0, Math.Min(80, (operation ?? "").Length)),
                observedAtUtc = at.ToUniversalTime().ToString("o"), transactionNames = names.Take(4).Select(n => (n ?? "").Substring(0, Math.Min(120, (n ?? "").Length))).ToArray(),
                transactionNamesTruncated = namesTruncated, addedIds = addedIds, modifiedIds = modifiedIds, deletedIds = deletedIds,
                complete = complete, unavailableReason = complete ? null : "change_ids_truncated_or_invalid" };
            Append(entry);
        }

        public void RecordCaptureFailure(DateTimeOffset at)
            => Append(new Entry { observedAtUtc = at.ToUniversalTime().ToString("o"), operation = "unavailable", complete = false, unavailableReason = "native_change_capture_failed" });

        private void Append(Entry entry)
        {
            lock (_gate)
            {
                entry.sequence = ++_sequence;
                _events.Enqueue(entry);
                while (_events.Count > MaxEvents) _events.Dequeue();
            }
        }

        private static long[] BoundedIds(IEnumerable<long> source, ref int remaining, ref bool complete)
        {
            var values = source.Take(remaining + 1).ToArray();
            if (values.Length > remaining || values.Any(id => id <= 0 || id > 9007199254740991L)) complete = false;
            var kept = values.Take(remaining).Where(id => id > 0 && id <= 9007199254740991L).Distinct().OrderBy(id => id).ToArray();
            remaining -= Math.Min(remaining, values.Length);
            return kept;
        }

        public string ReadJson(string documentSessionId)
        {
            if (string.IsNullOrWhiteSpace(documentSessionId)) throw new ArgumentException("A native document session is required.");
            lock (_gate)
            {
                return JsonSerializer.Serialize(new { schema = "operator.native_document_changes.v1", authority = "observed_changes_only",
                    processId = _processId, epoch = _epoch, documentSessionId, throughSequence = _sequence,
                    retainedFromSequence = _events.Count == 0 ? _sequence + 1 : _events.Peek().sequence,
                    maxEvents = MaxEvents, maxIdsPerEvent = MaxIdsPerEvent,
                    events = _events.Where(e => e.documentSessionId == documentSessionId || e.documentSessionId == null).ToArray(),
                    note = "Native DocumentChanged observations. No actor attribution, committed-operation receipt or correctness proof. Obtain fresh target readback; session changes and missing/truncated intervals require reconciliation." });
            }
        }
    }
}

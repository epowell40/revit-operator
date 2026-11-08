using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RevitBridge.Common
{
    // Bounded native observation transport, not transaction or task authority.
    // The native adapter supplies actual state; generated program strings never enter here.
    public static class OperatorNativeEffectState
    {
        public const string Scope = "native_drafting_effect_state_v1";
        public const int MaxElements = 4096, MaxItemBytes = 65536, MaxTotalBytes = 2 * 1024 * 1024;
        public sealed class Item
        {
            public long elementId { get; set; }
            public bool? found { get; set; }
            public bool complete { get; set; }
            public string? stateJson { get; set; }
            public string? stateHash { get; set; }
            public string? reason { get; set; }
        }
        public static Item Capture(long id, bool found, object state)
        {
            if (id <= 0) throw new ArgumentException("Positive native identity required.");
            var json = JsonSerializer.Serialize(state);
            if (Encoding.UTF8.GetByteCount(json) > MaxItemBytes) return Unavailable(id, "native_state_item_oversize");
            using (var parsed = JsonDocument.Parse(json))
                if (parsed.RootElement.GetProperty("elementId").GetInt64() != id
                    || parsed.RootElement.GetProperty("found").GetBoolean() != found)
                    throw new ArgumentException("Native state identity differs.");
            using var sha = SHA256.Create();
            var digest = string.Concat(sha.ComputeHash(Encoding.UTF8.GetBytes(json)).Select(b => b.ToString("x2")));
            return new Item { elementId = id, found = found, complete = true, stateJson = json, stateHash = "sha256:" + digest };
        }
        public static Item Unavailable(long id, string reason) => new Item { elementId = id, complete = false, reason = reason };
        public static void AttachAfterCommit(Dictionary<string,object?> result, Func<IReadOnlyList<long>,object> capture)
        {
            if (!result.TryGetValue("success",out var success) || !(success is true)
                || !result.TryGetValue("transaction",out var value) || !(value is OperatorNativeTransactionReceipt tx)
                || tx.Status!="committed" || tx.CommittedValue!=true) return;
            try { result["effect_observation"]=capture(tx.AffectedElementIds); }
            catch { result["effect_observation"]=new {scope=Scope,complete=false,reason="post_commit_native_observation_unavailable",
                meaning="Commit remains applied and requires independent inspection; never replay."}; }
        }
        public static object Observe(string fingerprint, string session, IEnumerable<long> requested, Func<long, Item> read)
            => Observe(fingerprint, session, requested, read, null);
        public static object Observe(string fingerprint, string session, IEnumerable<long> requested, Func<long, Item> read,
            Func<string, OperatorDocumentChangeVersion>? captureVersion)
        {
            var ids = requested.OrderBy(id => id).ToArray();
            if (ids.Length == 0 || ids.Length > MaxElements || ids.Any(id => id <= 0) || ids.Distinct().Count() != ids.Length)
                throw new ArgumentException("Native state read requires 1-4096 unique positive identities.");
            var items = new List<Item>(); var bytes = 0; var complete = true;
            OperatorDocumentChangeVersion? before = null, nativeVersion = null;
            try { before = captureVersion?.Invoke(session); } catch { /* Observation remains incomplete, not a failed commit. */ }
            foreach (var id in ids)
            {
                Item item;
                try { item = read(id); if (item.elementId != id) throw new InvalidOperationException(); }
                catch { item = Unavailable(id, "native_state_read_failed_or_unsupported"); }
                var itemBytes=Encoding.UTF8.GetByteCount(item.stateJson ?? "");
                if (bytes+itemBytes > MaxTotalBytes) { complete = false; break; }
                bytes += itemBytes;
                items.Add(item); complete &= item.complete;
            }
            try
            {
                if (before != null && before.DocumentSessionId == session && before.ProcessId > 0 &&
                    !string.IsNullOrWhiteSpace(before.Epoch) && before.Sequence >= 0)
                {
                    var after = captureVersion!(session);
                    before.RequireUnchanged(after);
                    nativeVersion = after;
                }
            }
            catch { /* Never report stable opaque state after a failed/changed native stamp. */ }
            if (captureVersion != null && nativeVersion == null) complete = false;
            foreach (var item in items)
            {
                if (item.stateJson == null) continue;
                using var state = JsonDocument.Parse(item.stateJson);
                if (state.RootElement.TryGetProperty("shape", out var shape) && shape.ValueKind == JsonValueKind.Object &&
                    shape.TryGetProperty("kind", out var kind) && kind.GetString() == "opaque_element_public_state" && nativeVersion == null)
                { item.complete = false; item.reason = "opaque_state_requires_stable_native_version"; complete = false; }
            }
            return new { scope = Scope, documentFingerprint = fingerprint, documentSessionId = session,
                complete, requestedElementIds = ids, items, observedStateBytes = bytes, nativeVersion,
                meaning = "Public fields are observed directly. Opaque internals are not inspected; native version supplies continuity only, never correctness. Not code intent, requested design, visual fidelity or saved-file proof." };
        }
    }
}

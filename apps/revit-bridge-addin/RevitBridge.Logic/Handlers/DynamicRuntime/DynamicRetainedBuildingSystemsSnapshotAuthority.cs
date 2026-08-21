using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using Autodesk.Revit.DB;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    internal sealed class DynamicRetainedBuildingSystemsScopeV1
    {
        internal string ScopeHash = "";
        internal readonly Dictionary<int, string> EnvelopeHashesByOffset = new Dictionary<int, string>();
        internal int? ObservedTotalCount;
        internal int? ObservedPageSize;
    }

    internal sealed class DynamicRetainedBuildingSystemsSnapshotV1
    {
        internal string SnapshotId = "";
        internal string RuntimeId = "";
        internal string DocumentFingerprint = "";
        internal string DocumentSessionId = "";
        internal string InitialScopeHash = "";
        internal string SnapshotHash = "";
        internal long DocumentRevision;
        internal string DocumentStateHash = "";
        internal DateTime ExpiresUtc;
        internal readonly object Gate = new object();
        internal readonly Dictionary<string, DynamicRetainedBuildingSystemsScopeV1> Scopes =
            new Dictionary<string, DynamicRetainedBuildingSystemsScopeV1>(StringComparer.Ordinal);
        internal HashSet<string>? AuthorizedTargetUniqueIds;
    }

    internal static class DynamicRetainedBuildingSystemsSnapshotAuthorityV1
    {
        private static readonly ConcurrentDictionary<string, DynamicRetainedBuildingSystemsSnapshotV1> Snapshots =
            new ConcurrentDictionary<string, DynamicRetainedBuildingSystemsSnapshotV1>(StringComparer.Ordinal);

        internal static DynamicRetainedBuildingSystemsSnapshotV1 Issue(string runtimeId, Document document, string documentFingerprint,
            string documentSessionId, DynamicBuildingSystemsSelectorV1 selector)
        {
            Prune();
            var revision = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var scopeHash = DynamicBuildingSystemsObservationPolicyV1.ScopeHash(selector);
            var nonce = new byte[32]; using (var random = RandomNumberGenerator.Create()) random.GetBytes(nonce);
            var seal = new DynamicRetainedBuildingSystemsSnapshotV1
            {
                SnapshotId = "retainedbuildingsnapshot_" + Guid.NewGuid().ToString("N"),
                RuntimeId = runtimeId,
                DocumentFingerprint = documentFingerprint,
                DocumentSessionId = documentSessionId,
                InitialScopeHash = scopeHash,
                DocumentRevision = revision,
                DocumentStateHash = DocumentStateHash(document),
                SnapshotHash = DynamicWire.Sha256("dynamic-revit-retained-building-snapshot/v1\n" +
                    Convert.ToBase64String(nonce) + "\n" + documentFingerprint + "\n" + documentSessionId + "\n" + revision),
                ExpiresUtc = DateTime.UtcNow.AddMinutes(8)
            };
            seal.Scopes.Add(scopeHash, new DynamicRetainedBuildingSystemsScopeV1 { ScopeHash = scopeHash });
            if (!Snapshots.TryAdd(seal.SnapshotId, seal))
                throw new InvalidOperationException("Retained building-systems snapshot identity collided.");
            return seal;
        }

        internal static DynamicRetainedBuildingSystemsSnapshotV1 Require(string runtimeId, string snapshotId,
            string documentFingerprint, string documentSessionId, DynamicBuildingSystemsSelectorV1 selector)
        {
            var seal = RequireRoot(runtimeId, snapshotId, documentFingerprint, documentSessionId);
            var scopeHash = DynamicBuildingSystemsObservationPolicyV1.ScopeHash(selector);
            lock (seal.Gate)
                if (!seal.Scopes.ContainsKey(scopeHash))
                    throw new InvalidOperationException("Retained building-systems snapshot scope is unknown or substituted.");
            return seal;
        }

        internal static DynamicRetainedBuildingSystemsSnapshotV1 RequireOrRegisterScope(string runtimeId, string snapshotId,
            string documentFingerprint, string documentSessionId, Document document, DynamicBuildingSystemsSelectorV1 selector)
        {
            var seal = RequireRoot(runtimeId, snapshotId, documentFingerprint, documentSessionId);
            if (seal.DocumentStateHash != DocumentStateHash(document))
                throw new InvalidOperationException("Retained building-systems snapshot document state changed before scope registration.");
            var scopeHash = DynamicBuildingSystemsObservationPolicyV1.ScopeHash(selector);
            lock (seal.Gate)
            {
                if (!seal.Scopes.ContainsKey(scopeHash))
                {
                    if (seal.Scopes.Count >= DynamicResultReferenceObservationSetV1.MaximumScopes)
                        throw new InvalidOperationException("Retained building-systems snapshot reached its scope bound.");
                    seal.Scopes.Add(scopeHash, new DynamicRetainedBuildingSystemsScopeV1 { ScopeHash = scopeHash });
                }
            }
            return seal;
        }

        internal static DynamicRetainedBuildingSystemsSnapshotV1 RequireScopeSet(string runtimeId, string snapshotId,
            string documentFingerprint, string documentSessionId, IEnumerable<DynamicBuildingSystemsSelectorV1> selectors)
        {
            var seal = RequireRoot(runtimeId, snapshotId, documentFingerprint, documentSessionId);
            var scopes = (selectors ?? throw new ArgumentNullException(nameof(selectors)))
                .Select(DynamicBuildingSystemsObservationPolicyV1.ScopeHash).ToArray();
            _ = DynamicResultReferenceObservationSetV1.ScopeSetHash(scopes);
            lock (seal.Gate)
                if (scopes.Any(scope => !seal.Scopes.ContainsKey(scope)))
                    throw new InvalidOperationException("Retained building-systems snapshot scope set is unknown or substituted.");
            return seal;
        }

        internal static void BindAuthorizedTargets(string snapshotId, IEnumerable<string> targetUniqueIds)
        {
            if (!Snapshots.TryGetValue(snapshotId ?? "", out var seal) || seal.ExpiresUtc <= DateTime.UtcNow)
                throw new InvalidOperationException("Retained building-systems snapshot is unavailable for target binding.");
            var values = (targetUniqueIds ?? throw new ArgumentNullException(nameof(targetUniqueIds))).ToArray();
            if (values.Length < 1 || values.Length > DynamicResultReferenceContractV1.MaximumReferencesPerNode || values.Any(value =>
                    string.IsNullOrWhiteSpace(value) || value.Length > 256 || value.Any(char.IsControl)) ||
                values.Distinct(StringComparer.Ordinal).Count() != values.Length)
                throw new ArgumentException("Retained building-systems authorized target set is invalid or unbounded.");
            var next = new HashSet<string>(values, StringComparer.Ordinal);
            lock (seal.Gate)
            {
                if (seal.AuthorizedTargetUniqueIds == null) seal.AuthorizedTargetUniqueIds = next;
                else if (!seal.AuthorizedTargetUniqueIds.SetEquals(next))
                    throw new InvalidOperationException("Retained building-systems authorized target set was substituted.");
            }
        }

        internal static void RequireAuthorizedTargets(string snapshotId, IEnumerable<string> targetUniqueIds)
        {
            if (!Snapshots.TryGetValue(snapshotId ?? "", out var seal) || seal.ExpiresUtc <= DateTime.UtcNow)
                throw new InvalidOperationException("Retained building-systems snapshot is unavailable for target admission.");
            var values = (targetUniqueIds ?? throw new ArgumentNullException(nameof(targetUniqueIds))).ToArray();
            lock (seal.Gate)
                if (seal.AuthorizedTargetUniqueIds == null || values.Any(value => !seal.AuthorizedTargetUniqueIds.Contains(value)))
                    throw new InvalidOperationException("Expanded observation context cannot broaden the retained authorized target set.");
        }

        internal static void RequireUnchanged(string snapshotId, Document document)
        {
            if (!Snapshots.TryGetValue(snapshotId ?? "", out var seal) || seal.ExpiresUtc <= DateTime.UtcNow ||
                seal.DocumentFingerprint != DynamicRuntimeSnapshotHandler.Fingerprint(document) ||
                seal.DocumentSessionId != DynamicRuntimeSnapshotHandler.Session(document) ||
                seal.DocumentStateHash != DocumentStateHash(document))
                throw new InvalidOperationException("Retained building-systems snapshot document state changed after observation.");
        }

        internal static void RecordEnvelope(string snapshotId, DynamicBuildingSystemsEnvelopeV1 envelope)
        {
            if (!Snapshots.TryGetValue(snapshotId ?? "", out var seal) || seal.ExpiresUtc <= DateTime.UtcNow)
                throw new InvalidOperationException("Retained building-systems snapshot expired before its observation envelope was recorded.");
            DynamicBuildingSystemsObservationPolicyV1.ValidateEnvelope(envelope);
            if (envelope.SnapshotHash != seal.SnapshotHash || envelope.DocumentRevision != seal.DocumentRevision ||
                envelope.DocumentFingerprint != seal.DocumentFingerprint || envelope.DocumentSessionId != seal.DocumentSessionId)
                throw new InvalidOperationException("Building-systems envelope does not bind the retained snapshot.");
            lock (seal.Gate)
            {
                if (!seal.Scopes.TryGetValue(envelope.ScopeHash, out var scope))
                    throw new InvalidOperationException("Building-systems envelope scope was not registered.");
                if (scope.ObservedTotalCount.HasValue &&
                    (scope.ObservedTotalCount.Value != envelope.TotalCount || scope.ObservedPageSize != envelope.PageSize))
                    throw new InvalidOperationException("Retained building-systems scope page totals changed.");
                if (scope.EnvelopeHashesByOffset.TryGetValue(envelope.PageOffset, out var prior) && prior != envelope.EnvelopeHash)
                    throw new InvalidOperationException("Retained building-systems page was equivocally replaced.");
                scope.ObservedTotalCount = envelope.TotalCount;
                scope.ObservedPageSize = envelope.PageSize;
                scope.EnvelopeHashesByOffset[envelope.PageOffset] = envelope.EnvelopeHash;
            }
        }

        internal static void RequireCompleteEnvelopeSet(string snapshotId, IEnumerable<string> scopeHashes,
            IEnumerable<string> envelopeHashes)
        {
            if (!Snapshots.TryGetValue(snapshotId ?? "", out var seal) || seal.ExpiresUtc <= DateTime.UtcNow)
                throw new InvalidOperationException("Retained building-systems snapshot is unavailable for result-reference admission.");
            var scopes = (scopeHashes ?? throw new ArgumentNullException(nameof(scopeHashes))).ToArray();
            _ = DynamicResultReferenceObservationSetV1.ScopeSetHash(scopes);
            var supplied = (envelopeHashes ?? throw new ArgumentNullException(nameof(envelopeHashes))).ToArray();
            if (supplied.Length < 1 || supplied.Length > DynamicObservationDeltaPolicyV1.MaximumRetainedPages ||
                supplied.Any(value => !DynamicRuntimePreviewHandler.IsHash(value)) ||
                supplied.Distinct(StringComparer.Ordinal).Count() != supplied.Length)
                throw new ArgumentException("Retained building-systems envelope identity set is invalid or unbounded.");
            lock (seal.Gate)
            {
                var expected = new HashSet<string>(StringComparer.Ordinal);
                foreach (var scopeHash in scopes)
                {
                    if (!seal.Scopes.TryGetValue(scopeHash, out var scope) ||
                        !scope.ObservedTotalCount.HasValue || !scope.ObservedPageSize.HasValue)
                        throw new InvalidOperationException("Retained building-systems scope has no authenticated pages.");
                    var pageCount = Math.Max(1, (scope.ObservedTotalCount.Value + scope.ObservedPageSize.Value - 1) / scope.ObservedPageSize.Value);
                    var offsets = Enumerable.Range(0, pageCount).Select(index => index * scope.ObservedPageSize.Value).ToArray();
                    if (scope.EnvelopeHashesByOffset.Count != pageCount ||
                        offsets.Any(offset => !scope.EnvelopeHashesByOffset.ContainsKey(offset)))
                        throw new InvalidOperationException("Retained building-systems scope page set is incomplete.");
                    expected.UnionWith(scope.EnvelopeHashesByOffset.Values);
                }
                if (!new HashSet<string>(supplied, StringComparer.Ordinal).SetEquals(expected))
                    throw new InvalidOperationException("Retained building-systems page set is incomplete, duplicated, or substituted.");
            }
        }

        private static DynamicRetainedBuildingSystemsSnapshotV1 RequireRoot(string runtimeId, string snapshotId,
            string documentFingerprint, string documentSessionId)
        {
            Prune();
            if (!Snapshots.TryGetValue(snapshotId ?? "", out var seal) || seal.ExpiresUtc <= DateTime.UtcNow ||
                seal.RuntimeId != runtimeId || seal.DocumentFingerprint != documentFingerprint ||
                seal.DocumentSessionId != documentSessionId)
                throw new InvalidOperationException("Retained building-systems snapshot is unknown, expired, stale, or substituted.");
            return seal;
        }

        private static void Prune()
        {
            foreach (var key in Snapshots.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray())
                Snapshots.TryRemove(key, out _);
        }

        private static string DocumentStateHash(Document document)
        {
            const int maximum = 50000;
            var values = new List<string>();
            foreach (var element in new FilteredElementCollector(document).WhereElementIsNotElementType())
            {
                if (values.Count >= maximum)
                    throw new InvalidOperationException("Retained building-systems snapshot document exceeds the 50000-element exact revision bound.");
                values.Add(ElementIdCompat.GetValue(element.Id).ToString(System.Globalization.CultureInfo.InvariantCulture) + "\n" +
                    (element.UniqueId ?? "") + "\n" + DynamicAnnotationRevitStateV1.StateHash(element));
            }
            values.Sort(StringComparer.Ordinal);
            return DynamicWire.Sha256("dynamic-revit-building-systems-document-state/v1\n" + string.Join("\n", values));
        }
    }
}

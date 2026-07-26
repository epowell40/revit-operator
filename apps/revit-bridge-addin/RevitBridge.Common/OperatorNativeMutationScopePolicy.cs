using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class OperatorNativeMutationScopeDecision
    {
        public bool Allowed { get; set; }
        public string Code { get; set; } = "ok";
        public string Error { get; set; } = "";
        public long[] AddedElementIds { get; set; } = Array.Empty<long>();
        public long[] ModifiedElementIds { get; set; } = Array.Empty<long>();
        public long[] DeletedElementIds { get; set; } = Array.Empty<long>();
        public long[] UnexpectedExistingElementIds { get; set; } = Array.Empty<long>();
        public int AffectedElementCount { get; set; }
        public bool ExistingScopeMatched { get; set; }
    }

    public static class OperatorNativeMutationScopePolicy
    {
        public static OperatorNativeMutationScopeDecision Evaluate(
            IEnumerable<long>? addedElementIds,
            IEnumerable<long>? modifiedElementIds,
            IEnumerable<long>? deletedElementIds,
            IEnumerable<long>? allowedExistingElementIds,
            bool allowCreate,
            int maxAffectedElements,
            bool allowUnexpectedExistingForRollback = false)
        {
            if (maxAffectedElements < 1 || maxAffectedElements > 64)
                throw new ArgumentOutOfRangeException(nameof(maxAffectedElements), "maxAffectedElements must be between 1 and 64.");

            var added = Normalize(addedElementIds);
            var modified = Normalize(modifiedElementIds);
            var deleted = Normalize(deletedElementIds);
            var allowed = new HashSet<long>(Normalize(allowedExistingElementIds));
            var affected = new HashSet<long>(added);
            affected.UnionWith(modified);
            affected.UnionWith(deleted);
            var addedSet = new HashSet<long>(added);
            var unexpectedExisting = modified
                .Concat(deleted)
                .Where(id => !addedSet.Contains(id) && !allowed.Contains(id))
                .Distinct()
                .OrderBy(id => id)
                .ToArray();

            var decision = new OperatorNativeMutationScopeDecision
            {
                AddedElementIds = added,
                ModifiedElementIds = modified.Where(id => !addedSet.Contains(id)).ToArray(),
                DeletedElementIds = deleted,
                UnexpectedExistingElementIds = unexpectedExisting,
                AffectedElementCount = affected.Count,
                ExistingScopeMatched = unexpectedExisting.Length == 0
            };

            if (affected.Count > maxAffectedElements)
            {
                decision.Code = "affected_element_cap_exceeded";
                decision.Error = $"native-api-mutation-ops affected {affected.Count} elements, exceeding transaction.maxAffectedElements={maxAffectedElements}; this rejection requires verified transaction-group rollback.";
                return decision;
            }
            if (!allowCreate && added.Length > 0)
            {
                decision.Code = "creation_not_allowed";
                decision.Error = $"native-api-mutation-ops created {added.Length} elements while transaction.allowCreate=false; this rejection requires verified transaction-group rollback.";
                return decision;
            }
            if (unexpectedExisting.Length > 0)
            {
                if (allowUnexpectedExistingForRollback)
                {
                    decision.Allowed = true;
                    decision.Code = "rollback_scope_discovered";
                    return decision;
                }
                decision.Code = "existing_element_out_of_scope";
                decision.Error = $"native-api-mutation-ops affected existing elements outside transaction.allowedExistingElementIds: {string.Join(",", unexpectedExisting.Take(16))}; this rejection requires verified transaction-group rollback.";
                return decision;
            }

            decision.Allowed = true;
            return decision;
        }

        private static long[] Normalize(IEnumerable<long>? ids)
        {
            return (ids ?? Array.Empty<long>())
                .Where(id => id > 0)
                .Distinct()
                .OrderBy(id => id)
                .ToArray();
        }
    }
}

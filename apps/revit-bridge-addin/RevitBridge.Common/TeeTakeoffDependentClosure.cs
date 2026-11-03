using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Classifies an exact native parent/dependent inventory. Never
    /// accepts caller-supplied exemptions or category-only deletion allowances.
    /// Committed native footprint and independent readback remain mandatory.</summary>
    public static class TeeTakeoffDependentClosure
    {
        public static long[] RequireDeletion(long teeId, string teeUniqueId,
            JsonElement nativeCenterlines, IEnumerable<long> actualDeletedIds)
        {
            var expected = Owned(teeId, teeUniqueId, nativeCenterlines).Append(teeId).OrderBy(x => x).ToArray();
            Exact(expected, actualDeletedIds, "Tee deletion includes an unproved dependent or omits a required owner.");
            return expected;
        }

        public static long[] RequireAdded(long bridgeId, string bridgeUniqueId, long fittingId,
            string fittingUniqueId, JsonElement nativeCenterlines, IEnumerable<long> actualAddedIds)
        {
            if (bridgeId == fittingId || bridgeUniqueId == fittingUniqueId)
                throw new InvalidOperationException("Created physical identities must be distinct.");
            var expected = Owned(bridgeId, bridgeUniqueId, nativeCenterlines)
                .Concat(Owned(fittingId, fittingUniqueId, nativeCenterlines))
                .Concat(new[] { bridgeId, fittingId }).OrderBy(x => x).ToArray();
            Exact(expected, actualAddedIds, "Replacement created an unproved owner or omitted a required owner.");
            return expected;
        }

        private static IEnumerable<long> Owned(long parentId, string parentUniqueId, JsonElement centerlines)
        {
            if (parentId <= 0 || string.IsNullOrWhiteSpace(parentUniqueId))
                throw new InvalidOperationException("A current native parent identity is required.");
            InlineAccessoryBookkeeping.ValidateCenterlines(centerlines);
            var all = centerlines.EnumerateArray().ToArray();
            if (all.Any(r => r.GetProperty("elementId").GetInt64() == parentId))
                throw new InvalidOperationException("Physical parent cannot also be a logical dependent.");
            var rows = all.Where(r => r.GetProperty("parentId").GetInt64() == parentId).ToArray();
            if (rows.Any(r => r.GetProperty("parentUniqueId").GetString() != parentUniqueId))
                throw new InvalidOperationException("Native dependent parent identity changed.");
            return rows.Select(r => r.GetProperty("elementId").GetInt64()).ToArray();
        }

        private static void Exact(long[] expected, IEnumerable<long> actual, string error)
        {
            var ids = actual.Take(65).ToArray();
            if (ids.Length > 64 || ids.Any(x => x <= 0) || ids.Distinct().Count() != ids.Length
                || expected.Distinct().Count() != expected.Length || !ids.OrderBy(x => x).SequenceEqual(expected))
                throw new InvalidOperationException(error + " ExpectedIds=[" + string.Join(",", expected)
                    + "]; observedIds(first16)=[" + string.Join(",", ids.Take(16)) + "]. Atomic rollback required.");
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public static class InlineAccessoryFootprint
    {
        // Membership is only a rollback guard. Every permitted existing owner still
        // needs its own native preservation checks; this does not verify any effect.
        public static void RequireExpected(IEnumerable<long> expectedCreated, IEnumerable<long> actualAdded,
            IEnumerable<long> actualModified, IEnumerable<long> actualDeleted, IEnumerable<long> preservedOwnerIds)
        {
            var created = expectedCreated.ToArray(); var added = actualAdded.ToArray();
            var modified = actualModified.ToArray(); var deleted = actualDeleted.ToArray();
            var allowed = preservedOwnerIds.ToArray();
            bool Valid(long[] ids) => ids.All(id => id > 0) && ids.Distinct().Count() == ids.Length;
            // Two physical creations and at most one independently parent-bound
            // derived centerlines. This method does not establish that binding.
            if (created.Length < 2 || created.Length > 3 || !Valid(created) || !Valid(added) || !Valid(modified)
                || !Valid(allowed) || allowed.Length > 128 || !created.All(allowed.Contains)
                || deleted.Length != 0 || !added.OrderBy(id => id).SequenceEqual(created.OrderBy(id => id))
                || modified.Any(id => !allowed.Contains(id)))
                throw new InvalidOperationException("Inline insertion changed an unexpected native owner; atomic rollback is required.");
        }
    }
}

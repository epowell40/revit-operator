using System;
using System.Collections;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    public static class BoundedNativeSequence
    {
        // Read one extra item to distinguish an exact-limit result from truncation.
        // Do not enumerate the rest merely to manufacture a total for lazy native results.
        public static object Project(IEnumerable source, Func<object?, object?> project, int limit = 50)
        {
            if (source == null) throw new ArgumentNullException(nameof(source));
            if (project == null) throw new ArgumentNullException(nameof(project));
            if (limit < 1 || limit > 2000) throw new ArgumentOutOfRangeException(nameof(limit));
            var items = new List<object?>();
            var iterator = source.GetEnumerator();
            bool hasMore;
            try
            {
                while (items.Count < limit && iterator.MoveNext()) items.Add(project(iterator.Current));
                hasMore = items.Count == limit && iterator.MoveNext();
            }
            finally { (iterator as IDisposable)?.Dispose(); }
            return new { count = items.Count, items, limit, hasMore, truncated = hasMore,
                complete = !hasMore, total = hasMore ? (int?)null : items.Count };
        }
    }
}

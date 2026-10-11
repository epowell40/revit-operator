using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class ScheduleEligibleField
    {
        public long parameterId { get; set; }
        public string fieldType { get; set; } = "";
        public string name { get; set; } = "";
    }

    public static class ScheduleEligibleFieldPage
    {
        public static object Create(long scheduleId, IEnumerable<ScheduleEligibleField> source, int offset, int limit)
        {
            if (offset < 0 || offset > 1000000 || limit < 1 || limit > 200)
                throw new ArgumentException("Invalid schedulable-field page: offset 0..1000000, limit 1..200 required.");
            var fields = source.OrderBy(field => field.parameterId)
                .ThenBy(field => field.fieldType, StringComparer.Ordinal)
                .ThenBy(field => field.name, StringComparer.Ordinal).ToList();
            var items = fields.Skip(offset).Take(limit).ToList();
            var hasMore = offset < fields.Count && items.Count < fields.Count - offset;
            return new { scheduleId, offset, limit, total = fields.Count, returned = items.Count, items,
                hasMore, truncated = hasMore, complete = offset == 0 && !hasMore,
                nextOffset = hasMore ? (int?)(offset + items.Count) : null };
        }
    }
}

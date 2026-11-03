using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    // Positive native association for navigation only. Never substitutes a
    // placement for a definition in inspection/effect verification.
    public sealed class OperatorScheduleFocusAssociation
    {
        public long scheduleId { get; set; }
        public string scheduleUniqueId { get; set; } = "";
        public long instanceId { get; set; }
        public string instanceUniqueId { get; set; } = "";
        public long sheetId { get; set; }
        public string sheetUniqueId { get; set; } = "";

        public static OperatorScheduleFocusAssociation? Unique(long sheet, long schedule,
            IEnumerable<OperatorScheduleFocusAssociation> actualPlacements)
        {
            var rows = actualPlacements.Take(201).ToArray();
            if (sheet <= 0 || schedule <= 0 || rows.Length > 200) return null;
            var matches = rows.Where(row => row.sheetId == sheet && row.scheduleId == schedule).ToArray();
            if (matches.Length != 1) return null; // Split/repeated placement is ambiguous; do not guess.
            var result = matches[0];
            if (result.instanceId <= 0 || result.instanceId == schedule || result.instanceId == sheet
                || new[] { result.sheetUniqueId, result.scheduleUniqueId, result.instanceUniqueId }
                    .Any(uid => string.IsNullOrWhiteSpace(uid) || uid.Length > 200)) return null;
            return result;
        }
    }
}

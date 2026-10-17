using System;

namespace RevitBridge.Common
{
    public static class NativeApiSearchScore
    {
        public static int Compute(string query, string name, string typeName, string signature,
            string searchText, int priority, bool callable)
        {
            if (string.IsNullOrWhiteSpace(query)) return 0;
            var q = query.Trim().ToLowerInvariant();
            var score = 0;
            var tokens = q.Split(new[] { ' ', '\t', '\r', '\n', '/', '-', '_' }, StringSplitOptions.RemoveEmptyEntries);
            if (name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) score += 80;
            if (typeName.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) score += 60;
            if (signature.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) score += 50;
            foreach (var token in tokens) if (searchText.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0) score += 8;
            // Priority is a ranking hint among lexical matches, never evidence
            // that a member matches the query. Both catalog and search use >0.
            if (score == 0) return 0;
            score += priority / 3;
            if (callable) score += 4;
            return score;
        }
    }
}

using System;
using System.Linq;

namespace RevitBridge.Common
{
    public static class MepSystemTypeNamePolicy
    {
        public static string Normalize(string? name)
        {
            return new string((name ?? "").Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
        }

        public static string? SelectExplicitName(string? requested, string[] candidates)
        {
            var query = (requested ?? "").Trim();
            if (query.Length == 0) return candidates.FirstOrDefault();
            return candidates.FirstOrDefault(name => name.Equals(query, StringComparison.OrdinalIgnoreCase))
                ?? candidates.FirstOrDefault(name => Normalize(name) == Normalize(query))
                ?? candidates.FirstOrDefault(name => name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0);
        }
    }
}

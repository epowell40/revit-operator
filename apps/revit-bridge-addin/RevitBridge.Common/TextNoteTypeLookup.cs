using System;

namespace RevitBridge.Common
{
    /// <summary>Separates an exact existing-type lookup from ordinary creation's legacy default.</summary>
    public static class TextNoteTypeLookup
    {
        public static T? Resolve<T>(long? id, string? name, Func<long, T?> byId,
            Func<string, T?> byExactName, Func<T?> fallback, bool allowFallback = true) where T : class
        {
            if (id.HasValue && id.Value > 0) return byId(id.Value);
            var requested = (name ?? "").Trim();
            if (requested.Length > 0)
            {
                var named = byExactName(requested);
                if (named != null) return named;
            }
            return allowFallback ? fallback() : null;
        }
    }
}

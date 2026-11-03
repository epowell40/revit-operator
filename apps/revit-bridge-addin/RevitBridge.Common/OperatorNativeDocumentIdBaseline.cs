using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    /// <summary>Retains the complete native collector identity set, including real element zero.</summary>
    public static class OperatorNativeDocumentIdBaseline
    {
        public const int MaximumElements = 250000;

        public static HashSet<long> Capture(IEnumerable<long> nativeIds, Func<long, bool> resolvesNonpositiveElement)
        {
            if (nativeIds == null) throw new ArgumentNullException(nameof(nativeIds));
            if (resolvesNonpositiveElement == null) throw new ArgumentNullException(nameof(resolvesNonpositiveElement));
            var result = new HashSet<long>();
            foreach (var id in nativeIds)
            {
                if (result.Count >= MaximumElements)
                    throw new InvalidOperationException("Native mutation scope baseline exceeds 250000 elements; no transaction was started.");
                if (!result.Add(id))
                    throw new InvalidOperationException("Native mutation scope baseline is incomplete: duplicate native element id " + id + "; no transaction was started.");
                // Zero is a real element in some native family templates. Keep it
                // only when the host resolves that exact identity in this document.
                // Retaining an identity in the baseline never grants it write scope.
                if (id <= 0 && !resolvesNonpositiveElement(id))
                    throw new InvalidOperationException("Native mutation scope baseline is incomplete: unresolved native element id " + id + "; no transaction was started.");
            }
            return result;
        }
    }
}

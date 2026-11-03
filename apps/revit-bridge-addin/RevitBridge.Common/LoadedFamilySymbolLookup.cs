using System;

namespace RevitBridge.Common
{
    /// <summary>A tag owns a family symbol even though it is not a FamilyInstance.
    /// Resolve the annotation's type, never the type of the element it tags.</summary>
    public static class LoadedFamilySymbolLookup
    {
        /// <summary>Read-only pre-placement inspection may start from a loaded
        /// symbol. Editing still uses Resolve and requires an instance or tag.</summary>
        public static TSymbol? ResolveForInspection<TElement, TSymbol>(TElement source,
            Func<TElement, TSymbol?> directSymbol,
            Func<TElement, TSymbol?> instanceSymbol,
            Func<TElement, bool> isIndependentTag,
            Func<TElement, long> ownTypeId,
            Func<long, TSymbol?> findSymbol) where TSymbol : class
        {
            return directSymbol(source) ?? Resolve(source, instanceSymbol, isIndependentTag, ownTypeId, findSymbol);
        }

        public static TSymbol? Resolve<TElement, TSymbol>(TElement source,
            Func<TElement, TSymbol?> instanceSymbol,
            Func<TElement, bool> isIndependentTag,
            Func<TElement, long> ownTypeId,
            Func<long, TSymbol?> findSymbol) where TSymbol : class
        {
            var symbol = instanceSymbol(source);
            if (symbol != null) return symbol;
            if (!isIndependentTag(source)) return null;
            var typeId = ownTypeId(source);
            return typeId > 0 ? findSymbol(typeId) : null;
        }
    }
}

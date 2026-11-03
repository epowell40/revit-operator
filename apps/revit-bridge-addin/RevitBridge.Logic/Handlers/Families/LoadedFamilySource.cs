using System;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    internal static class LoadedFamilySource
    {
        internal static FamilySymbol ResolveSymbolForInspection(Document doc, Element source)
        {
            return LoadedFamilySymbolLookup.ResolveForInspection<Element, FamilySymbol>(source,
                element => element as FamilySymbol,
                element => (element as FamilyInstance)?.Symbol,
                element => element is IndependentTag,
                element => ElementIdCompat.GetValue(element.GetTypeId()),
                id => doc.GetElement(ElementIdCompat.Create(id)) as FamilySymbol)
                ?? throw new InvalidOperationException("Element must be a loaded FamilySymbol, FamilyInstance or IndependentTag with a FamilySymbol type.");
        }

        internal static FamilySymbol ResolveSymbol(Document doc, Element source)
        {
            return LoadedFamilySymbolLookup.Resolve<Element, FamilySymbol>(source,
                element => (element as FamilyInstance)?.Symbol,
                element => element is IndependentTag,
                element => ElementIdCompat.GetValue(element.GetTypeId()),
                id => doc.GetElement(ElementIdCompat.Create(id)) as FamilySymbol)
                ?? throw new InvalidOperationException("Element must be a loaded FamilyInstance or IndependentTag with a FamilySymbol type.");
        }
    }
}

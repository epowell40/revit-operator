using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitBridge.Handlers
{
    internal sealed class TitleBlockSelection
    {
        public ElementId TypeId { get; set; } = ElementId.InvalidElementId;
        public string Strategy { get; set; } = "";
        public string? FamilyName { get; set; }
        public string? TypeName { get; set; }
        public int UsedCount { get; set; }

        public object ToResponse()
        {
            return new
            {
                typeId = RevitBridge.Common.ElementIdCompat.GetValue(TypeId),
                strategy = Strategy,
                familyName = FamilyName,
                typeName = TypeName,
                usedCount = UsedCount
            };
        }
    }

    internal static class SheetTitleBlockSelectionHelper
    {
        public static TitleBlockSelection Resolve(
            Document doc,
            long requestedTitleBlockId,
            string? titleBlockName = null,
            string? referenceSheetNumber = null,
            string? newSheetNumber = null)
        {
            if (requestedTitleBlockId > 0)
            {
                return BuildSelection(doc, RevitBridge.Common.ElementIdCompat.Create(requestedTitleBlockId), "requestedId");
            }

            var types = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_TitleBlocks)
                .WhereElementIsElementType()
                .Cast<ElementType>()
                .Where(t => t != null)
                .ToList();

            if (types.Count == 0) throw new InvalidOperationException("No titleblock types found in document.");

            if (!string.IsNullOrWhiteSpace(titleBlockName))
            {
                var name = titleBlockName.Trim();
                var exact = types.FirstOrDefault(t => TypeText(t).Equals(name, StringComparison.OrdinalIgnoreCase));
                if (exact != null) return BuildSelection(doc, exact.Id, "nameExact");

                var contains = types
                    .Where(t => TypeText(t).IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0)
                    .OrderByDescending(t => UsageCounts(doc).TryGetValue(RevitBridge.Common.ElementIdCompat.GetValue(t.Id), out var c) ? c : 0)
                    .ThenBy(t => TypeText(t), StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();
                if (contains != null) return BuildSelection(doc, contains.Id, "nameContains");
            }

            if (!string.IsNullOrWhiteSpace(referenceSheetNumber))
            {
                var refSheet = ResolveSheetByNumber(doc, referenceSheetNumber.Trim());
                var refTitleBlock = refSheet == null ? null : TitleBlockInstanceOnSheet(doc, refSheet.Id);
                if (refTitleBlock != null)
                {
                    return BuildSelection(doc, refTitleBlock.GetTypeId(), "referenceSheet");
                }
            }

            var adjacent = FindAdjacentSheetTitleBlock(doc, newSheetNumber);
            if (adjacent != null)
            {
                return BuildSelection(doc, adjacent.GetTypeId(), "adjacentSheet");
            }

            var counts = UsageCounts(doc);
            var best = types
                .Select(t => new
                {
                    Type = t,
                    Count = counts.TryGetValue(RevitBridge.Common.ElementIdCompat.GetValue(t.Id), out var c) ? c : 0,
                    Penalty = TypeText(t).IndexOf("cover", StringComparison.OrdinalIgnoreCase) >= 0 ? 1 : 0
                })
                .OrderByDescending(x => x.Count)
                .ThenBy(x => x.Penalty)
                .ThenBy(x => TypeText(x.Type), StringComparer.OrdinalIgnoreCase)
                .First();

            return BuildSelection(doc, best.Type.Id, best.Count > 0 ? "mostUsed" : "firstByName");
        }

        private static ViewSheet? ResolveSheetByNumber(Document doc, string sheetNumber)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .FirstOrDefault(s => s != null && !s.IsPlaceholder &&
                                     (s.SheetNumber ?? "").Equals(sheetNumber, StringComparison.OrdinalIgnoreCase));
        }

        private static FamilyInstance? FindAdjacentSheetTitleBlock(Document doc, string? newSheetNumber)
        {
            var parsed = ParseSheetNumber(newSheetNumber);
            if (parsed == null) return null;

            var sheets = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .Where(s => s != null && !s.IsPlaceholder)
                .Select(s => new { Sheet = s, Parsed = ParseSheetNumber(s.SheetNumber) })
                .Where(x => x.Parsed != null && x.Parsed.Value.Prefix.Equals(parsed.Value.Prefix, StringComparison.OrdinalIgnoreCase))
                .OrderBy(x => Math.Abs(x.Parsed!.Value.Number - parsed.Value.Number))
                .ThenBy(x => x.Sheet.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .ToList();

            foreach (var row in sheets)
            {
                var tb = TitleBlockInstanceOnSheet(doc, row.Sheet.Id);
                if (tb != null) return tb;
            }
            return null;
        }

        private static (string Prefix, int Number)? ParseSheetNumber(string? sheetNumber)
        {
            var s = (sheetNumber ?? "").Trim();
            if (s.Length == 0) return null;
            var i = s.Length - 1;
            while (i >= 0 && char.IsDigit(s[i])) i--;
            if (i == s.Length - 1) return null;
            var prefix = s.Substring(0, i + 1);
            if (!int.TryParse(s.Substring(i + 1), out var n)) return null;
            return (prefix, n);
        }

        private static FamilyInstance? TitleBlockInstanceOnSheet(Document doc, ElementId sheetId)
        {
            return new FilteredElementCollector(doc, sheetId)
                .OfCategory(BuiltInCategory.OST_TitleBlocks)
                .WhereElementIsNotElementType()
                .Cast<FamilyInstance>()
                .FirstOrDefault();
        }

        private static Dictionary<long, int> UsageCounts(Document doc)
        {
            return new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_TitleBlocks)
                .WhereElementIsNotElementType()
                .Cast<FamilyInstance>()
                .GroupBy(fi => RevitBridge.Common.ElementIdCompat.GetValue(fi.GetTypeId()))
                .ToDictionary(g => g.Key, g => g.Count());
        }

        private static TitleBlockSelection BuildSelection(Document doc, ElementId typeId, string strategy)
        {
            var type = doc.GetElement(typeId) as ElementType;
            var symbol = type as FamilySymbol;
            var counts = UsageCounts(doc);
            counts.TryGetValue(RevitBridge.Common.ElementIdCompat.GetValue(typeId), out var usedCount);
            return new TitleBlockSelection
            {
                TypeId = typeId,
                Strategy = strategy,
                FamilyName = symbol?.FamilyName,
                TypeName = type?.Name,
                UsedCount = usedCount
            };
        }

        private static string TypeText(ElementType type)
        {
            var symbol = type as FamilySymbol;
            return ((symbol?.FamilyName ?? "") + " " + (type?.Name ?? "")).Trim();
        }
    }
}

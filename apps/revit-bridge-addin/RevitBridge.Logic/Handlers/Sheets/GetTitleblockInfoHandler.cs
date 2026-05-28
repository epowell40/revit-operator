using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class GetTitleblockInfoHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sheetNumber { get; set; }
            public long? sheetId { get; set; }
            public long? sheetViewId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            ViewSheet? sheet = null;
            var sid = p.sheetId ?? p.sheetViewId;
            if (sid.HasValue && sid.Value != 0)
            {
                sheet = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(sid.Value)) as ViewSheet;
            }
            else if (!string.IsNullOrWhiteSpace(p.sheetNumber))
            {
                var target = (p.sheetNumber ?? "").Trim();
                sheet = new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .FirstOrDefault(s => string.Equals((s.SheetNumber ?? "").Trim(), target, StringComparison.OrdinalIgnoreCase));
            }
            if (sheet == null) throw new InvalidOperationException("Sheet not found (provide sheetId/sheetViewId or sheetNumber).");

            var titleblocks = new FilteredElementCollector(doc, sheet.Id)
                .OfCategory(BuiltInCategory.OST_TitleBlocks)
                .WhereElementIsNotElementType()
                .Cast<Element>()
                .Select(e => e as FamilyInstance)
                .Where(e => e != null)
                .Cast<FamilyInstance>()
                .ToList();

            var tb = titleblocks.FirstOrDefault();
            if (tb == null) throw new InvalidOperationException($"No titleblock instances found on sheet '{sheet.SheetNumber}'.");

            var symbol = tb.Symbol;
            var family = symbol?.Family;

            return Task.FromResult<object>(new
            {
                ok = true,
                sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                sheetNumber = sheet.SheetNumber,
                titleblockInstanceId = RevitBridge.Common.ElementIdCompat.GetValue(tb.Id),
                titleblockTypeId = RevitBridge.Common.ElementIdCompat.GetValue(symbol?.Id),
                familyId = RevitBridge.Common.ElementIdCompat.GetValue(family?.Id),
                familyName = family?.Name ?? "",
                familyTypeName = symbol?.Name ?? "",
                isInPlace = family?.IsInPlace ?? false,
                titleblockCount = titleblocks.Count
            });
        }
    }
}


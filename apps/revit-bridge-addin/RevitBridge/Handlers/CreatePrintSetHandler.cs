using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class CreatePrintSetHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? name { get; set; }
            public List<long>? sheetIds { get; set; }
            public List<string>? sheetNumbers { get; set; }
            public string? query { get; set; }
            public bool? exact { get; set; }
            public int? max { get; set; }
            public bool? all { get; set; }
            public bool? overwrite { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var name = (p.name ?? "").Trim();
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new InvalidOperationException("create-print-set.name is required.");
            }

            var exact = p.exact ?? false;
            var max = p.max.HasValue && p.max.Value > 0 ? Math.Min(p.max.Value, 5000) : 500;
            var all = p.all ?? false;
            var overwrite = p.overwrite ?? false;
            var dryRun = p.dryRun ?? false;

            var sheets = SheetSelectionHelper.ResolveSheets(
                doc,
                p.sheetIds,
                p.sheetNumbers,
                p.query,
                exact,
                max,
                all);

            if (sheets.Count == 0)
            {
                throw new InvalidOperationException("No sheets resolved. Provide sheetIds, sheetNumbers, query, or all:true.");
            }

            var existing = PrintSetsHandler.FindByName(doc, name);
            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    name,
                    overwrite,
                    existingSet = existing == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(existing.Id), name = existing.Name },
                    selectedCount = sheets.Count,
                    sheets = sheets.Select(s => new
                    {
                        sheetId = RevitBridge.Common.ElementIdCompat.GetValue(s.Id),
                        sheetNumber = s.SheetNumber,
                        sheetName = s.Name
                    }).ToList()
                });
            }

            using (var tx = new Transaction(doc, "Create Print Set"))
            {
                tx.Start();

                if (existing != null)
                {
                    if (!overwrite)
                    {
                        tx.RollBack();
                        throw new InvalidOperationException($"Print set '{name}' already exists. Use overwrite:true to replace.");
                    }

                    doc.Delete(existing.Id);
                }

                var pm = doc.PrintManager;
                pm.PrintRange = PrintRange.Select;
                var setting = pm.ViewSheetSetting;

                var viewSet = new ViewSet();
                foreach (var sheet in sheets)
                {
                    viewSet.Insert(sheet);
                }

                setting.CurrentViewSheetSet.Views = viewSet;
                setting.SaveAs(name);
                tx.Commit();
            }

            var saved = PrintSetsHandler.FindByName(doc, name);
            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                name,
                setId = RevitBridge.Common.ElementIdCompat.GetValue(saved?.Id),
                selectedCount = sheets.Count,
                sheets = sheets.Select(s => new
                {
                    sheetId = RevitBridge.Common.ElementIdCompat.GetValue(s.Id),
                    sheetNumber = s.SheetNumber,
                    sheetName = s.Name
                }).ToList()
            });
        }
    }
}

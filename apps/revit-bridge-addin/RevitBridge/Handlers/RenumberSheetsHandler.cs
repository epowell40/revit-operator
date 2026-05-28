using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class RenumberSheetsHandler : IRequestHandler
    {
        public sealed class Change
        {
            public long sheetId { get; set; }
            public string? newNumber { get; set; }
            public string? newName { get; set; }
        }

        public sealed class Params
        {
            public List<Change>? changes { get; set; }
            public bool? dryRun { get; set; }
            public string? behavior { get; set; } // allOrNothing|bestEffort
        }

        private sealed class ResultEntry
        {
            public int index { get; set; }
            public long sheetId { get; set; }
            public bool ok { get; set; }
            public string? beforeNumber { get; set; }
            public string? afterNumber { get; set; }
            public string? beforeName { get; set; }
            public string? afterName { get; set; }
            public string? error { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var changes = (p.changes ?? new List<Change>()).Where(x => x != null && x.sheetId > 0).ToList();
            if (changes.Count == 0) throw new InvalidOperationException("renumber-sheets.changes is required and must be a non-empty array.");
            if (changes.Count > 500) throw new InvalidOperationException("renumber-sheets.changes too large (max 500).");

            var dryRun = p.dryRun ?? false;
            var behavior = (p.behavior ?? "bestEffort").Trim();
            var allOrNothing = behavior.Equals("allOrNothing", StringComparison.OrdinalIgnoreCase);

            var results = new List<ResultEntry>(capacity: changes.Count);

            Action doWork = () =>
            {
                for (int i = 0; i < changes.Count; i++)
                {
                    var ch = changes[i];
                    var sheet = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(ch.sheetId)) as ViewSheet;
                    if (sheet == null || sheet.IsPlaceholder)
                    {
                        results.Add(new ResultEntry { index = i, sheetId = ch.sheetId, ok = false, error = "Sheet not found." });
                        if (allOrNothing && !dryRun) throw new InvalidOperationException("Sheet not found.");
                        continue;
                    }

                    var newNum = (ch.newNumber ?? "").Trim();
                    var newName = (ch.newName ?? "").Trim();

                    var beforeNum = sheet.SheetNumber;
                    var beforeName = sheet.Name;

                    try
                    {
                        if (!string.IsNullOrWhiteSpace(newName)) sheet.Name = newName;
                        if (!string.IsNullOrWhiteSpace(newNum)) sheet.SheetNumber = newNum;

                        results.Add(new ResultEntry
                        {
                            index = i,
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                            ok = true,
                            beforeNumber = beforeNum,
                            afterNumber = sheet.SheetNumber,
                            beforeName = beforeName,
                            afterName = sheet.Name
                        });
                    }
                    catch (Exception ex)
                    {
                        // Attempt to restore for best-effort dry-run within a transaction scope.
                        try { sheet.Name = beforeName; } catch { }
                        try { sheet.SheetNumber = beforeNum; } catch { }

                        results.Add(new ResultEntry
                        {
                            index = i,
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                            ok = false,
                            beforeNumber = beforeNum,
                            afterNumber = beforeNum,
                            beforeName = beforeName,
                            afterName = beforeName,
                            error = ex.Message
                        });
                        if (allOrNothing && !dryRun) throw;
                    }
                }
            };

            if (dryRun)
            {
                using (var t = new Transaction(doc, "Renumber Sheets (Dry Run)"))
                {
                    t.Start();
                    doWork();
                    t.RollBack();
                }
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    behavior = allOrNothing ? "allOrNothing" : "bestEffort",
                    requestedCount = changes.Count,
                    results
                });
            }

            using (var t = new Transaction(doc, "Renumber Sheets"))
            {
                t.Start();
                try
                {
                    doWork();
                    t.Commit();
                }
                catch (Exception ex)
                {
                    try { t.RollBack(); } catch { }
                    return Task.FromResult<object>(new
                    {
                        status = "Failed",
                        dryRun = false,
                        behavior = "allOrNothing",
                        requestedCount = changes.Count,
                        results,
                        error = ex.Message
                    });
                }
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                behavior = allOrNothing ? "allOrNothing" : "bestEffort",
                requestedCount = changes.Count,
                results
            });
        }
    }
}


using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class SyncSheetNamesHandler : IRequestHandler
    {
        public sealed class Params
        {
            public List<long>? sheetIds { get; set; }
            public bool? force { get; set; } // if false, only changes when different (still safe)
            public bool? dryRun { get; set; }
        }

        private sealed class ResultEntry
        {
            public long sheetId { get; set; }
            public string? sheetNumber { get; set; }
            public bool ok { get; set; }
            public string? beforeName { get; set; }
            public string? afterName { get; set; }
            public long? primaryViewportId { get; set; }
            public long? primaryViewId { get; set; }
            public string? primaryViewName { get; set; }
            public string? error { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var sheetIds = (p.sheetIds ?? new List<long>()).Where(x => x > 0).Distinct().ToList();
            if (sheetIds.Count == 0) throw new InvalidOperationException("sync-sheet-names.sheetIds is required and must be a non-empty array.");
            if (sheetIds.Count > 500) throw new InvalidOperationException("sync-sheet-names.sheetIds too large (max 500).");

            var dryRun = p.dryRun ?? false;
            var force = p.force ?? true;

            var results = new List<ResultEntry>(capacity: sheetIds.Count);

            Action doWork = () =>
            {
                foreach (var sid in sheetIds)
                {
                    var sheet = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(sid)) as ViewSheet;
                    if (sheet == null || sheet.IsPlaceholder)
                    {
                        results.Add(new ResultEntry { sheetId = sid, ok = false, error = "Sheet not found." });
                        continue;
                    }

                    var before = sheet.Name;
                    try
                    {
                        var primary = ResolvePrimaryViewport(doc, sheet);
                        if (primary == null)
                        {
                            results.Add(new ResultEntry
                            {
                                sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                                sheetNumber = sheet.SheetNumber,
                                ok = false,
                                beforeName = before,
                                afterName = before,
                                error = "No viewports on sheet."
                            });
                            continue;
                        }

                        var view = doc.GetElement(primary.ViewId) as View;
                        var viewName = view?.Name ?? "";
                        if (string.IsNullOrWhiteSpace(viewName)) throw new InvalidOperationException("Primary viewport view name is empty.");

                        if (force || !string.Equals(before ?? "", viewName, StringComparison.Ordinal))
                        {
                            sheet.Name = viewName;
                        }

                        results.Add(new ResultEntry
                        {
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                            sheetNumber = sheet.SheetNumber,
                            ok = true,
                            beforeName = before,
                            afterName = sheet.Name,
                            primaryViewportId = RevitBridge.Common.ElementIdCompat.GetValue(primary.Id),
                            primaryViewId = RevitBridge.Common.ElementIdCompat.GetValue(primary.ViewId),
                            primaryViewName = viewName
                        });
                    }
                    catch (Exception ex)
                    {
                        try { sheet.Name = before; } catch { }
                        results.Add(new ResultEntry
                        {
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                            sheetNumber = sheet.SheetNumber,
                            ok = false,
                            beforeName = before,
                            afterName = before,
                            error = ex.Message
                        });
                    }
                }
            };

            if (dryRun)
            {
                using (var t = new Transaction(doc, "Sync Sheet Names (Dry Run)"))
                {
                    t.Start();
                    doWork();
                    t.RollBack();
                }

                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    requestedCount = sheetIds.Count,
                    results
                });
            }

            using (var t = new Transaction(doc, "Sync Sheet Names"))
            {
                t.Start();
                doWork();
                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                requestedCount = sheetIds.Count,
                results
            });
        }

        private static Viewport? ResolvePrimaryViewport(Document doc, ViewSheet sheet)
        {
            try
            {
                var viewportIds = sheet.GetAllViewports();
                if (viewportIds == null || viewportIds.Count == 0) return null;

                Viewport? best = null;
                double bestArea = -1;
                foreach (var id in viewportIds)
                {
                    var vp = doc.GetElement(id) as Viewport;
                    if (vp == null) continue;
                    try
                    {
                        var o = vp.GetBoxOutline();
                        var min = o.MinimumPoint;
                        var max = o.MaximumPoint;
                        var area = Math.Abs((max.X - min.X) * (max.Y - min.Y));
                        if (area > bestArea)
                        {
                            bestArea = area;
                            best = vp;
                        }
                    }
                    catch { }
                }
                return best;
            }
            catch
            {
                return null;
            }
        }
    }
}


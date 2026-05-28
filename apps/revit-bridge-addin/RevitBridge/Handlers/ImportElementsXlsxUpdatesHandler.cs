using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ImportElementsXlsxUpdatesHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sourcePath { get; set; } // under Workspace
            public string? sheetName { get; set; }
            public string? range { get; set; } // must include header row

            public string? idColumn { get; set; } // UniqueId|ElementId
            public bool? dryRun { get; set; }
            public string? behavior { get; set; } // allOrNothing|bestEffort
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var src = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(src)) throw new InvalidOperationException("import-elements-xlsx-updates.sourcePath is required (path under Workspace).");
            var full = WorkspacePaths.ResolveExistingFileUnderWorkspace(src);

            var rangeA1 = (p.range ?? "").Trim();
            if (string.IsNullOrWhiteSpace(rangeA1)) throw new InvalidOperationException("import-elements-xlsx-updates.range is required (e.g. A1:G200).");

            var idCol = (p.idColumn ?? "UniqueId").Trim();
            if (!idCol.Equals("UniqueId", StringComparison.OrdinalIgnoreCase) && !idCol.Equals("ElementId", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("import-elements-xlsx-updates.idColumn must be UniqueId or ElementId.");

            var dryRun = p.dryRun ?? false;
            var behavior = (p.behavior ?? "bestEffort").Trim();
            var allOrNothing = behavior.Equals("allOrNothing", StringComparison.OrdinalIgnoreCase);

            var rr = ImportExcelTableHandler.XlsxOpenXml.ReadRange(full, (p.sheetName ?? "").Trim(), rangeA1);
            if (rr.Rows < 2) throw new InvalidOperationException("Excel range must include a header row and at least one data row.");
            if (rr.Rows > 2001 || rr.Cols > 120) throw new InvalidOperationException("Excel range too large (max 2000 rows x 120 cols).");

            var header = rr.Grid[0].Select(x => (x ?? "").Trim()).ToList();
            var idIndex = header.FindIndex(x => x.Equals(idCol, StringComparison.OrdinalIgnoreCase));
            if (idIndex < 0) throw new InvalidOperationException($"Header row must include '{idCol}' column.");

            // Treat every other non-empty header as a parameter name.
            var paramCols = new List<(int idx, string name)>();
            for (int c = 0; c < header.Count; c++)
            {
                if (c == idIndex) continue;
                var h = header[c];
                if (string.IsNullOrWhiteSpace(h)) continue;
                paramCols.Add((c, h));
            }
            if (paramCols.Count == 0) throw new InvalidOperationException("No parameter columns found (all headers besides id column were empty).");

            var diffs = new List<object>(capacity: Math.Min(20000, (rr.Rows - 1) * Math.Min(paramCols.Count, 20)));
            var changedCount = 0;
            var rowCount = 0;

            Action doWork = () =>
            {
                for (int r = 1; r < rr.Grid.Count; r++)
                {
                    rowCount++;
                    var row = rr.Grid[r];
                    var idVal = idIndex < row.Count ? (row[idIndex] ?? "").Trim() : "";
                    if (string.IsNullOrWhiteSpace(idVal)) continue;

                    Element? el = null;
                    if (idCol.Equals("UniqueId", StringComparison.OrdinalIgnoreCase))
                    {
                        try { el = doc.GetElement(idVal); } catch { el = null; }
                    }
                    else
                    {
                        if (long.TryParse(idVal, out var eid) && eid > 0)
                            el = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(eid));
                    }

                    if (el == null)
                    {
                        diffs.Add(new { row = r + 1, id = idVal, ok = false, error = "Element not found." });
                        if (allOrNothing && !dryRun) throw new InvalidOperationException($"Row {r + 1}: element not found.");
                        continue;
                    }

                    foreach (var pc in paramCols)
                    {
                        var next = pc.idx < row.Count ? (row[pc.idx] ?? "") : "";
                        if (string.IsNullOrWhiteSpace(next)) continue; // blank cell => no update
                        var param = el.LookupParameter(pc.name);
                        if (param == null)
                        {
                            diffs.Add(new { row = r + 1, id = idVal, elementId = RevitBridge.Common.ElementIdCompat.GetValue(el.Id), parameterName = pc.name, ok = false, changed = false, error = "Parameter not found." });
                            if (allOrNothing && !dryRun) throw new InvalidOperationException($"Row {r + 1}: parameter '{pc.name}' not found.");
                            continue;
                        }

                        var before = ParameterValueUtil.SnapshotForWire(param);
                        if (!ParameterValueUtil.TrySetFromString(param, next, out var changed, out var message))
                        {
                            diffs.Add(new { row = r + 1, id = idVal, elementId = RevitBridge.Common.ElementIdCompat.GetValue(el.Id), parameterName = pc.name, ok = false, changed = false, error = message, before, after = before });
                            if (allOrNothing && !dryRun) throw new InvalidOperationException($"Row {r + 1}: {message}");
                            continue;
                        }

                        var after = ParameterValueUtil.SnapshotForWire(param);
                        if (changed) changedCount++;
                        diffs.Add(new { row = r + 1, id = idVal, elementId = RevitBridge.Common.ElementIdCompat.GetValue(el.Id), parameterName = pc.name, ok = true, changed, before, after });
                    }
                }
            };

            if (dryRun)
            {
                using (var t = new Transaction(doc, "Import Excel Updates (Dry Run)"))
                {
                    t.Start();
                    doWork();
                    t.RollBack();
                }

                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    sourcePath = src,
                    sheetName = rr.SheetName,
                    range = rangeA1,
                    idColumn = idCol,
                    paramCount = paramCols.Count,
                    rowCount,
                    changedCount,
                    diffs = diffs.Take(5000).ToList(),
                    warning = diffs.Count > 5000 ? "Diff list truncated to 5000 rows." : null
                });
            }

            using (var t = new Transaction(doc, "Import Excel Updates"))
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
                    return Task.FromResult<object>(new { status = "Failed", dryRun = false, error = ex.Message, diffs = diffs.Take(5000).ToList() });
                }
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                sourcePath = src,
                sheetName = rr.SheetName,
                range = rangeA1,
                idColumn = idCol,
                paramCount = paramCols.Count,
                rowCount,
                changedCount,
                diffs = diffs.Take(2000).ToList(),
                warning = diffs.Count > 2000 ? "Diff list truncated to 2000 rows." : null
            });
        }
    }
}

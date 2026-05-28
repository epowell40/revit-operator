using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Xml.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ImportExcelTableHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sourcePath { get; set; }
            public string? sheetName { get; set; }
            public string? range { get; set; } // A1 range like A1:G40

            public long? viewId { get; set; }
            public string? viewName { get; set; }
            public string? textTypeName { get; set; }
            public string? lineStyleName { get; set; }

            public double? cellWidthInches { get; set; }
            public double? cellHeightInches { get; set; }
            public double? marginInches { get; set; }
            public double? startXInches { get; set; }
            public double? startYInches { get; set; }

            public string? sheetNumber { get; set; } // optional: place resulting drafting view on sheet
            public long? sheetViewId { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var src = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(src)) throw new InvalidOperationException("import-excel-table.sourcePath is required (path under Workspace).");

            var full = WorkspacePaths.ResolveExistingFileUnderWorkspace(src);
            var ext = (Path.GetExtension(full) ?? "").Trim().ToLowerInvariant();
            if (ext != ".xlsx") throw new InvalidOperationException("import-excel-table currently supports .xlsx only (Save As .xlsx and try again).");

            var rangeA1 = (p.range ?? "").Trim();
            if (string.IsNullOrWhiteSpace(rangeA1)) throw new InvalidOperationException("import-excel-table.range is required (e.g. A1:G40).");

            var cellWIn = ClampDouble(p.cellWidthInches ?? 1.0, 0.1, 48.0);
            var cellHIn = ClampDouble(p.cellHeightInches ?? 0.25, 0.05, 24.0);
            var marginIn = ClampDouble(p.marginInches ?? 0.06, 0.0, 2.0);
            var startXIn = p.startXInches ?? 0.0;
            var startYIn = p.startYInches ?? 0.0;
            var dryRun = p.dryRun ?? false;

            var req = XlsxOpenXml.ReadRange(full, (p.sheetName ?? "").Trim(), rangeA1);
            if (req.Rows <= 0 || req.Cols <= 0) throw new InvalidOperationException("Excel range produced an empty grid.");
            if (req.Rows > 200 || req.Cols > 50) throw new InvalidOperationException("Excel range too large (max 200 rows x 50 cols).");

            var plan = new
            {
                sourcePath = src,
                sourceFullPath = full,
                sheetName = req.SheetName,
                range = rangeA1,
                rows = req.Rows,
                cols = req.Cols,
                cellWidthInches = cellWIn,
                cellHeightInches = cellHIn,
                marginInches = marginIn,
                startXInches = startXIn,
                startYInches = startYIn,
                viewName = (p.viewName ?? "Excel Table").Trim(),
                placeOnSheet = !string.IsNullOrWhiteSpace(p.sheetNumber) || (p.sheetViewId.HasValue && p.sheetViewId.Value > 0),
                sheetNumber = (p.sheetNumber ?? "").Trim(),
                sheetViewId = p.sheetViewId
            };

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    plan,
                    preview = new
                    {
                        topLeft = req.Grid.Count > 0 && req.Grid[0].Count > 0 ? req.Grid[0][0] : "",
                        firstRow = req.Grid.Count > 0 ? req.Grid[0].Take(Math.Min(req.Cols, 8)).ToArray() : Array.Empty<string>()
                    }
                });
            }

            using (var t = new Transaction(doc, "Import Excel Table"))
            {
                t.Start();

                var view = ResolveOrCreateTargetView(doc, p.viewId, (p.viewName ?? "").Trim());
                var textTypeId = ResolveTextTypeId(doc, (p.textTypeName ?? "").Trim());
                var lineStyle = ResolveLineStyle(doc, (p.lineStyleName ?? "").Trim());

                var createdLineIds = new List<long>();
                var createdTextIds = new List<long>();

                DrawGrid(doc, view, req, cellWIn, cellHIn, startXIn, startYIn, lineStyle, createdLineIds);
                PlaceCellText(doc, view, req, cellWIn, cellHIn, startXIn, startYIn, marginIn, textTypeId, createdTextIds);

                long? viewportId = null;
                if (!string.IsNullOrWhiteSpace(p.sheetNumber) || (p.sheetViewId.HasValue && p.sheetViewId.Value > 0))
                {
                    var sheet = ResolveSheet(doc, p.sheetViewId, (p.sheetNumber ?? "").Trim());
                    if (sheet == null) throw new InvalidOperationException("Sheet not found for placement (sheetViewId/sheetNumber).");
                    viewportId = TryPlaceViewOnSheet(doc, sheet, view);
                }

                t.Commit();

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    dryRun = false,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    viewName = view.Name,
                    createdLineIds = createdLineIds.ToArray(),
                    createdTextNoteIds = createdTextIds.ToArray(),
                    sheetName = req.SheetName,
                    range = rangeA1,
                    rows = req.Rows,
                    cols = req.Cols,
                    viewportId
                });
            }
        }

        private static ViewSheet? ResolveSheet(Document doc, long? sheetViewId, string sheetNumber)
        {
            if (sheetViewId.HasValue && sheetViewId.Value > 0)
            {
                var v = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(sheetViewId.Value)) as ViewSheet;
                if (v != null) return v;
            }

            if (!string.IsNullOrWhiteSpace(sheetNumber))
            {
                return new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .FirstOrDefault(s => string.Equals(s.SheetNumber, sheetNumber, StringComparison.OrdinalIgnoreCase));
            }
            return null;
        }

        private static long? TryPlaceViewOnSheet(Document doc, ViewSheet sheet, View view)
        {
            try
            {
                var o = sheet.Outline;
                var cx = (o.Min.U + o.Max.U) * 0.5;
                var cy = (o.Min.V + o.Max.V) * 0.5;
                var pt = new XYZ(cx, cy, 0);
                var vp = Viewport.Create(doc, sheet.Id, view.Id, pt);
                return RevitBridge.Common.ElementIdCompat.GetValue(vp?.Id);
            }
            catch
            {
                // Best-effort: place at origin.
                try
                {
                    var vp = Viewport.Create(doc, sheet.Id, view.Id, new XYZ(0, 0, 0));
                    return RevitBridge.Common.ElementIdCompat.GetValue(vp?.Id);
                }
                catch
                {
                    return null;
                }
            }
        }

        private static void DrawGrid(Document doc, View view, XlsxOpenXml.RangeResult grid, double cellWIn, double cellHIn, double startXIn, double startYIn, GraphicsStyle? lineStyle, List<long> outIds)
        {
            var cols = grid.Cols;
            var rows = grid.Rows;

            var x0 = startXIn / 12.0;
            var y0 = startYIn / 12.0;
            var cw = cellWIn / 12.0;
            var ch = cellHIn / 12.0;

            // Grid boundaries in 0..cols and 0..rows.
            for (int c = 0; c <= cols; c++)
            {
                for (int r = 0; r < rows; r++)
                {
                    if (c > 0 && c < cols && grid.IsVerticalBoundarySuppressed(c, r)) continue;
                    var x = x0 + (c * cw);
                    var a = new XYZ(x, y0 - (r * ch), 0);
                    var b = new XYZ(x, y0 - ((r + 1) * ch), 0);
                    var line = Line.CreateBound(a, b);
                    var dc = doc.Create.NewDetailCurve(view, line);
                    if (lineStyle != null) { try { dc.LineStyle = lineStyle; } catch { } }
                    outIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(dc.Id));
                }
            }

            for (int r = 0; r <= rows; r++)
            {
                for (int c = 0; c < cols; c++)
                {
                    if (r > 0 && r < rows && grid.IsHorizontalBoundarySuppressed(r, c)) continue;
                    var y = y0 - (r * ch);
                    var a = new XYZ(x0 + (c * cw), y, 0);
                    var b = new XYZ(x0 + ((c + 1) * cw), y, 0);
                    var line = Line.CreateBound(a, b);
                    var dc = doc.Create.NewDetailCurve(view, line);
                    if (lineStyle != null) { try { dc.LineStyle = lineStyle; } catch { } }
                    outIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(dc.Id));
                }
            }
        }

        private static void PlaceCellText(
            Document doc,
            View view,
            XlsxOpenXml.RangeResult grid,
            double cellWIn,
            double cellHIn,
            double startXIn,
            double startYIn,
            double marginIn,
            ElementId textTypeId,
            List<long> outIds)
        {
            var cols = grid.Cols;
            var rows = grid.Rows;
            var x0 = startXIn / 12.0;
            var y0 = startYIn / 12.0;
            var cw = cellWIn / 12.0;
            var ch = cellHIn / 12.0;
            var m = marginIn / 12.0;

            for (int r = 0; r < rows; r++)
            {
                for (int c = 0; c < cols; c++)
                {
                    if (!grid.ShouldPlaceTextAtCell(r, c)) continue;
                    var text = (grid.Grid[r][c] ?? "").Trim();
                    if (string.IsNullOrWhiteSpace(text)) continue;

                    // Basic safety cap per cell.
                    if (text.Length > 2000) text = text.Substring(0, 2000);

                    var x = x0 + (c * cw) + m;
                    var y = y0 - (r * ch) - m;
                    var origin = new XYZ(x, y, 0);

                    var id = TextNote.Create(doc, view.Id, origin, text, textTypeId)?.Id;
                    if (id != null && id != ElementId.InvalidElementId) outIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(id));
                }
            }
        }

        private static GraphicsStyle? ResolveLineStyle(Document doc, string lineStyleName)
        {
            if (string.IsNullOrWhiteSpace(lineStyleName)) return null;
            try
            {
                var linesCat = doc.Settings.Categories.get_Item(BuiltInCategory.OST_Lines);
                if (linesCat == null) return null;
                foreach (Category sub in linesCat.SubCategories)
                {
                    if (sub == null) continue;
                    if (!string.Equals(sub.Name, lineStyleName, StringComparison.OrdinalIgnoreCase)) continue;
                    return sub.GetGraphicsStyle(GraphicsStyleType.Projection);
                }
            }
            catch
            {
                // ignore
            }
            return null;
        }

        private static View ResolveOrCreateTargetView(Document doc, long? viewId, string viewName)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                var v = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
                if (v != null) return v;
            }

            var name = string.IsNullOrWhiteSpace(viewName) ? "Excel Table" : viewName.Trim();
            var existing = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewDrafting))
                .Cast<ViewDrafting>()
                .FirstOrDefault(v => string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase));
            if (existing != null) return existing;

            var vft = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewFamilyType))
                .Cast<ViewFamilyType>()
                .FirstOrDefault(x => x.ViewFamily == ViewFamily.Drafting);
            if (vft == null) throw new InvalidOperationException("No Drafting ViewFamilyType found.");

            var created = ViewDrafting.Create(doc, vft.Id);
            created.Name = EnsureUniqueViewName(doc, name);
            return created;
        }

        private static string EnsureUniqueViewName(Document doc, string desiredName)
        {
            var name = string.IsNullOrWhiteSpace(desiredName) ? "Excel Table" : desiredName.Trim();
            var existing = new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => v != null && !v.IsTemplate)
                .Select(v => v.Name ?? "")
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (!existing.Contains(name)) return name;
            for (int i = 2; i <= 50; i++)
            {
                var cand = $"{name} ({i})";
                if (!existing.Contains(cand)) return cand;
            }
            return $"{name} ({Guid.NewGuid().ToString("N").Substring(0, 6)})";
        }

        private static ElementId ResolveTextTypeId(Document doc, string typeName)
        {
            if (!string.IsNullOrWhiteSpace(typeName))
            {
                var match = new FilteredElementCollector(doc)
                    .OfClass(typeof(TextNoteType))
                    .Cast<TextNoteType>()
                    .FirstOrDefault(t => string.Equals(t.Name, typeName, StringComparison.OrdinalIgnoreCase));
                if (match != null) return match.Id;
            }

            try
            {
                var def = doc.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType);
                if (def != null && def != ElementId.InvalidElementId) return def;
            }
            catch { }

            return new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).FirstElementId();
        }

        private static double ClampDouble(double v, double min, double max)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return min;
            if (v < min) return min;
            if (v > max) return max;
            return v;
        }

        internal static class XlsxOpenXml
        {
            internal sealed class MergeRect
            {
                public int TopRow;
                public int LeftCol;
                public int BottomRow;
                public int RightCol;
            }

            internal sealed class RangeResult
            {
                public string SheetName = "";
                public int Rows;
                public int Cols;
                public List<List<string>> Grid = new List<List<string>>();
                public List<MergeRect> Merges = new List<MergeRect>();

                public bool ShouldPlaceTextAtCell(int r, int c)
                {
                    foreach (var m in Merges)
                    {
                        if (r < m.TopRow || r > m.BottomRow || c < m.LeftCol || c > m.RightCol) continue;
                        return r == m.TopRow && c == m.LeftCol;
                    }
                    return true;
                }

                // boundaryCol is in 1..Cols-1 for internal boundaries (0 and Cols are outer edges).
                public bool IsVerticalBoundarySuppressed(int boundaryCol, int rowSegment)
                {
                    foreach (var m in Merges)
                    {
                        if (rowSegment < m.TopRow || rowSegment > m.BottomRow - 1) continue;
                        if (boundaryCol > m.LeftCol && boundaryCol <= m.RightCol) return true;
                    }
                    return false;
                }

                // boundaryRow is in 1..Rows-1 for internal boundaries.
                public bool IsHorizontalBoundarySuppressed(int boundaryRow, int colSegment)
                {
                    foreach (var m in Merges)
                    {
                        if (colSegment < m.LeftCol || colSegment > m.RightCol - 1) continue;
                        if (boundaryRow > m.TopRow && boundaryRow <= m.BottomRow) return true;
                    }
                    return false;
                }
            }

            public static RangeResult ReadRange(string fullXlsxPath, string sheetName, string rangeA1)
            {
                var rr = ParseRangeA1(rangeA1);
                var minCol = rr.minCol;
                var maxCol = rr.maxCol;
                var minRow = rr.minRow;
                var maxRow = rr.maxRow;

                using (var zip = ZipFile.OpenRead(fullXlsxPath))
                {
                    var sharedStrings = ReadSharedStrings(zip);
                    var sheetPath = ResolveWorksheetPath(zip, sheetName, out var resolvedSheetName);
                    var cells = ReadCells(zip, sheetPath, sharedStrings);
                    var merges = ReadMerges(zip, sheetPath);

                    var rows = maxRow - minRow + 1;
                    var cols = maxCol - minCol + 1;

                    var grid = new List<List<string>>(rows);
                    for (int r = 0; r < rows; r++)
                    {
                        var row = new List<string>(cols);
                        for (int c = 0; c < cols; c++)
                        {
                            var cellRef = ToCellRef(minCol + c, minRow + r);
                            row.Add(cells.TryGetValue(cellRef, out var v) ? v : "");
                        }
                        grid.Add(row);
                    }

                    // Clip merges to the requested range and shift to 0-based indices.
                    var clipped = new List<MergeRect>();
                    foreach (var m in merges)
                    {
                        var top = Math.Max(m.TopRow, minRow);
                        var bottom = Math.Min(m.BottomRow, maxRow);
                        var left = Math.Max(m.LeftCol, minCol);
                        var right = Math.Min(m.RightCol, maxCol);
                        if (top > bottom || left > right) continue;
                        if (top == bottom && left == right) continue;
                        clipped.Add(new MergeRect
                        {
                            TopRow = top - minRow,
                            BottomRow = bottom - minRow,
                            LeftCol = left - minCol,
                            RightCol = right - minCol
                        });
                    }

                    return new RangeResult
                    {
                        SheetName = resolvedSheetName,
                        Rows = rows,
                        Cols = cols,
                        Grid = grid,
                        Merges = clipped
                    };
                }
            }

            private static (int minCol, int minRow, int maxCol, int maxRow) ParseRangeA1(string range)
            {
                var s = (range ?? "").Trim().ToUpperInvariant();
                var parts = s.Split(':');
                if (parts.Length != 2) throw new InvalidOperationException("range must be an A1 range like A1:G40.");
                var a = ParseCellRef(parts[0]);
                var b = ParseCellRef(parts[1]);
                var minCol = Math.Min(a.col, b.col);
                var maxCol = Math.Max(a.col, b.col);
                var minRow = Math.Min(a.row, b.row);
                var maxRow = Math.Max(a.row, b.row);
                return (minCol, minRow, maxCol, maxRow);
            }

            private static (int col, int row) ParseCellRef(string cell)
            {
                var s = (cell ?? "").Trim().ToUpperInvariant();
                if (s.Length < 2) throw new InvalidOperationException($"Invalid cell ref: {cell}");
                int i = 0;
                int col = 0;
                while (i < s.Length && s[i] >= 'A' && s[i] <= 'Z')
                {
                    col = (col * 26) + (s[i] - 'A' + 1);
                    i++;
                }
                if (col <= 0) throw new InvalidOperationException($"Invalid cell ref: {cell}");
                var rowStr = s.Substring(i);
                if (!int.TryParse(rowStr, NumberStyles.Integer, CultureInfo.InvariantCulture, out var row) || row <= 0)
                    throw new InvalidOperationException($"Invalid cell ref: {cell}");
                return (col, row);
            }

            private static string ToCellRef(int col, int row)
            {
                var sb = new StringBuilder();
                int c = col;
                while (c > 0)
                {
                    c--;
                    sb.Insert(0, (char)('A' + (c % 26)));
                    c /= 26;
                }
                return sb.ToString() + row.ToString(CultureInfo.InvariantCulture);
            }

            private static List<string> ReadSharedStrings(ZipArchive zip)
            {
                var entry = zip.GetEntry("xl/sharedStrings.xml");
                if (entry == null) return new List<string>();
                using (var s = entry.Open())
                {
                    XDocument doc;
                    try { doc = XDocument.Load(s); } catch { return new List<string>(); }
                    var ns = doc.Root?.Name.Namespace ?? XNamespace.None;
                    return doc.Descendants(ns + "si")
                        .Select(si => string.Concat(si.Descendants(ns + "t").Select(t => t.Value)))
                        .Select(v => v ?? "")
                        .ToList();
                }
            }

            private static string ResolveWorksheetPath(ZipArchive zip, string requestedSheetName, out string resolvedSheetName)
            {
                resolvedSheetName = "";
                var wbEntry = zip.GetEntry("xl/workbook.xml");
                if (wbEntry == null) throw new InvalidOperationException("Invalid .xlsx: missing xl/workbook.xml");
                XDocument wb;
                using (var s = wbEntry.Open()) { wb = XDocument.Load(s); }
                var ns = wb.Root?.Name.Namespace ?? XNamespace.None;
                var relNs = XNamespace.Get("http://schemas.openxmlformats.org/officeDocument/2006/relationships");

                var sheets = wb.Descendants(ns + "sheet")
                    .Select(x => new
                    {
                        Name = (string?)x.Attribute("name") ?? "",
                        Rid = (string?)x.Attribute(relNs + "id") ?? ""
                    })
                    .Where(x => !string.IsNullOrWhiteSpace(x.Name) && !string.IsNullOrWhiteSpace(x.Rid))
                    .ToList();
                if (sheets.Count == 0) throw new InvalidOperationException("Invalid .xlsx: no sheets found.");

                var chosen = !string.IsNullOrWhiteSpace(requestedSheetName)
                    ? sheets.FirstOrDefault(x => string.Equals(x.Name, requestedSheetName, StringComparison.OrdinalIgnoreCase))
                    : sheets[0];
                if (chosen == null) chosen = sheets[0];
                resolvedSheetName = chosen.Name;

                var relEntry = zip.GetEntry("xl/_rels/workbook.xml.rels");
                if (relEntry == null) throw new InvalidOperationException("Invalid .xlsx: missing xl/_rels/workbook.xml.rels");

                XDocument rels;
                using (var s = relEntry.Open()) { rels = XDocument.Load(s); }
                var rns = XNamespace.Get("http://schemas.openxmlformats.org/package/2006/relationships");
                var rel = rels.Descendants(rns + "Relationship")
                    .FirstOrDefault(x => string.Equals((string?)x.Attribute("Id"), chosen.Rid, StringComparison.OrdinalIgnoreCase));
                var target = (string?)rel?.Attribute("Target") ?? "";
                if (string.IsNullOrWhiteSpace(target)) throw new InvalidOperationException("Invalid .xlsx: worksheet relationship missing target.");

                // Targets are relative to xl/
                var path = "xl/" + target.TrimStart('/');
                if (zip.GetEntry(path) == null) throw new InvalidOperationException($"Invalid .xlsx: missing worksheet entry {path}");
                return path;
            }

            private static Dictionary<string, string> ReadCells(ZipArchive zip, string sheetPath, List<string> sharedStrings)
            {
                var entry = zip.GetEntry(sheetPath);
                if (entry == null) throw new InvalidOperationException($"Invalid .xlsx: missing worksheet {sheetPath}");
                XDocument sheet;
                using (var s = entry.Open()) { sheet = XDocument.Load(s); }
                var ns = sheet.Root?.Name.Namespace ?? XNamespace.None;

                var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var c in sheet.Descendants(ns + "c"))
                {
                    var r = (string?)c.Attribute("r");
                    if (string.IsNullOrWhiteSpace(r)) continue;
                    var t = (string?)c.Attribute("t") ?? "";

                    string v = "";
                    if (string.Equals(t, "s", StringComparison.OrdinalIgnoreCase))
                    {
                        var idxStr = (string?)c.Element(ns + "v") ?? "";
                        if (int.TryParse(idxStr, out var idx) && idx >= 0 && idx < sharedStrings.Count) v = sharedStrings[idx];
                    }
                    else if (string.Equals(t, "inlineStr", StringComparison.OrdinalIgnoreCase))
                    {
                        var isEl = c.Element(ns + "is");
                        v = string.Concat(isEl?.Descendants(ns + "t").Select(x => x.Value) ?? Enumerable.Empty<string>());
                    }
                    else
                    {
                        v = (string?)c.Element(ns + "v") ?? "";
                    }

                    dict[r.Trim()] = v ?? "";
                }
                return dict;
            }

            private static List<MergeRect> ReadMerges(ZipArchive zip, string sheetPath)
            {
                var entry = zip.GetEntry(sheetPath);
                if (entry == null) return new List<MergeRect>();
                XDocument sheet;
                using (var s = entry.Open()) { sheet = XDocument.Load(s); }
                var ns = sheet.Root?.Name.Namespace ?? XNamespace.None;

                var outList = new List<MergeRect>();
                foreach (var mc in sheet.Descendants(ns + "mergeCell"))
                {
                    var r = ((string?)mc.Attribute("ref") ?? "").Trim();
                    if (string.IsNullOrWhiteSpace(r)) continue;
                    var parts = r.Split(':');
                    if (parts.Length != 2) continue;
                    try
                    {
                        var a = ParseCellRef(parts[0]);
                        var b = ParseCellRef(parts[1]);
                        outList.Add(new MergeRect
                        {
                            LeftCol = Math.Min(a.col, b.col),
                            RightCol = Math.Max(a.col, b.col),
                            TopRow = Math.Min(a.row, b.row),
                            BottomRow = Math.Max(a.row, b.row)
                        });
                    }
                    catch
                    {
                        continue;
                    }
                }
                return outList;
            }
        }
    }
}


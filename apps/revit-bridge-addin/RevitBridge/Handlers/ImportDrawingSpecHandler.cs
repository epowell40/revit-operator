using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Xml.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ImportDrawingSpecHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sourcePath { get; set; }
            public long? viewId { get; set; }
            public string? viewName { get; set; }
            public string? textTypeName { get; set; }

            public int? columns { get; set; }
            public double? columnWidthInches { get; set; }
            public double? columnHeightInches { get; set; }
            public double? gutterInches { get; set; }
            public double? marginInches { get; set; }
            public double? startXInches { get; set; }
            public double? startYInches { get; set; }

            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var src = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(src)) throw new InvalidOperationException("import-drawing-spec.sourcePath is required (path under Workspace).");

            var dryRun = p.dryRun ?? false;

            var full = WorkspacePaths.ResolveExistingFileUnderWorkspace(src);
            var ext = (Path.GetExtension(full) ?? "").Trim().ToLowerInvariant();
            var rawText = ReadSourceText(full, ext);

            // Safety cap: avoid creating gigantic TextNotes that can hang UI.
            if (rawText.Length > 300_000) rawText = rawText.Substring(0, 300_000);

            var columns = ClampInt(p.columns ?? 4, 1, 24);
            var colWIn = ClampDouble(p.columnWidthInches ?? 8.5, 1.0, 48.0);
            var colHIn = ClampDouble(p.columnHeightInches ?? 11.0, 1.0, 96.0);
            var gutterIn = ClampDouble(p.gutterInches ?? 0.25, 0.0, 12.0);
            var marginIn = ClampDouble(p.marginInches ?? 0.25, 0.0, 12.0);
            var startXIn = p.startXInches ?? 0.0;
            var startYIn = p.startYInches ?? 0.0;

            var plan = new
            {
                sourcePath = src,
                sourceFullPath = full,
                columns,
                columnWidthInches = colWIn,
                columnHeightInches = colHIn,
                gutterInches = gutterIn,
                marginInches = marginIn,
                startXInches = startXIn,
                startYInches = startYIn,
                textTypeName = string.IsNullOrWhiteSpace(p.textTypeName) ? null : p.textTypeName.Trim()
            };

            if (dryRun)
            {
                return Task.FromResult<object>(new { status = "Dry Run", dryRun = true, plan });
            }

            using (var t = new Transaction(doc, "Import Drawing Spec"))
            {
                t.Start();

                var view = ResolveOrCreateTargetView(doc, p.viewId, (p.viewName ?? "").Trim());
                var typeId = ResolveTextTypeId(doc, (p.textTypeName ?? "").Trim());

                var created = CreateSpecColumns(doc, view, typeId, rawText, columns, colWIn, colHIn, gutterIn, marginIn, startXIn, startYIn);

                t.Commit();

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    dryRun = false,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    viewName = view.Name,
                    createdTextNoteIds = created.CreatedIds.Select(id => RevitBridge.Common.ElementIdCompat.GetValue(id)).ToArray(),
                    columnsUsed = created.ColumnsUsed,
                    remainingLineCount = created.RemainingLineCount,
                    sourcePath = src
                });
            }
        }

        private sealed class CreateColumnsResult
        {
            public List<ElementId> CreatedIds { get; } = new List<ElementId>();
            public int ColumnsUsed { get; set; }
            public int RemainingLineCount { get; set; }
        }

        private static CreateColumnsResult CreateSpecColumns(
            Document doc,
            View view,
            ElementId textTypeId,
            string rawText,
            int columns,
            double columnWidthInches,
            double columnHeightInches,
            double gutterInches,
            double marginInches,
            double startXInches,
            double startYInches)
        {
            var lines = NormalizeLines(rawText);
            var result = new CreateColumnsResult();
            if (lines.Count == 0) return result;

            var colWidthFt = columnWidthInches / 12.0;
            var colHeightFt = columnHeightInches / 12.0;
            var gutterFt = gutterInches / 12.0;
            var marginFt = marginInches / 12.0;

            var textWidthFt = Math.Max(0.05, colWidthFt - (2 * marginFt));
            var maxHeightFt = Math.Max(0.05, colHeightFt - (2 * marginFt));

            // Desired top-left of the first column (text area, after margins).
            var startXFt = startXInches / 12.0 + marginFt;
            var startYFt = startYInches / 12.0 - marginFt;

            var cursor = 0;
            for (var col = 0; col < columns && cursor < lines.Count; col++)
            {
                var colLeftFt = startXFt + (col * (colWidthFt + gutterFt));
                var topLeft = new XYZ(colLeftFt, startYFt, 0);

                var take = FindMaxLinesThatFit(doc, view, textTypeId, topLeft, textWidthFt, maxHeightFt, lines, cursor);
                if (take <= 0)
                {
                    throw new InvalidOperationException("Drawing spec does not fit even a single line in the configured column height; reduce text size or increase columnHeightInches.");
                }

                var text = string.Join("\n", lines.Skip(cursor).Take(take));
                var note = CreateTextNote(doc, view, topLeft, textWidthFt, text, textTypeId);
                AlignTextNoteTopLeft(doc, view, note, topLeft);

                result.CreatedIds.Add(note.Id);
                cursor += take;
                result.ColumnsUsed = col + 1;
            }

            result.RemainingLineCount = Math.Max(0, lines.Count - cursor);
            return result;
        }

        private static int FindMaxLinesThatFit(
            Document doc,
            View view,
            ElementId textTypeId,
            XYZ desiredTopLeft,
            double widthFt,
            double maxHeightFt,
            List<string> lines,
            int startIndex)
        {
            var remaining = lines.Count - startIndex;
            if (remaining <= 0) return 0;

            int lo = 1;
            int hi = remaining;
            int best = 0;

            while (lo <= hi)
            {
                var mid = lo + (hi - lo) / 2;
                var candidate = string.Join("\n", lines.Skip(startIndex).Take(mid));
                var tmp = CreateTextNote(doc, view, desiredTopLeft, widthFt, candidate, textTypeId);
                try
                {
                    AlignTextNoteTopLeft(doc, view, tmp, desiredTopLeft);
                    var bb = tmp.get_BoundingBox(view);
                    if (bb == null) throw new InvalidOperationException("Unable to measure TextNote bounds.");
                    var height = bb.Max.Y - bb.Min.Y;
                    if (height <= maxHeightFt)
                    {
                        best = mid;
                        lo = mid + 1;
                    }
                    else
                    {
                        hi = mid - 1;
                    }
                }
                finally
                {
                    try { doc.Delete(tmp.Id); } catch { }
                }
            }

            return best;
        }

        private static void AlignTextNoteTopLeft(Document doc, View view, TextNote note, XYZ desiredTopLeft)
        {
            var bb = note.get_BoundingBox(view);
            if (bb == null) return;
            var dx = desiredTopLeft.X - bb.Min.X;
            var dy = desiredTopLeft.Y - bb.Max.Y;
            if (Math.Abs(dx) < 1e-8 && Math.Abs(dy) < 1e-8) return;
            ElementTransformUtils.MoveElement(doc, note.Id, new XYZ(dx, dy, 0));
        }

        private static TextNote CreateTextNote(Document doc, View view, XYZ origin, double widthFt, string text, ElementId textTypeId)
        {
            var opts = new TextNoteOptions(textTypeId)
            {
                HorizontalAlignment = HorizontalTextAlignment.Left
            };

            var methods = typeof(TextNote).GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Where(m => string.Equals(m.Name, "Create", StringComparison.Ordinal))
                .ToList();

            // Prefer overload: (Document, ElementId, XYZ, double, string, TextNoteOptions)
            foreach (var m in methods)
            {
                var ps = m.GetParameters();
                if (ps.Length != 6) continue;
                if (ps[0].ParameterType != typeof(Document)) continue;
                if (ps[1].ParameterType != typeof(ElementId)) continue;
                if (ps[2].ParameterType != typeof(XYZ)) continue;
                if (ps[3].ParameterType != typeof(double)) continue;
                if (ps[4].ParameterType != typeof(string)) continue;
                if (ps[5].ParameterType != typeof(TextNoteOptions)) continue;

                return (TextNote)m.Invoke(null, new object[] { doc, view.Id, origin, widthFt, text, opts });
            }

            // Fallback: (Document, ElementId, XYZ, string, ElementId)
            foreach (var m in methods)
            {
                var ps = m.GetParameters();
                if (ps.Length != 5) continue;
                if (ps[0].ParameterType != typeof(Document)) continue;
                if (ps[1].ParameterType != typeof(ElementId)) continue;
                if (ps[2].ParameterType != typeof(XYZ)) continue;
                if (ps[3].ParameterType != typeof(string)) continue;
                if (ps[4].ParameterType != typeof(ElementId)) continue;

                var tn = (TextNote)m.Invoke(null, new object[] { doc, view.Id, origin, text, textTypeId });
                TrySetTextNoteWidth(tn, widthFt);
                return tn;
            }

            throw new InvalidOperationException("No supported TextNote.Create overload found in this Revit version.");
        }

        private static void TrySetTextNoteWidth(TextNote tn, double widthFt)
        {
            try
            {
                var prop = tn.GetType().GetProperty("Width", BindingFlags.Public | BindingFlags.Instance);
                if (prop == null || !prop.CanWrite) return;
                if (prop.PropertyType != typeof(double)) return;
                prop.SetValue(tn, widthFt);
            }
            catch
            {
                // ignore
            }
        }

        private static View ResolveOrCreateTargetView(Document doc, long? viewId, string desiredName)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                var v = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
                if (v == null) throw new InvalidOperationException($"View {viewId.Value} not found.");
                return v;
            }

            var name = string.IsNullOrWhiteSpace(desiredName) ? $"Drawing Spec_{DateTime.Now:yyyyMMdd_HHmmss}" : desiredName;
            name = name.Trim();
            if (name.Length > 120) name = name.Substring(0, 120).Trim();
            name = EnsureUniqueViewName(doc, name);

            var vft = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewFamilyType))
                .Cast<ViewFamilyType>()
                .FirstOrDefault(x => x.ViewFamily == ViewFamily.Drafting);
            if (vft == null) throw new InvalidOperationException("No ViewFamilyType for Drafting views found.");

            var dv = ViewDrafting.Create(doc, vft.Id);
            dv.Name = name;
            return dv;
        }

        private static string EnsureUniqueViewName(Document doc, string name)
        {
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

        private static string ReadSourceText(string fullPath, string extLower)
        {
            if (string.Equals(extLower, ".txt", StringComparison.OrdinalIgnoreCase))
            {
                return File.ReadAllText(fullPath, Encoding.UTF8);
            }

            if (string.Equals(extLower, ".docx", StringComparison.OrdinalIgnoreCase))
            {
                return ExtractTextFromDocx(fullPath);
            }

            if (string.Equals(extLower, ".doc", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Legacy .doc is not supported. Please Save As .docx (or export as .txt) and try again.");
            }

            throw new InvalidOperationException($"Unsupported spec file type: {extLower}. Supported: .docx, .txt");
        }

        private static string ExtractTextFromDocx(string filePath)
        {
            using (var archive = ZipFile.OpenRead(filePath))
            {
                var entry = archive.GetEntry("word/document.xml");
                if (entry == null) throw new InvalidOperationException("Invalid .docx: missing word/document.xml");
                using (var s = entry.Open())
                using (var reader = new StreamReader(s, Encoding.UTF8, detectEncodingFromByteOrderMarks: true))
                {
                    var xml = reader.ReadToEnd();
                    return ExtractTextFromWordprocessingXml(xml);
                }
            }
        }

        private static string ExtractTextFromWordprocessingXml(string xml)
        {
            var w = XNamespace.Get("http://schemas.openxmlformats.org/wordprocessingml/2006/main");
            XDocument doc;
            try
            {
                doc = XDocument.Parse(xml, LoadOptions.None);
            }
            catch
            {
                return "";
            }

            var sb = new StringBuilder();
            var body = doc.Root?.Element(w + "body");
            if (body == null) return "";

            foreach (var p in body.Elements(w + "p"))
            {
                var para = new StringBuilder();
                foreach (var node in p.Descendants())
                {
                    if (node.Name == w + "t")
                    {
                        para.Append(node.Value);
                    }
                    else if (node.Name == w + "tab")
                    {
                        para.Append('\t');
                    }
                    else if (node.Name == w + "br" || node.Name == w + "cr")
                    {
                        para.Append('\n');
                    }
                }

                var text = para.ToString().TrimEnd('\r', '\n');
                sb.Append(text);
                sb.Append("\n\n");
            }

            return sb.ToString().Trim();
        }

        private static List<string> NormalizeLines(string raw)
        {
            var s = (raw ?? "").Replace("\r\n", "\n").Replace("\r", "\n");
            s = s.Trim();
            if (s.Length == 0) return new List<string>();

            var parts = s.Split('\n');
            // Preserve blank lines.
            return parts.Select(x => x ?? "").ToList();
        }

        private static int ClampInt(int v, int min, int max)
        {
            if (v < min) return min;
            if (v > max) return max;
            return v;
        }

        private static double ClampDouble(double v, double min, double max)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return min;
            if (v < min) return min;
            if (v > max) return max;
            return v;
        }
    }
}


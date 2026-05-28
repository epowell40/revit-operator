using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ExportDwgHandler : IRequestHandler
    {
        public sealed class Selector
        {
            public string? query { get; set; }
            public bool? exact { get; set; }
            public int? max { get; set; }
            public List<string>? sheetNumberPrefixes { get; set; }
            public List<string>? nameIncludes { get; set; }
        }

        public sealed class Params
        {
            public List<long>? viewIds { get; set; }
            public Selector? selector { get; set; } // sheet selector (ViewSheet ids as view ids)

            public string? outputFolder { get; set; }
            public string? baseFileName { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var dryRun = p.dryRun ?? false;
            var folder = WorkspacePaths.ResolveDirectoryUnderWorkspace(p.outputFolder, "artifacts", "dwg");

            var viewIds = ResolveViewIds(doc, p);
            if (viewIds.Count == 0) throw new InvalidOperationException("export-dwg: no views/sheets selected.");

            var baseName = (p.baseFileName ?? $"DWG_{DateTime.Now:yyyyMMddHHmmss}").Trim();
            if (string.IsNullOrWhiteSpace(baseName)) baseName = $"DWG_{DateTime.Now:yyyyMMddHHmmss}";
            baseName = SanitizeFileName(baseName);

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    outputFolder = folder,
                    baseFileName = baseName,
                    selectedCount = viewIds.Count,
                    viewIds = viewIds.Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x)).ToArray()
                });
            }

            var opts = new DWGExportOptions();
            var ok = doc.Export(folder, baseName, viewIds, opts);

            return Task.FromResult<object>(new
            {
                status = ok ? "Success" : "Failed",
                dryRun = false,
                outputFolder = folder,
                baseFileName = baseName,
                selectedCount = viewIds.Count,
                viewIds = viewIds.Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x)).ToArray()
            });
        }

        private static List<ElementId> ResolveViewIds(Document doc, Params p)
        {
            var ids = new List<ElementId>();
            if (p.viewIds != null && p.viewIds.Count > 0)
            {
                ids.AddRange(p.viewIds.Where(x => x > 0).Distinct().Select(x => RevitBridge.Common.ElementIdCompat.Create(x)));
                return ids;
            }

            if (p.selector == null) return ids;

            var q = (p.selector.query ?? "").Trim();
            var exact = p.selector.exact ?? false;
            var max = p.selector.max.HasValue && p.selector.max.Value > 0 ? Math.Min(p.selector.max.Value, 2000) : 200;
            var prefixes = (p.selector.sheetNumberPrefixes ?? new List<string>()).Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).ToList();
            var includes = (p.selector.nameIncludes ?? new List<string>()).Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).ToList();

            var sheets = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .Where(s => s != null && !s.IsPlaceholder)
                .ToList();

            IEnumerable<ViewSheet> filtered = sheets;
            if (prefixes.Count > 0)
                filtered = filtered.Where(vs => prefixes.Any(pf => (vs.SheetNumber ?? "").StartsWith(pf, StringComparison.OrdinalIgnoreCase)));
            if (includes.Count > 0)
                filtered = filtered.Where(vs => includes.Any(t => (vs.Name ?? "").IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0));
            if (!string.IsNullOrWhiteSpace(q))
            {
                filtered = filtered.Where(vs =>
                {
                    var sn = (vs.SheetNumber ?? "").Trim();
                    var name = (vs.Name ?? "").Trim();
                    if (exact)
                        return sn.Equals(q, StringComparison.OrdinalIgnoreCase) || name.Equals(q, StringComparison.OrdinalIgnoreCase);
                    return sn.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0;
                });
            }

            foreach (var vs in filtered.OrderBy(v => v.SheetNumber, StringComparer.OrdinalIgnoreCase).ThenBy(v => v.Name, StringComparer.OrdinalIgnoreCase))
            {
                if (ids.Count >= max) break;
                ids.Add(vs.Id);
            }

            return ids;
        }

        private static string SanitizeFileName(string name)
        {
            var s = (name ?? "").Trim();
            if (s.Length == 0) return "DWG";
            foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            s = s.Replace(Path.DirectorySeparatorChar, '_').Replace(Path.AltDirectorySeparatorChar, '_');
            s = Path.GetFileName(s);
            if (s.Length == 0) s = "DWG";
            if (s.Length > 180) s = s.Substring(0, 180).Trim();
            return s;
        }
    }
}


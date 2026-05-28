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
    public sealed class ExportImagesBatchHandler : IRequestHandler
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

            public int? imageSize { get; set; } // pixels
            public string? outputFolder { get; set; } // under Workspace
            public string? fileNameTemplate { get; set; } // e.g. "{sheetNumber}_{sheetName}" or "{viewId}_{viewName}"
            public bool? dryRun { get; set; }
        }

        private sealed class SelectedView
        {
            public ElementId ViewId { get; set; } = ElementId.InvalidElementId;
            public string SheetNumber { get; set; } = "";
            public string Name { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var dryRun = p.dryRun ?? false;
            var size = p.imageSize.HasValue && p.imageSize.Value > 0 ? Math.Min(Math.Max(p.imageSize.Value, 200), 8000) : 2048;
            var folder = WorkspacePaths.ResolveDirectoryUnderWorkspace(p.outputFolder, "artifacts", "captures");

            var views = ResolveViews(doc, p);
            if (views.Count == 0) throw new InvalidOperationException("export-images: no views/sheets selected.");

            var template = (p.fileNameTemplate ?? "{sheetNumber}_{sheetName}").Trim();
            if (string.IsNullOrWhiteSpace(template)) template = "{sheetNumber}_{sheetName}";

            var plan = views.Select(v => new
            {
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(v.ViewId),
                sheetNumber = string.IsNullOrWhiteSpace(v.SheetNumber) ? null : v.SheetNumber,
                name = v.Name,
                outputBase = Path.Combine(folder, SanitizeFileName(ApplyTemplate(template, v)))
            }).ToList();

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    outputFolder = folder,
                    imageSize = size,
                    selectedCount = views.Count,
                    plan
                });
            }

            var outputs = new List<object>(capacity: Math.Min(views.Count, 2000));
            foreach (var v in views)
            {
                var basePath = Path.Combine(folder, SanitizeFileName(ApplyTemplate(template, v)));
                var options = new ImageExportOptions
                {
                    ZoomType = ZoomFitType.FitToPage,
                    PixelSize = size,
                    FilePath = basePath,
                    FitDirection = FitDirectionType.Horizontal,
                    ExportRange = ExportRange.SetOfViews
                };
                options.SetViewsAndSheets(new List<ElementId> { v.ViewId });

                doc.ExportImage(options);

                var actual = basePath + ".png";
                if (!File.Exists(actual)) actual = basePath + ".jpg";
                outputs.Add(new
                {
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(v.ViewId),
                    sheetNumber = string.IsNullOrWhiteSpace(v.SheetNumber) ? null : v.SheetNumber,
                    name = v.Name,
                    path = actual
                });
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                outputFolder = folder,
                imageSize = size,
                selectedCount = views.Count,
                outputs
            });
        }

        private static List<SelectedView> ResolveViews(Document doc, Params p)
        {
            var ids = new List<ElementId>();
            if (p.viewIds != null && p.viewIds.Count > 0)
            {
                ids.AddRange(p.viewIds.Where(x => x > 0).Distinct().Select(x => RevitBridge.Common.ElementIdCompat.Create(x)));
            }
            else if (p.selector != null)
            {
                ids.AddRange(ResolveSheetIds(doc, p.selector));
            }

            var outList = new List<SelectedView>();
            foreach (var id in ids)
            {
                var el = doc.GetElement(id);
                if (el is ViewSheet vs && !vs.IsPlaceholder)
                {
                    outList.Add(new SelectedView { ViewId = vs.Id, SheetNumber = vs.SheetNumber ?? "", Name = vs.Name ?? "" });
                }
                else if (el is View v)
                {
                    outList.Add(new SelectedView { ViewId = v.Id, SheetNumber = "", Name = v.Name ?? "" });
                }
            }

            // Keep stable ordering for deterministic outputs.
            return outList
                .OrderBy(x => x.SheetNumber ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(x => x.Name ?? "", StringComparer.OrdinalIgnoreCase)
                .Take(2000)
                .ToList();
        }

        private static List<ElementId> ResolveSheetIds(Document doc, Selector selector)
        {
            var q = (selector?.query ?? "").Trim();
            var exact = selector?.exact ?? false;
            var max = selector?.max.HasValue == true && selector.max.Value > 0 ? Math.Min(selector.max.Value, 2000) : 200;
            var prefixes = (selector?.sheetNumberPrefixes ?? new List<string>()).Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).ToList();
            var includes = (selector?.nameIncludes ?? new List<string>()).Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).ToList();

            var sheets = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .Where(s => s != null && !s.IsPlaceholder)
                .ToList();

            IEnumerable<ViewSheet> filtered = sheets;
            if (prefixes.Count > 0)
                filtered = filtered.Where(vs => prefixes.Any(p => (vs.SheetNumber ?? "").StartsWith(p, StringComparison.OrdinalIgnoreCase)));
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

            var outIds = new List<ElementId>();
            foreach (var vs in filtered.OrderBy(v => v.SheetNumber, StringComparer.OrdinalIgnoreCase).ThenBy(v => v.Name, StringComparer.OrdinalIgnoreCase))
            {
                if (outIds.Count >= max) break;
                outIds.Add(vs.Id);
            }
            return outIds;
        }

        private static string ApplyTemplate(string template, SelectedView v)
        {
            var t = (template ?? "{sheetNumber}_{sheetName}").Trim();
            t = t.Replace("{sheetNumber}", v.SheetNumber ?? "");
            t = t.Replace("{sheetName}", v.Name ?? "");
            t = t.Replace("{viewName}", v.Name ?? "");
            t = t.Replace("{viewId}", RevitBridge.Common.ElementIdCompat.GetValue(v.ViewId).ToString());
            t = t.Replace("{yyyyMMdd}", DateTime.Now.ToString("yyyyMMdd"));
            return t;
        }

        private static string SanitizeFileName(string name)
        {
            var s = (name ?? "").Trim();
            if (s.Length == 0) s = "Export";
            foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            s = s.Replace(Path.DirectorySeparatorChar, '_').Replace(Path.AltDirectorySeparatorChar, '_');
            s = Path.GetFileName(s);
            if (s.Length == 0) s = "Export";
            if (s.Length > 180) s = s.Substring(0, 180).Trim();
            return s;
        }
    }
}


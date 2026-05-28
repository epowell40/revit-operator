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
    public sealed class TransferViewTemplatesHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? action { get; set; } // list_source | import
            public string? sourcePath { get; set; }
            public string[]? templateNames { get; set; } // optional filter
            public bool? exact { get; set; } // default true when filtering
            public bool? include3D { get; set; } // default true
            public bool? includeSchedules { get; set; } // default true
            public bool? dryRun { get; set; } // import only
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var action = NormalizeAction(p.action);
            var targetDoc = app.ActiveUIDocument?.Document;
            if (targetDoc == null) throw new InvalidOperationException("No active Revit document.");

            var sourcePath = ResolveSourcePath(p.sourcePath);
            if (!File.Exists(sourcePath))
                throw new FileNotFoundException($"Source model not found: {sourcePath}");

            Document? sourceDoc = null;
            try
            {
                sourceDoc = app.Application.OpenDocumentFile(sourcePath);
                return action switch
                {
                    "list_source" => Task.FromResult<object>(ListSourceTemplates(sourceDoc, p)),
                    "import" => Task.FromResult<object>(ImportTemplates(sourceDoc, targetDoc, p)),
                    _ => throw new InvalidOperationException("transfer-view-templates.action must be list_source or import.")
                };
            }
            finally
            {
                try
                {
                    sourceDoc?.Close(false);
                }
                catch
                {
                    // no-op
                }
            }
        }

        private static object ListSourceTemplates(Document sourceDoc, Params p)
        {
            var include3D = p.include3D ?? true;
            var includeSchedules = p.includeSchedules ?? true;
            var exact = p.exact ?? true;
            var wanted = NormalizeNameSet(p.templateNames);

            var templates = GetTemplateViews(sourceDoc, include3D, includeSchedules)
                .Where(x => wanted.Count == 0 || NameMatches(x.Name, wanted, exact))
                .OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
                .Select(x => new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(x.Id),
                    name = x.Name,
                    viewType = x.ViewType.ToString()
                })
                .ToList();

            return new
            {
                status = "Ok",
                action = "list_source",
                source = new { title = sourceDoc.Title, path = sourceDoc.PathName },
                count = templates.Count,
                templates
            };
        }

        private static object ImportTemplates(Document sourceDoc, Document targetDoc, Params p)
        {
            var include3D = p.include3D ?? true;
            var includeSchedules = p.includeSchedules ?? true;
            var exact = p.exact ?? true;
            var dryRun = p.dryRun ?? false;
            var wanted = NormalizeNameSet(p.templateNames);

            var sourceTemplates = GetTemplateViews(sourceDoc, include3D, includeSchedules)
                .Where(x => wanted.Count == 0 || NameMatches(x.Name, wanted, exact))
                .ToList();

            var existingByName = GetTemplateViews(targetDoc, include3D: true, includeSchedules: true)
                .GroupBy(x => (x.Name ?? "").Trim(), StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

            var toCopy = new List<View>();
            var skippedExisting = new List<object>();
            foreach (var src in sourceTemplates)
            {
                var key = (src.Name ?? "").Trim();
                if (existingByName.ContainsKey(key))
                {
                    skippedExisting.Add(new { name = src.Name, reason = "AlreadyExists" });
                    continue;
                }
                toCopy.Add(src);
            }

            var plan = new
            {
                source = new { title = sourceDoc.Title, path = sourceDoc.PathName },
                selectedCount = sourceTemplates.Count,
                copyCount = toCopy.Count,
                skipCount = skippedExisting.Count,
                skippedExisting
            };

            if (dryRun)
            {
                return new
                {
                    status = "Dry Run",
                    action = "import",
                    dryRun = true,
                    plan
                };
            }

            if (toCopy.Count == 0)
            {
                return new
                {
                    status = "NoOp",
                    action = "import",
                    copied = 0,
                    skipped = skippedExisting
                };
            }

            var copiedIds = new List<long>();
            var failures = new List<object>();
            using (var tx = new Transaction(targetDoc, "Transfer View Templates"))
            {
                tx.Start();
                try
                {
                    var ids = toCopy.Select(x => x.Id).Cast<ElementId>().ToList();
                    var copied = ElementTransformUtils.CopyElements(
                        sourceDoc,
                        ids,
                        targetDoc,
                        Transform.Identity,
                        new CopyPasteOptions());

                    copiedIds.AddRange(copied.Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x)));
                    tx.Commit();
                }
                catch (Exception ex)
                {
                    tx.RollBack();
                    failures.Add(new { message = ex.Message });
                }
            }

            return new
            {
                status = failures.Count > 0 ? "Partial" : "Success",
                action = "import",
                copied = copiedIds.Count,
                copiedIds,
                skipped = skippedExisting,
                failures
            };
        }

        private static List<View> GetTemplateViews(Document doc, bool include3D, bool includeSchedules)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => v != null && v.IsTemplate)
                .Where(v => include3D || v.ViewType != ViewType.ThreeD)
                .Where(v => includeSchedules || v.ViewType != ViewType.Schedule)
                .ToList();
        }

        private static HashSet<string> NormalizeNameSet(string[]? names)
        {
            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (names == null) return set;
            foreach (var n in names)
            {
                var t = (n ?? "").Trim();
                if (t.Length == 0) continue;
                set.Add(t);
            }
            return set;
        }

        private static bool NameMatches(string? name, HashSet<string> wanted, bool exact)
        {
            var n = (name ?? "").Trim();
            if (exact) return wanted.Contains(n);

            foreach (var w in wanted)
            {
                if (n.IndexOf(w, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }
            return false;
        }

        private static string NormalizeAction(string? action)
        {
            var value = (action ?? "import").Trim().ToLowerInvariant();
            return value switch
            {
                "list" => "list_source",
                "list_source" => "list_source",
                "import" => "import",
                _ => value
            };
        }

        private static string ResolveSourcePath(string? sourcePath)
        {
            var raw = (sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(raw))
                throw new InvalidOperationException("transfer-view-templates.sourcePath is required.");

            if (Path.IsPathRooted(raw))
            {
                return Path.GetFullPath(raw);
            }

            // Workspace-relative sources are supported for reproducible automation.
            return WorkspacePaths.ResolveFileUnderWorkspace(raw);
        }
    }
}

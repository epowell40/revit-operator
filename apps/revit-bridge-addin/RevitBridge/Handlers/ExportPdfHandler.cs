using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public class ExportPdfHandler : IRequestHandler
    {
        public sealed class Selector
        {
            public string? query { get; set; }
            public bool? exact { get; set; }
            public int? max { get; set; }
            public List<string>? sheetNumberPrefixes { get; set; }
            public List<string>? nameIncludes { get; set; }
            public string? semanticGroup { get; set; }
            public List<string>? semanticGroups { get; set; }
        }

        public class Params
        {
            // Back-compat: viewIds + fileName.
            public List<long>? viewIds { get; set; }
            public string? fileName { get; set; }

            // v2 additions
            public Selector? selector { get; set; }

            // Convenience selector inputs (avoid needing nested selector objects).
            // If provided, these are merged into selector (prefix takes precedence over query).
            public string? sheetQuery { get; set; } // e.g. "M1" or "M1*"
            public string? sheetNumberPrefix { get; set; } // e.g. "M1"
            public string? sheetGroup { get; set; } // e.g. "power", "lighting", "mechanical", "cover"
            public string? semanticSheetGroup { get; set; } // alias for sheetGroup
            public bool? all { get; set; } // if true, cap to a safe max (default 500)
            public int? max { get; set; } // legacy alias for selector.max when selector is not provided
            public string? printSetName { get; set; }
            public bool? printSetExact { get; set; }

            public bool? combine { get; set; } // true => bound; false => individual
            public string? outputFolder { get; set; }
            public string? baseFileName { get; set; }
            public string? perSheetFileNameTemplate { get; set; }
            public string? colorMode { get; set; } // Color|Grayscale|BlackLine (best-effort)
            public bool? cleanupDefaultIndividualOutputs { get; set; }
            public bool? dryRun { get; set; }
            public bool? preflight { get; set; } // alias for dryRun
            public bool? preflightOnly { get; set; } // alias for dryRun
        }

        internal sealed class ResolvedView
        {
            public ElementId ViewId { get; set; } = ElementId.InvalidElementId;
            public string SheetNumber { get; set; } = "";
            public string Name { get; set; } = "";
        }

        private sealed class FileVerification
        {
            public string path { get; set; } = "";
            public bool exists { get; set; }
            public bool isFile { get; set; }
            public long sizeBytes { get; set; }
            public string? lastWriteTimeUtc { get; set; }
            public bool ok { get; set; }
            public string? error { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var dryRun = p.dryRun ?? p.preflightOnly ?? p.preflight ?? false;
            var combine = p.combine ?? true;

            var folder = ResolvePdfOutputFolder(p.outputFolder);

            var views = ResolveViews(doc, p, out var selectionMeta);
            if (views.Count == 0) throw new InvalidOperationException("No views/sheets selected for PDF export.");

            var baseName = (p.baseFileName ?? p.fileName ?? "").Trim();
            if (string.IsNullOrWhiteSpace(baseName)) baseName = $"Print_{DateTime.Now:yyyyMMddHHmmss}";
            baseName = SanitizeFileName(baseName);

            var perTemplate = (p.perSheetFileNameTemplate ?? "{sheetNumber}_{sheetName}").Trim();
            if (string.IsNullOrWhiteSpace(perTemplate)) perTemplate = "{sheetNumber}_{sheetName}";

            var colorMode = NormalizePdfColorMode(p.colorMode);
            var cleanupDefaultIndividualOutputs = p.cleanupDefaultIndividualOutputs ?? true;

            var planned = BuildPlan(folder, combine, baseName, perTemplate, views);
            var preflight = BuildPreflight(folder, combine, baseName, perTemplate, views, selectionMeta, planned);
            var selectedSheets = BuildSelectedSheets(views);
            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    preflightOnly = true,
                    combine,
                    outputFolder = folder,
                    colorMode = string.IsNullOrWhiteSpace(colorMode) ? null : colorMode,
                    cleanupDefaultIndividualOutputs,
                    selectedCount = views.Count,
                    selectedSheets,
                    selection = selectionMeta,
                    preflight,
                    plan = planned
                });
            }

            if (combine)
            {
                var fileBase = StripPdfExtension(baseName);
                var outName = EnsurePdfExtension(fileBase);
                var options = new PDFExportOptions
                {
                    Combine = true,
                    FileName = fileBase
                };
                var colorModeResult = TrySetPdfColorMode(options, colorMode);

                doc.Export(folder, views.Select(v => v.ViewId).ToList(), options);
                var outPath = Path.Combine(folder, outName);
                var verification = BuildFileVerification(outPath);

                return Task.FromResult<object>(new
                {
                    status = verification.ok ? "Success" : "ExportUnverified",
                    dryRun = false,
                    combine = true,
                    outputFolder = folder,
                    path = outPath,
                    outputs = new[] { outPath },
                    verification,
                    colorMode = string.IsNullOrWhiteSpace(colorMode) ? null : colorMode,
                    colorModeResult,
                    selectedCount = views.Count,
                    selectedSheets,
                    preflight,
                    selection = selectionMeta
                });
            }

            var outputs = new List<string>(capacity: Math.Min(views.Count, 2000));
            var cleanedUnexpectedOutputs = new List<object>();
            foreach (var v in views)
            {
                var fileBase = StripPdfExtension(SanitizeFileName(ApplyPerSheetTemplate(perTemplate, v)));
                var outName = EnsurePdfExtension(fileBase);
                var expectedPath = Path.Combine(folder, outName);
                var defaultFileBase = StripPdfExtension(SanitizeFileName(ApplyPerSheetTemplate("{sheetNumber}_{sheetName}", v)));
                var defaultPath = Path.Combine(folder, EnsurePdfExtension(defaultFileBase));
                var defaultBefore = SnapshotFile(defaultPath);

                var options = new PDFExportOptions
                {
                    Combine = true, // one sheet/view per file
                    FileName = fileBase
                };
                TrySetPdfColorMode(options, colorMode);

                doc.Export(folder, new List<ElementId> { v.ViewId }, options);
                outputs.Add(expectedPath);
                if (cleanupDefaultIndividualOutputs)
                {
                    var cleaned = TryCleanupDefaultIndividualOutput(expectedPath, defaultPath, defaultBefore);
                    if (cleaned != null) cleanedUnexpectedOutputs.Add(cleaned);
                }
            }
            var verifications = outputs.Select(BuildFileVerification).ToArray();
            var verifiedCount = verifications.Count(x => x.ok);

            return Task.FromResult<object>(new
            {
                status = verifiedCount == outputs.Count ? "Success" : "ExportUnverified",
                dryRun = false,
                combine = false,
                outputFolder = folder,
                paths = outputs,
                outputs,
                verifiedCount,
                verification = verifications,
                cleanedUnexpectedOutputs = cleanedUnexpectedOutputs.ToArray(),
                colorMode = string.IsNullOrWhiteSpace(colorMode) ? null : colorMode,
                selectedCount = views.Count,
                selectedSheets,
                preflight,
                selection = selectionMeta
            });
        }

        internal static List<ResolvedView> ResolveSelectedViews(Document doc, Params p, out object selectionMeta)
        {
            return ResolveViews(doc, p, out selectionMeta);
        }

        internal static object BuildSelectionPlan(string folder, bool combine, string baseName, string perTemplate, List<ResolvedView> views)
        {
            return BuildPlan(folder, combine, baseName, perTemplate, views);
        }

        private static List<ResolvedView> ResolveViews(Document doc, Params p, out object selectionMeta)
        {
            selectionMeta = new { };

            var ids = new List<long>();
            var preserveInputOrder = false;
            if (p.viewIds != null && p.viewIds.Count > 0)
            {
                ids.AddRange(p.viewIds.Where(x => x > 0));
                selectionMeta = new { kind = "explicit_viewIds", count = ids.Count };
                preserveInputOrder = true;
            }
            else if (!string.IsNullOrWhiteSpace(p.printSetName))
            {
                var printSetName = (p.printSetName ?? "").Trim();
                var exact = p.printSetExact ?? true;
                var printSet = ResolvePrintSet(doc, printSetName, exact);
                if (printSet == null)
                {
                    throw new InvalidOperationException($"Print set '{printSetName}' was not found.");
                }

                var sheets = PrintSetsHandler.GetSheetsInSet(printSet);
                ids.AddRange(sheets.Select(s => RevitBridge.Common.ElementIdCompat.GetValue(s.Id)));
                selectionMeta = new
                {
                    kind = "print_set",
                    name = printSet.Name,
                    exact,
                    count = ids.Count
                };
            }
            else
            {
                var effectiveSelector = p.selector;

                // Merge convenience fields into selector (prefix takes precedence; supports "M1*").
                var sheetQuery = (p.sheetQuery ?? "").Trim();
                var prefix = (p.sheetNumberPrefix ?? "").Trim();
                var semanticGroups = NormalizeSemanticGroups(new[] { p.sheetGroup, p.semanticSheetGroup });

                var queryGroup = NormalizeSemanticGroup(sheetQuery);
                if (semanticGroups.Count == 0 && !string.IsNullOrWhiteSpace(queryGroup))
                {
                    semanticGroups.Add(queryGroup);
                    sheetQuery = "";
                }

                if (string.IsNullOrWhiteSpace(prefix) && !string.IsNullOrWhiteSpace(sheetQuery))
                {
                    // Interpret sheetQuery as a sheet number prefix by default (most common workflow).
                    prefix = sheetQuery.EndsWith("*", StringComparison.Ordinal) ? sheetQuery.TrimEnd('*').Trim() : sheetQuery;
                }

                if (effectiveSelector == null && (!string.IsNullOrWhiteSpace(prefix) || !string.IsNullOrWhiteSpace(sheetQuery) || semanticGroups.Count > 0))
                {
                    effectiveSelector = new Selector();
                }

                if (effectiveSelector != null)
                {
                    semanticGroups.AddRange(NormalizeSemanticGroups(new[] { effectiveSelector.semanticGroup }));
                    semanticGroups.AddRange(NormalizeSemanticGroups(effectiveSelector.semanticGroups ?? new List<string>()));
                    semanticGroups = semanticGroups.Distinct(StringComparer.OrdinalIgnoreCase).ToList();

                    if (!string.IsNullOrWhiteSpace(prefix))
                    {
                        if (effectiveSelector.sheetNumberPrefixes == null) effectiveSelector.sheetNumberPrefixes = new List<string>();
                        if (!effectiveSelector.sheetNumberPrefixes.Any(x => string.Equals((x ?? "").Trim(), prefix, StringComparison.OrdinalIgnoreCase)))
                        {
                            effectiveSelector.sheetNumberPrefixes.Add(prefix);
                        }
                    }
                    else if (!string.IsNullOrWhiteSpace(sheetQuery) && string.IsNullOrWhiteSpace(effectiveSelector.query))
                    {
                        effectiveSelector.query = sheetQuery;
                    }

                    if (!effectiveSelector.max.HasValue && p.max.HasValue && p.max.Value > 0)
                    {
                        effectiveSelector.max = Math.Min(p.max.Value, 2000);
                    }

                    // An explicit caller bound must win over the broad `all` convenience
                    // default. Applying `all` first used to replace max:3 with max:500,
                    // which could export an entire discipline when only a bounded sample
                    // was requested.
                    if ((p.all ?? false) && !effectiveSelector.max.HasValue)
                    {
                        effectiveSelector.max = 500;
                    }

                    if (semanticGroups.Count > 0)
                    {
                        effectiveSelector.semanticGroups = semanticGroups;
                    }

                    var selected = SelectSheetIds(doc, effectiveSelector);
                    ids.AddRange(selected.Select(id => RevitBridge.Common.ElementIdCompat.GetValue(id)));
                    selectionMeta = new
                    {
                        kind = "selector",
                        sheetNumberPrefix = string.IsNullOrWhiteSpace(prefix) ? null : prefix,
                        sheetQuery = string.IsNullOrWhiteSpace(sheetQuery) ? null : sheetQuery,
                        exact = effectiveSelector.exact,
                        max = effectiveSelector.max,
                        sheetNumberPrefixes = effectiveSelector.sheetNumberPrefixes,
                        nameIncludes = effectiveSelector.nameIncludes,
                        semanticGroups = semanticGroups.Count == 0 ? null : semanticGroups.ToArray(),
                        count = ids.Count
                    };
                }
                else
                {
                    var activeView = doc.ActiveView;
                    if (activeView != null) ids.Add(RevitBridge.Common.ElementIdCompat.GetValue(activeView.Id));
                    selectionMeta = new { kind = "active_view_fallback", count = ids.Count };
                }
            }

            // De-dupe while preserving the chosen ordering.
            var orderedDistinct = new List<long>(capacity: ids.Count);
            var seenIds = new HashSet<long>();
            foreach (var id in ids)
            {
                if (id <= 0) continue;
                if (seenIds.Add(id)) orderedDistinct.Add(id);
            }

            var resolved = new List<ResolvedView>(capacity: Math.Min(ids.Count, 256));
            foreach (var id in orderedDistinct)
            {
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e is View v)
                {
                    var sn = "";
                    var name = v.Name ?? "";
                    if (v is ViewSheet vs)
                    {
                        sn = vs.SheetNumber ?? "";
                        name = vs.Name ?? name;
                    }
                    resolved.Add(new ResolvedView { ViewId = v.Id, SheetNumber = sn, Name = name });
                }
            }

            if (preserveInputOrder) return resolved;

            return resolved
                .OrderBy(v => v.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .ThenBy(v => v.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static List<ElementId> SelectSheetIds(Document doc, Selector s)
        {
            var max = s.max.HasValue && s.max.Value > 0 ? Math.Min(s.max.Value, 2000) : 500;
            var q = (s.query ?? "").Trim();
            var exact = s.exact ?? false;

            var prefixes = (s.sheetNumberPrefixes ?? new List<string>()).Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).ToList();
            var includes = (s.nameIncludes ?? new List<string>()).Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).ToList();
            var semanticGroups = NormalizeSemanticGroups(new[] { s.semanticGroup })
                .Concat(NormalizeSemanticGroups(s.semanticGroups ?? new List<string>()))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            var sheets = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .Where(vs => vs != null && !vs.IsPlaceholder)
                .ToList();

            IEnumerable<ViewSheet> filtered = sheets;
            if (prefixes.Count > 0)
                filtered = filtered.Where(vs => prefixes.Any(p => (vs.SheetNumber ?? "").StartsWith(p, StringComparison.OrdinalIgnoreCase)));
            if (includes.Count > 0)
                filtered = filtered.Where(vs => includes.Any(t => (vs.Name ?? "").IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0));
            if (semanticGroups.Count > 0)
                filtered = filtered.Where(vs => semanticGroups.Any(g => MatchesSemanticSheetGroup(vs, g)));
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

            var ids = new List<ElementId>();
            foreach (var vs in filtered.OrderBy(v => v.SheetNumber, StringComparer.OrdinalIgnoreCase).ThenBy(v => v.Name, StringComparer.OrdinalIgnoreCase))
            {
                if (ids.Count >= max) break;
                ids.Add(vs.Id);
            }
            return ids;
        }

        private static List<string> NormalizeSemanticGroups(IEnumerable<string?> rawGroups)
        {
            var groups = new List<string>();
            foreach (var raw in rawGroups)
            {
                var normalized = NormalizeSemanticGroup(raw);
                if (!string.IsNullOrWhiteSpace(normalized)) groups.Add(normalized);
            }
            return groups;
        }

        private static string NormalizeSemanticGroup(string? raw)
        {
            var s = (raw ?? "").Trim().ToLowerInvariant();
            if (s.Length == 0) return "";
            s = s.Replace("_", " ").Replace("-", " ");
            if (s.EndsWith(" sheets", StringComparison.Ordinal)) s = s.Substring(0, s.Length - " sheets".Length).Trim();
            if (s.EndsWith(" sheet", StringComparison.Ordinal)) s = s.Substring(0, s.Length - " sheet".Length).Trim();
            if (s.EndsWith(" plans", StringComparison.Ordinal)) s = s.Substring(0, s.Length - " plans".Length).Trim();
            if (s.EndsWith(" plan", StringComparison.Ordinal)) s = s.Substring(0, s.Length - " plan".Length).Trim();

            if (s == "power" || s == "receptacle" || s == "receptacles") return "power";
            if (s == "lighting" || s == "light" || s == "lights") return "lighting";
            if (s == "mechanical" || s == "mech" || s == "hvac") return "mechanical";
            if (s == "electrical" || s == "elec") return "electrical";
            if (s == "plumbing" || s == "plumb") return "plumbing";
            if (s == "cover" || s == "title" || s == "titleblock" || s == "title block") return "cover";
            if (s == "fire alarm" || s == "firealarm" || s == "fa") return "fire_alarm";
            return "";
        }

        private static bool MatchesSemanticSheetGroup(ViewSheet sheet, string group)
        {
            var number = (sheet.SheetNumber ?? "").Trim();
            var name = (sheet.Name ?? "").Trim();
            switch (group)
            {
                case "power":
                    return HasAnyPrefix(number, "E3", "EP", "PWR") || HasAnyWord(name, "power", "receptacle", "receptacles");
                case "lighting":
                    return HasAnyPrefix(number, "E2", "EL", "LGT") || HasAnyWord(name, "lighting", "light");
                case "mechanical":
                    return HasAnyPrefix(number, "M") || HasAnyWord(name, "mechanical", "hvac");
                case "electrical":
                    return HasAnyPrefix(number, "E") || HasAnyWord(name, "electrical", "power", "lighting");
                case "plumbing":
                    return HasAnyPrefix(number, "P") || HasAnyWord(name, "plumbing", "plumb");
                case "cover":
                    return HasAnyPrefix(number, "G0", "A0", "T0") || HasAnyWord(name, "cover", "title", "index");
                case "fire_alarm":
                    return HasAnyPrefix(number, "FA", "E4") || HasAnyWord(name, "fire alarm", "life safety");
                default:
                    return false;
            }
        }

        private static bool HasAnyPrefix(string value, params string[] prefixes)
        {
            return prefixes.Any(prefix => value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
        }

        private static bool HasAnyWord(string value, params string[] words)
        {
            return words.Any(word => value.IndexOf(word, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        private static ViewSheetSet? ResolvePrintSet(Document doc, string printSetName, bool exact)
        {
            var wanted = (printSetName ?? "").Trim();
            if (wanted.Length == 0) return null;

            if (exact)
            {
                return PrintSetsHandler.FindByName(doc, wanted);
            }

            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheetSet))
                .Cast<ViewSheetSet>()
                .Where(s => !string.IsNullOrWhiteSpace(s.Name))
                .Where(s => s.Name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0)
                .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        private static object BuildPlan(string folder, bool combine, string baseName, string perTemplate, List<ResolvedView> views)
        {
            if (combine)
            {
                var outName = EnsurePdfExtension(StripPdfExtension(baseName));
                return new
                {
                    output = Path.Combine(folder, outName),
                    viewIds = views.Select(v => RevitBridge.Common.ElementIdCompat.GetValue(v.ViewId)).ToArray(),
                    sheets = views.Select(v => new { viewId = RevitBridge.Common.ElementIdCompat.GetValue(v.ViewId), sheetNumber = v.SheetNumber, name = v.Name }).ToArray()
                };
            }

            return views.Select(v =>
            {
                var baseFile = SanitizeFileName(ApplyPerSheetTemplate(perTemplate, v));
                var outName = EnsurePdfExtension(StripPdfExtension(baseFile));
                return new
                {
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(v.ViewId),
                    sheetNumber = v.SheetNumber,
                    name = v.Name,
                    output = Path.Combine(folder, outName)
                };
            }).ToArray();
        }

        private static object BuildPreflight(string folder, bool combine, string baseName, string perTemplate, List<ResolvedView> views, object selectionMeta, object planned)
        {
            var outputs = combine
                ? new[] { Path.Combine(folder, EnsurePdfExtension(StripPdfExtension(baseName))) }
                : views.Select(v => Path.Combine(folder, EnsurePdfExtension(StripPdfExtension(SanitizeFileName(ApplyPerSheetTemplate(perTemplate, v)))))).ToArray();
            var sheetList = FormatSheetList(views);
            var outputSummary = combine
                ? $"combined PDF to {outputs.FirstOrDefault() ?? folder}"
                : $"{outputs.Length} separate PDF file(s) under {folder}";
            return new
            {
                summary = $"Found {views.Count} selected view/sheet(s): {sheetList}. Output will be {outputSummary}.",
                selectedCount = views.Count,
                selectedSheets = BuildSelectedSheets(views),
                selection = selectionMeta,
                combine,
                outputFolder = folder,
                outputs,
                plan = planned
            };
        }

        private static object[] BuildSelectedSheets(List<ResolvedView> views)
        {
            return views.Select(v => new
            {
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(v.ViewId),
                sheetNumber = v.SheetNumber,
                name = v.Name,
                display = string.IsNullOrWhiteSpace(v.SheetNumber) ? v.Name : $"{v.SheetNumber} - {v.Name}"
            }).Cast<object>().ToArray();
        }

        private static string FormatSheetList(List<ResolvedView> views)
        {
            var labels = views
                .Take(12)
                .Select(v => string.IsNullOrWhiteSpace(v.SheetNumber) ? v.Name : v.SheetNumber)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .ToList();
            var s = labels.Count == 0 ? "(unnamed views)" : string.Join(", ", labels);
            if (views.Count > labels.Count) s += $", +{views.Count - labels.Count} more";
            return s;
        }

        private static string ApplyPerSheetTemplate(string template, ResolvedView v)
        {
            var t = template ?? "{sheetNumber}_{sheetName}";
            t = t.Replace("{sheetNumber}", v.SheetNumber ?? "");
            t = t.Replace("{sheetName}", v.Name ?? "");
            t = t.Replace("{viewId}", RevitBridge.Common.ElementIdCompat.GetValue(v.ViewId).ToString());
            t = t.Replace("{yyyyMMdd}", DateTime.Now.ToString("yyyyMMdd"));
            return t;
        }

        private static string EnsurePdfExtension(string fileNameOrBase)
        {
            var s = (fileNameOrBase ?? "").Trim();
            if (s.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)) return s;
            return s + ".pdf";
        }

        private static string StripPdfExtension(string fileNameOrBase)
        {
            var s = (fileNameOrBase ?? "").Trim();
            if (s.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
                return s.Substring(0, s.Length - 4);
            return s;
        }

        private static string SanitizeFileName(string name)
        {
            var s = (name ?? "").Trim();
            if (s.Length == 0) return "Print";
            foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            s = s.Replace(Path.DirectorySeparatorChar, '_').Replace(Path.AltDirectorySeparatorChar, '_');
            s = Path.GetFileName(s);
            if (s.Length == 0) s = "Print";
            if (s.Length > 180) s = s.Substring(0, 180).Trim();
            return s;
        }

        private static string ResolvePdfOutputFolder(string? userProvidedDir)
        {
            if (string.IsNullOrWhiteSpace(userProvidedDir))
                return WorkspacePaths.ResolveDirectoryUnderWorkspace(null, "artifacts", "prints");

            var candidate = userProvidedDir.Trim();
            if (!Path.IsPathRooted(candidate))
                return WorkspacePaths.ResolveDirectoryUnderWorkspace(candidate, "artifacts", "prints");

            candidate = Path.GetFullPath(candidate);
            var workspace = Path.GetFullPath(WorkspacePaths.GetWorkspaceRoot());
            if (IsSameOrUnder(candidate, workspace))
            {
                Directory.CreateDirectory(candidate);
                return candidate;
            }

            var allowedRoots = new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads")
            }
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(Path.GetFullPath)
                .ToArray();

            if (!allowedRoots.Any(root => IsSameOrUnder(candidate, root)))
            {
                throw new UnauthorizedAccessException("PDF outputFolder must be under the RevitOperator workspace, Documents, Desktop, or Downloads.");
            }

            Directory.CreateDirectory(candidate);
            return candidate;
        }

        private static bool IsSameOrUnder(string candidate, string root)
        {
            var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var normalizedCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.Equals(normalizedCandidate, normalizedRoot, StringComparison.OrdinalIgnoreCase) ||
                   normalizedCandidate.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }

        private static FileVerification BuildFileVerification(string path)
        {
            try
            {
                var info = new FileInfo(path);
                return new FileVerification
                {
                    path = path,
                    exists = info.Exists,
                    isFile = info.Exists,
                    sizeBytes = info.Exists ? info.Length : 0,
                    lastWriteTimeUtc = info.Exists ? info.LastWriteTimeUtc.ToString("O") : null,
                    ok = info.Exists && info.Length > 0
                };
            }
            catch (Exception ex)
            {
                return new FileVerification
                {
                    path = path,
                    exists = false,
                    isFile = false,
                    sizeBytes = 0L,
                    lastWriteTimeUtc = null,
                    ok = false,
                    error = ex.Message
                };
            }
        }

        private sealed class FileSnapshot
        {
            public bool exists { get; set; }
            public long sizeBytes { get; set; }
            public DateTime lastWriteTimeUtc { get; set; }
        }

        private static FileSnapshot SnapshotFile(string path)
        {
            try
            {
                var info = new FileInfo(path);
                return new FileSnapshot
                {
                    exists = info.Exists,
                    sizeBytes = info.Exists ? info.Length : 0L,
                    lastWriteTimeUtc = info.Exists ? info.LastWriteTimeUtc : DateTime.MinValue
                };
            }
            catch
            {
                return new FileSnapshot();
            }
        }

        private static object? TryCleanupDefaultIndividualOutput(string expectedPath, string defaultPath, FileSnapshot before)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(expectedPath) || string.IsNullOrWhiteSpace(defaultPath)) return null;
                var expectedFull = Path.GetFullPath(expectedPath);
                var defaultFull = Path.GetFullPath(defaultPath);
                if (string.Equals(expectedFull, defaultFull, StringComparison.OrdinalIgnoreCase)) return null;

                var expected = new FileInfo(expectedFull);
                var candidate = new FileInfo(defaultFull);
                if (!expected.Exists || expected.Length <= 0 || !candidate.Exists || candidate.Length <= 0) return null;

                var candidateWasWrittenNow =
                    !before.exists ||
                    candidate.Length != before.sizeBytes ||
                    Math.Abs((candidate.LastWriteTimeUtc - before.lastWriteTimeUtc).TotalSeconds) > 1.0;
                var matchesExpected =
                    candidate.Length == expected.Length &&
                    Math.Abs((candidate.LastWriteTimeUtc - expected.LastWriteTimeUtc).TotalSeconds) <= 5.0;

                if (!candidateWasWrittenNow || !matchesExpected) return null;

                File.Delete(defaultFull);
                return new
                {
                    deleted = defaultFull,
                    kept = expectedFull,
                    reason = "Removed default individual PDF generated alongside requested per-sheet filename."
                };
            }
            catch (Exception ex)
            {
                return new
                {
                    attempted = defaultPath,
                    kept = expectedPath,
                    error = ex.Message
                };
            }
        }

        private sealed class ColorModeResult
        {
            public string requested { get; set; } = "";
            public string normalized { get; set; } = "";
            public List<string> appliedProperties { get; set; } = new List<string>();
        }

        private static string NormalizePdfColorMode(string? colorMode)
        {
            var cm = (colorMode ?? "").Trim();
            if (string.IsNullOrWhiteSpace(cm)) return "";
            var s = cm.Replace("_", " ").Replace("-", " ").Trim().ToLowerInvariant();
            while (s.IndexOf("  ", StringComparison.Ordinal) >= 0) s = s.Replace("  ", " ");
            if (s == "blackline" || s == "black line" || s == "black" || s == "black white" || s == "black and white" || s == "bw" || s == "b w" || s == "monochrome" || s == "mono")
                return "BlackLine";
            if (s == "grayscale" || s == "greyscale" || s == "gray" || s == "grey")
                return "Grayscale";
            if (s == "color" || s == "colour" || s == "full color" || s == "full colour")
                return "Color";
            return cm;
        }

        private static ColorModeResult TrySetPdfColorMode(PDFExportOptions options, string colorMode)
        {
            var result = new ColorModeResult { requested = colorMode ?? "", normalized = NormalizePdfColorMode(colorMode) };
            if (options == null) return result;
            var cm = result.normalized;
            if (string.IsNullOrWhiteSpace(cm)) return result;

            if (TrySetEnumLikeProperty(options, "ColorMode", cm)) result.appliedProperties.Add("ColorMode");
            if (TrySetEnumLikeProperty(options, "ExportColorMode", cm)) result.appliedProperties.Add("ExportColorMode");
            if (TrySetEnumLikeProperty(options, "ColorDepth", cm)) result.appliedProperties.Add("ColorDepth");
            return result;
        }

        private static bool TrySetEnumLikeProperty(object target, string propName, string value)
        {
            try
            {
                var prop = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                if (prop == null || !prop.CanWrite) return false;

                var t = prop.PropertyType;
                if (t == typeof(string))
                {
                    prop.SetValue(target, value);
                    return true;
                }

                if (t.IsEnum)
                {
                    var parsed = Enum.Parse(t, value, ignoreCase: true);
                    prop.SetValue(target, parsed);
                    return true;
                }
            }
            catch
            {
                // ignore
            }
            return false;
        }
    }
}

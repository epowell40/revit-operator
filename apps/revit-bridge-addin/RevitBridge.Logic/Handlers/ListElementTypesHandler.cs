using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class ListElementTypesHandler : IRequestHandler
    {
        public class Params
        {
            public string? action { get; set; } // list | rename_types | purge_unused_in_family
            public string category { get; set; } = "";
            public List<string>? categories { get; set; }
            public string nameContains { get; set; } = "";
            public string exactName { get; set; } = "";
            public string familyNameContains { get; set; } = "";
            public string? familyName { get; set; }
            public List<string>? includeParameters { get; set; }
            public int limit { get; set; } = 200;
            public bool cacheBust { get; set; }
            public int cacheMaxAgeSeconds { get; set; } = 180;
            public bool? exportCsv { get; set; }
            public string? outputFolder { get; set; }
            public string? fileName { get; set; }

            // rename_types
            public string? searchPattern { get; set; }
            public string? replaceWith { get; set; }
            public bool? regexIgnoreCase { get; set; }
            public int? maxEdits { get; set; }

            // purge_unused_in_family
            public int? maxDelete { get; set; }
            public bool? dryRun { get; set; }
        }

        private sealed class RenamePlan
        {
            public long typeId { get; set; }
            public string familyName { get; set; } = "";
            public string oldName { get; set; } = "";
            public string newName { get; set; } = "";
            public string category { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");

            p.action = (p.action ?? "list").Trim().ToLowerInvariant();
            p.category = (p.category ?? "").Trim();
            p.nameContains = (p.nameContains ?? "").Trim();
            p.exactName = (p.exactName ?? "").Trim();
            p.familyNameContains = (p.familyNameContains ?? "").Trim();
            p.familyName = (p.familyName ?? "").Trim();
            p.searchPattern = (p.searchPattern ?? "").Trim();
            p.replaceWith = p.replaceWith ?? "";

            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");

            if (p.action == "rename_types")
            {
                return Task.FromResult<object>(HandleRenameTypes(doc, p));
            }

            if (p.action == "purge_unused_in_family")
            {
                return Task.FromResult<object>(HandlePurgeUnusedInFamily(doc, p));
            }

            return Task.FromResult<object>(HandleListTypes(doc, p));
        }

        private static object HandleListTypes(Document doc, Params p)
        {
            var requestedCategories = CollectRequestedCategories(p.category, p.categories);
            if (requestedCategories.Count == 0) throw new ArgumentException("Missing required parameter: category (or categories).");

            var resolvedCategories = new List<(BuiltInCategory bic, string canonical)>();
            var unresolvedCategories = new List<object>();
            foreach (var token in requestedCategories)
            {
                if (!ElementTypeResolver.TryResolveBuiltInCategory(token, out var bic, out var canonical, out var suggestions))
                {
                    unresolvedCategories.Add(new
                    {
                        category = token,
                        suggestions = suggestions.Take(5).ToList()
                    });
                    continue;
                }
                resolvedCategories.Add((bic, canonical));
            }
            if (resolvedCategories.Count == 0)
                throw new ArgumentException("No valid categories were resolved. Use BuiltInCategory names like 'OST_Walls'.");

            var effectiveLimit = p.limit;
            if (effectiveLimit < 1) effectiveLimit = 1;
            if (effectiveLimit > 2000) effectiveLimit = 2000;

            var exportRequested = (p.exportCsv ?? false) ||
                                  !string.IsNullOrWhiteSpace(p.outputFolder) ||
                                  !string.IsNullOrWhiteSpace(p.fileName);

            var results = new List<object>();
            var csvRows = new List<(long id, string name, string familyName, string category, bool usedCache, Dictionary<string, string?>? parameters)>();

            foreach (var c in resolvedCategories)
            {
                if (results.Count >= effectiveLimit) break;
                var remaining = effectiveLimit - results.Count;
                bool usedCache;

                if (!string.IsNullOrWhiteSpace(p.exactName))
                {
                    var matches = ElementTypeResolver.SearchTypes(
                        doc,
                        c.bic,
                        p.exactName,
                        familyName: null,
                        exact: true,
                        limit: remaining,
                        cacheBust: p.cacheBust,
                        cacheMaxAgeSeconds: p.cacheMaxAgeSeconds,
                        usedCache: out usedCache
                    );

                    foreach (var m in matches.Take(remaining))
                    {
                        var type = doc.GetElement(ElementIdCompat.Create(m.Id)) as ElementType;
                        var parameters = (p.includeParameters != null && p.includeParameters.Count > 0 && p.includeParameters.Count <= 5 && type != null)
                            ? ElementTypeResolver.ExtractTypeParameters(type, p.includeParameters)
                            : null;

                        results.Add(new
                        {
                            id = m.Id,
                            name = m.Name,
                            familyName = m.FamilyName,
                            category = c.canonical,
                            usedCache,
                            parameters
                        });
                        csvRows.Add((m.Id, m.Name ?? "", m.FamilyName ?? "", c.canonical, usedCache, parameters));
                    }
                    continue;
                }

                var nameFilter = !string.IsNullOrWhiteSpace(p.nameContains) ? p.nameContains : "";
                var familyFilter = !string.IsNullOrWhiteSpace(p.familyNameContains) ? p.familyNameContains : "";

                IReadOnlyList<ElementTypeResolver.TypeEntry> entries;
                if (!string.IsNullOrWhiteSpace(nameFilter))
                {
                    entries = ElementTypeResolver.SearchTypes(
                        doc,
                        c.bic,
                        nameFilter,
                        familyName: string.IsNullOrWhiteSpace(familyFilter) ? null : familyFilter,
                        exact: false,
                        limit: remaining,
                        cacheBust: p.cacheBust,
                        cacheMaxAgeSeconds: p.cacheMaxAgeSeconds,
                        usedCache: out usedCache
                    );
                }
                else
                {
                    entries = ElementTypeResolver.GetTypes(
                        doc,
                        c.bic,
                        limit: 2000,
                        cacheBust: p.cacheBust,
                        cacheMaxAgeSeconds: p.cacheMaxAgeSeconds,
                        usedCache: out usedCache
                    );
                    if (!string.IsNullOrWhiteSpace(familyFilter))
                    {
                        entries = entries
                            .Where(e => (e.FamilyName ?? "").IndexOf(familyFilter, StringComparison.OrdinalIgnoreCase) >= 0)
                            .Take(remaining)
                            .ToList();
                    }
                    else
                    {
                        entries = entries.Take(remaining).ToList();
                    }
                }

                foreach (var e in entries.Take(remaining))
                {
                    Dictionary<string, string?>? parameters = null;
                    if (p.includeParameters != null && p.includeParameters.Count > 0 && p.includeParameters.Count <= 5)
                    {
                        var type = doc.GetElement(ElementIdCompat.Create(e.Id)) as ElementType;
                        if (type != null) parameters = ElementTypeResolver.ExtractTypeParameters(type, p.includeParameters);
                    }
                    results.Add(new
                    {
                        id = e.Id,
                        name = e.Name,
                        familyName = e.FamilyName,
                        category = c.canonical,
                        usedCache,
                        parameters
                    });
                    csvRows.Add((e.Id, e.Name ?? "", e.FamilyName ?? "", c.canonical, usedCache, parameters));
                }
            }

            if (exportRequested)
            {
                var folder = WorkspacePaths.ResolveDirectoryUnderWorkspace(p.outputFolder, "artifacts", "types");
                var fileName = BuildCsvFileName(p.fileName);
                var full = Path.Combine(folder, fileName);
                var includeParamColumns = (p.includeParameters ?? new List<string>())
                    .Select(x => (x ?? "").Trim())
                    .Where(x => x.Length > 0)
                    .Take(5)
                    .ToList();

                var sb = new StringBuilder();
                sb.Append("id,name,familyName,category,usedCache");
                foreach (var param in includeParamColumns)
                {
                    sb.Append(',');
                    sb.Append(CsvEscape(param));
                }
                sb.AppendLine();

                foreach (var row in csvRows)
                {
                    sb.Append(row.id);
                    sb.Append(',');
                    sb.Append(CsvEscape(row.name));
                    sb.Append(',');
                    sb.Append(CsvEscape(row.familyName));
                    sb.Append(',');
                    sb.Append(CsvEscape(row.category));
                    sb.Append(',');
                    sb.Append(row.usedCache ? "true" : "false");
                    foreach (var param in includeParamColumns)
                    {
                        string? value = null;
                        if (row.parameters != null)
                        {
                            row.parameters.TryGetValue(param, out value);
                        }
                        sb.Append(',');
                        sb.Append(CsvEscape(value ?? ""));
                    }
                    sb.AppendLine();
                }

                File.WriteAllText(full, sb.ToString(), Encoding.UTF8);

                return new
                {
                    status = "Success",
                    action = "list",
                    count = results.Count,
                    unresolvedCategories,
                    outputFolder = folder,
                    fileName,
                    path = full,
                    types = results
                };
            }

            return new
            {
                status = "Success",
                action = "list",
                count = results.Count,
                unresolvedCategories,
                types = results
            };
        }

        private static object HandleRenameTypes(Document doc, Params p)
        {
            if (string.IsNullOrWhiteSpace(p.familyName))
                throw new ArgumentException("list-element-types.rename_types requires familyName.");
            if (string.IsNullOrWhiteSpace(p.searchPattern))
                throw new ArgumentException("list-element-types.rename_types requires searchPattern.");

            var requestedCategories = CollectRequestedCategories(p.category, p.categories);
            var (categoryFilterIds, unresolvedCategories) = ResolveCategoryFilterIds(requestedCategories);
            if (requestedCategories.Count > 0 && categoryFilterIds.Count == 0)
                throw new ArgumentException("list-element-types.rename_types: none of the provided categories were resolved.");

            var options = RegexOptions.CultureInvariant;
            if (p.regexIgnoreCase ?? true) options |= RegexOptions.IgnoreCase;
            var regex = new Regex(p.searchPattern, options);

            var maxEdits = p.maxEdits ?? 500;
            if (maxEdits < 1) maxEdits = 1;
            if (maxEdits > 2000) maxEdits = 2000;
            var dryRun = p.dryRun ?? false;

            var targets = new FilteredElementCollector(doc)
                .OfClass(typeof(ElementType))
                .Cast<ElementType>()
                .Where(t => GetFamilyName(t).Equals(p.familyName, StringComparison.OrdinalIgnoreCase))
                .Where(t => categoryFilterIds.Count == 0 || (t.Category != null && categoryFilterIds.Contains(t.Category.Id)))
                .OrderBy(t => t.Name ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(t => ElementIdCompat.GetValue(t.Id))
                .Take(10000)
                .ToList();

            var existingNames = new HashSet<string>(
                targets.Select(t => (t.Name ?? "").Trim()),
                StringComparer.OrdinalIgnoreCase);

            var plans = new List<RenamePlan>();
            var skipped = new List<object>();
            foreach (var type in targets)
            {
                if (plans.Count >= maxEdits) break;
                var oldName = (type.Name ?? "").Trim();
                if (oldName.Length == 0) continue;

                var newName = regex.Replace(oldName, p.replaceWith ?? "");
                if (string.Equals(oldName, newName, StringComparison.Ordinal))
                    continue;
                if (string.IsNullOrWhiteSpace(newName))
                {
                    skipped.Add(new
                    {
                        typeId = ElementIdCompat.GetValue(type.Id),
                        oldName,
                        reason = "replacement produced an empty name"
                    });
                    continue;
                }

                if (existingNames.Contains(newName) && !string.Equals(oldName, newName, StringComparison.OrdinalIgnoreCase))
                {
                    skipped.Add(new
                    {
                        typeId = ElementIdCompat.GetValue(type.Id),
                        oldName,
                        newName,
                        reason = "target name already exists"
                    });
                    continue;
                }

                plans.Add(new RenamePlan
                {
                    typeId = ElementIdCompat.GetValue(type.Id),
                    familyName = GetFamilyName(type),
                    oldName = oldName,
                    newName = newName,
                    category = type.Category?.Name ?? ""
                });
                existingNames.Add(newName);
            }

            var applied = new List<object>();
            var errors = new List<object>();
            if (!dryRun && plans.Count > 0)
            {
                using var tx = new Transaction(doc, "Rename Family Types");
                tx.Start();
                foreach (var plan in plans)
                {
                    try
                    {
                        var type = doc.GetElement(ElementIdCompat.Create(plan.typeId)) as ElementType;
                        if (type == null) throw new InvalidOperationException("ElementType no longer exists.");
                        type.Name = plan.newName;
                        applied.Add(plan);
                    }
                    catch (Exception ex)
                    {
                        errors.Add(new { plan.typeId, plan.oldName, plan.newName, error = ex.Message });
                    }
                }
                tx.Commit();
            }

            return new
            {
                status = errors.Count > 0 ? "PartialSuccess" : "Success",
                action = "rename_types",
                dryRun,
                familyName = p.familyName,
                summary = new
                {
                    candidateCount = targets.Count,
                    plannedCount = plans.Count,
                    appliedCount = dryRun ? 0 : applied.Count,
                    skippedCount = skipped.Count,
                    errorCount = errors.Count
                },
                unresolvedCategories,
                planned = plans,
                applied = dryRun ? new List<object>() : applied,
                skipped,
                errors
            };
        }

        private static object HandlePurgeUnusedInFamily(Document doc, Params p)
        {
            if (string.IsNullOrWhiteSpace(p.familyName))
                throw new ArgumentException("list-element-types.purge_unused_in_family requires familyName.");

            var requestedCategories = CollectRequestedCategories(p.category, p.categories);
            var (categoryFilterIds, unresolvedCategories) = ResolveCategoryFilterIds(requestedCategories);
            if (requestedCategories.Count > 0 && categoryFilterIds.Count == 0)
                throw new ArgumentException("list-element-types.purge_unused_in_family: none of the provided categories were resolved.");

            var symbols = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .Where(s => (s.FamilyName ?? "").Trim().Equals(p.familyName, StringComparison.OrdinalIgnoreCase))
                .Where(s => categoryFilterIds.Count == 0 || (s.Category != null && categoryFilterIds.Contains(s.Category.Id)))
                .OrderBy(s => s.Name ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(s => ElementIdCompat.GetValue(s.Id))
                .ToList();

            var usedTypeIds = new HashSet<long>(
                new FilteredElementCollector(doc)
                    .OfClass(typeof(FamilyInstance))
                    .Cast<FamilyInstance>()
                    .Where(fi => fi.Symbol != null)
                    .Select(fi => ElementIdCompat.GetValue(fi.Symbol.Id)));

            var unused = symbols
                .Where(s => !usedTypeIds.Contains(ElementIdCompat.GetValue(s.Id)))
                .ToList();

            if (unused.Count == symbols.Count && unused.Count > 0)
            {
                // Keep one type to avoid deleting every type in the family.
                unused = unused.Skip(1).ToList();
            }

            var maxDelete = p.maxDelete ?? 500;
            if (maxDelete < 1) maxDelete = 1;
            if (maxDelete > 2000) maxDelete = 2000;
            var dryRun = p.dryRun ?? false;

            var candidates = unused
                .Take(maxDelete)
                .Select(s => new
                {
                    typeId = ElementIdCompat.GetValue(s.Id),
                    typeName = s.Name,
                    familyName = s.FamilyName,
                    category = s.Category?.Name
                })
                .ToList();

            var deleted = new List<object>();
            var errors = new List<object>();
            if (!dryRun && candidates.Count > 0)
            {
                using var tx = new Transaction(doc, "Purge Unused Family Types");
                tx.Start();
                foreach (var c in candidates)
                {
                    try
                    {
                        var impacted = doc.Delete(ElementIdCompat.Create(c.typeId));
                        deleted.Add(new
                        {
                            c.typeId,
                            c.typeName,
                            impactedCount = impacted?.Count ?? 0
                        });
                    }
                    catch (Exception ex)
                    {
                        errors.Add(new { c.typeId, c.typeName, error = ex.Message });
                    }
                }
                tx.Commit();
            }

            return new
            {
                status = errors.Count > 0 ? "PartialSuccess" : "Success",
                action = "purge_unused_in_family",
                dryRun,
                familyName = p.familyName,
                summary = new
                {
                    familyTypeCount = symbols.Count,
                    unusedCount = unused.Count,
                    candidateCount = candidates.Count,
                    deletedCount = dryRun ? 0 : deleted.Count,
                    errorCount = errors.Count
                },
                unresolvedCategories,
                candidates,
                deleted = dryRun ? new List<object>() : deleted,
                errors
            };
        }

        private static string GetFamilyName(ElementType type)
        {
            if (type is FamilySymbol fs) return (fs.FamilyName ?? "").Trim();

            try
            {
                var p = type.get_Parameter(BuiltInParameter.SYMBOL_FAMILY_NAME_PARAM);
                if (p != null && p.StorageType == StorageType.String)
                {
                    return (p.AsString() ?? "").Trim();
                }
            }
            catch
            {
                // ignore
            }

            try
            {
                var p = type.LookupParameter("Family Name");
                if (p != null && p.StorageType == StorageType.String)
                {
                    return (p.AsString() ?? "").Trim();
                }
            }
            catch
            {
                // ignore
            }

            return "";
        }

        private static List<string> CollectRequestedCategories(string? category, List<string>? categories)
        {
            var requestedCategories = new List<string>();
            if (!string.IsNullOrWhiteSpace(category))
            {
                requestedCategories.Add(category.Trim());
            }
            if (categories != null)
            {
                foreach (var raw in categories)
                {
                    var v = (raw ?? "").Trim();
                    if (v.Length == 0) continue;
                    requestedCategories.Add(v);
                }
            }
            return requestedCategories
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static (List<ElementId> ids, List<object> unresolved) ResolveCategoryFilterIds(List<string> requestedCategories)
        {
            var ids = new List<ElementId>();
            var unresolved = new List<object>();

            foreach (var token in requestedCategories)
            {
                if (!ElementTypeResolver.TryResolveBuiltInCategory(token, out var bic, out var canonical, out var suggestions))
                {
                    unresolved.Add(new
                    {
                        category = token,
                        suggestions = suggestions.Take(5).ToList()
                    });
                    continue;
                }
                ids.Add(new ElementId((int)bic));
            }

            ids = ids
                .Distinct(new ElementIdComparer())
                .ToList();

            return (ids, unresolved);
        }

        private sealed class ElementIdComparer : IEqualityComparer<ElementId>
        {
            public bool Equals(ElementId? x, ElementId? y)
            {
                if (x == null && y == null) return true;
                if (x == null || y == null) return false;
                return x.IntegerValue == y.IntegerValue;
            }

            public int GetHashCode(ElementId obj)
            {
                return obj.IntegerValue.GetHashCode();
            }
        }

        private static string BuildCsvFileName(string? requested)
        {
            var raw = (requested ?? "").Trim();
            if (raw.Length == 0) raw = $"element_types_{DateTime.Now:yyyyMMddHHmmss}.csv";
            foreach (var c in Path.GetInvalidFileNameChars())
            {
                raw = raw.Replace(c, '_');
            }
            raw = raw.Replace(Path.DirectorySeparatorChar, '_').Replace(Path.AltDirectorySeparatorChar, '_');
            raw = Path.GetFileName(raw);
            if (!raw.EndsWith(".csv", StringComparison.OrdinalIgnoreCase)) raw += ".csv";
            if (raw.Length > 180) raw = raw.Substring(0, 180);
            if (raw.Length == 0) raw = $"element_types_{DateTime.Now:yyyyMMddHHmmss}.csv";
            return raw;
        }

        private static string CsvEscape(string value)
        {
            var s = value ?? "";
            var needsQuotes = s.IndexOfAny(new[] { ',', '"', '\r', '\n' }) >= 0;
            if (!needsQuotes) return s;
            return "\"" + s.Replace("\"", "\"\"") + "\"";
        }
    }
}

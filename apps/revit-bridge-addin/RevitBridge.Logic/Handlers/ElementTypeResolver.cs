using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitBridge.Logic.Handlers
{
    internal static class ElementTypeResolver
    {
        internal sealed class TypeEntry
        {
            public long Id { get; set; }
            public string Name { get; set; } = "";
            public string? FamilyName { get; set; }
        }

        private sealed class CachedCatalog
        {
            public DateTime BuiltAtUtc { get; set; }
            public List<TypeEntry> Entries { get; set; } = new List<TypeEntry>();
            public Dictionary<string, List<TypeEntry>> ByName { get; set; } = new Dictionary<string, List<TypeEntry>>(StringComparer.OrdinalIgnoreCase);
        }

        private static readonly ConcurrentDictionary<string, CachedCatalog> CatalogCache =
            new ConcurrentDictionary<string, CachedCatalog>(StringComparer.OrdinalIgnoreCase);

        private static string Normalize(string s)
        {
            var t = (s ?? "").Trim().ToLowerInvariant();
            if (t.StartsWith("ost_")) t = t.Substring(4);
            t = t.Replace("_", "").Replace(" ", "").Replace("-", "");
            return t;
        }

        public static bool TryResolveBuiltInCategory(string? input, out BuiltInCategory category, out string canonical, out List<string> suggestions)
        {
            suggestions = new List<string>();
            category = default;
            canonical = "";

            var raw = (input ?? "").Trim();
            if (raw.Length == 0) return false;

            // Keep type discovery aligned with the normal element-query category
            // vocabulary (for example "air terminals" -> OST_DuctTerminal).
            if (BuiltInCategoryTokenUtil.TryParseAlias(raw, out var alias))
            {
                category = alias;
                canonical = alias.ToString();
                return true;
            }

            if (Enum.TryParse<BuiltInCategory>(raw, true, out var bic))
            {
                category = bic;
                canonical = bic.ToString();
                return true;
            }

            // Try common "short name" forms (Walls -> OST_Walls, Wall -> OST_Walls).
            var normIn = Normalize(raw);
            var normPlural = normIn.EndsWith("s") ? normIn : (normIn + "s");
            var normSingular = normIn.EndsWith("s") ? normIn.TrimEnd('s') : normIn;

            BuiltInCategory? bestExact = null;
            foreach (var name in Enum.GetNames(typeof(BuiltInCategory)))
            {
                if (!name.StartsWith("OST_", StringComparison.OrdinalIgnoreCase)) continue;
                var n = Normalize(name);
                if (n == normIn || n == normPlural || n == normSingular)
                {
                    if (Enum.TryParse<BuiltInCategory>(name, true, out var parsed))
                    {
                        bestExact = parsed;
                        break;
                    }
                }
            }

            if (bestExact.HasValue)
            {
                category = bestExact.Value;
                canonical = category.ToString();
                return true;
            }

            // Suggestions: "contains" match in either direction, capped.
            var hits = new List<string>();
            foreach (var name in Enum.GetNames(typeof(BuiltInCategory)))
            {
                if (!name.StartsWith("OST_", StringComparison.OrdinalIgnoreCase)) continue;
                var n = Normalize(name);
                if (n.Contains(normIn) || normIn.Contains(n)) hits.Add(name);
                if (hits.Count >= 8) break;
            }

            suggestions.AddRange(hits);
            return false;
        }

        private static string GetDocCacheKey(Document doc, BuiltInCategory category)
        {
            // Hash-based key is stable for the lifetime of the Document instance.
            var docKey = doc != null ? doc.GetHashCode().ToString("x") : "doc";
            return docKey + "|" + category.ToString();
        }

        private static CachedCatalog BuildCatalog(Document doc, BuiltInCategory category)
        {
            var types = new FilteredElementCollector(doc)
                .WhereElementIsElementType()
                .OfCategory(category)
                .ToElements()
                .OfType<ElementType>()
                .ToList();

            var entries = new List<TypeEntry>(types.Count);
            var byName = new Dictionary<string, List<TypeEntry>>(StringComparer.OrdinalIgnoreCase);

            foreach (var t in types)
            {
                var fs = t as FamilySymbol;
                var familyName = fs?.FamilyName ?? fs?.Family?.Name;
                var entry = new TypeEntry
                {
                    Id = RevitBridge.Common.ElementIdCompat.GetValue(t.Id),
                    Name = t.Name ?? "",
                    FamilyName = string.IsNullOrWhiteSpace(familyName) ? null : familyName
                };
                entries.Add(entry);

                var key = (entry.Name ?? "").Trim();
                if (!byName.TryGetValue(key, out var list))
                {
                    list = new List<TypeEntry>();
                    byName[key] = list;
                }
                list.Add(entry);
            }

            return new CachedCatalog
            {
                BuiltAtUtc = DateTime.UtcNow,
                Entries = entries,
                ByName = byName
            };
        }

        private static CachedCatalog GetCatalog(
            Document doc,
            BuiltInCategory category,
            bool cacheBust,
            int cacheMaxAgeSeconds,
            out bool usedCache)
        {
            usedCache = false;
            cacheMaxAgeSeconds = Math.Max(0, Math.Min(3600, cacheMaxAgeSeconds));

            var key = GetDocCacheKey(doc, category);
            if (!cacheBust && CatalogCache.TryGetValue(key, out var existing))
            {
                var age = (DateTime.UtcNow - existing.BuiltAtUtc).TotalSeconds;
                if (cacheMaxAgeSeconds == 0 || age <= cacheMaxAgeSeconds)
                {
                    usedCache = true;
                    return existing;
                }
            }

            var rebuilt = BuildCatalog(doc, category);
            CatalogCache[key] = rebuilt;
            return rebuilt;
        }

        public static IReadOnlyList<TypeEntry> GetTypes(
            Document doc,
            BuiltInCategory category,
            int limit,
            bool cacheBust,
            int cacheMaxAgeSeconds,
            out bool usedCache)
        {
            limit = Math.Max(1, Math.Min(2000, limit));
            var catalog = GetCatalog(doc, category, cacheBust, cacheMaxAgeSeconds, out usedCache);
            return catalog.Entries.Take(limit).ToList();
        }

        public static IReadOnlyList<TypeEntry> SearchTypes(
            Document doc,
            BuiltInCategory category,
            string typeName,
            string? familyName,
            bool exact,
            int limit,
            bool cacheBust,
            int cacheMaxAgeSeconds,
            out bool usedCache)
        {
            usedCache = false;
            var name = (typeName ?? "").Trim();
            if (name.Length == 0) return Array.Empty<TypeEntry>();

            limit = Math.Max(1, Math.Min(2000, limit));
            var catalog = GetCatalog(doc, category, cacheBust, cacheMaxAgeSeconds, out usedCache);

            if (exact)
            {
                if (catalog.ByName.TryGetValue(name, out var exactMatches))
                {
                    IEnumerable<TypeEntry> filtered = exactMatches;
                    if (!string.IsNullOrWhiteSpace(familyName))
                    {
                        var fn = familyName.Trim();
                        filtered = filtered.Where(e => string.Equals(e.FamilyName ?? "", fn, StringComparison.OrdinalIgnoreCase));
                    }
                    return filtered.Take(limit).ToList();
                }
                return Array.Empty<TypeEntry>();
            }

            var contains = name;
            IEnumerable<TypeEntry> scan = catalog.Entries;
            if (!string.IsNullOrWhiteSpace(familyName))
            {
                var fn = familyName.Trim();
                scan = scan.Where(e => (e.FamilyName ?? "").IndexOf(fn, StringComparison.OrdinalIgnoreCase) >= 0);
            }

            return scan
                .Where(e => (e.Name ?? "").IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0)
                .Take(limit)
                .ToList();
        }

        public static Dictionary<string, string?> ExtractTypeParameters(ElementType type, IEnumerable<string> names)
        {
            var outMap = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            foreach (var raw in names ?? Array.Empty<string>())
            {
                var n = (raw ?? "").Trim();
                if (n.Length == 0) continue;
                if (outMap.ContainsKey(n)) continue;

                try
                {
                    var p = type.LookupParameter(n);
                    if (p == null)
                    {
                        outMap[n] = null;
                        continue;
                    }

                    string? val = null;
                    switch (p.StorageType)
                    {
                        case StorageType.String: val = p.AsString(); break;
                        case StorageType.Integer: val = p.AsInteger().ToString(); break;
                        case StorageType.Double: val = p.AsDouble().ToString(); break;
                        case StorageType.ElementId: val = RevitBridge.Common.ElementIdCompat.GetValue(p.AsElementId()).ToString(); break;
                    }
                    outMap[n] = val;
                }
                catch
                {
                    outMap[n] = null;
                }
            }
            return outMap;
        }
    }
}

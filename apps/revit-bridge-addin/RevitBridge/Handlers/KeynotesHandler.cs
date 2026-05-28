using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class KeynotesHandler : IRequestHandler
    {
        private static readonly string[] KeynoteParameterCandidates =
        {
            "Key Value",
            "Keynote",
            "Keynote Value"
        };

        private static readonly string[] KeynoteBuiltInCandidates =
        {
            "KEY_VALUE",
            "KEYNOTE_PARAM"
        };

        public sealed class Params
        {
            public string? action { get; set; } // list_tags | list_elements_missing_keynote | set_element_keynote
            public long? viewId { get; set; }
            public long[]? elementIds { get; set; }
            public string[]? categoryNames { get; set; }
            public string? keynoteValue { get; set; }
            public int? max { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var action = (p.action ?? "list_tags").Trim().ToLowerInvariant();
            return action switch
            {
                "list_tags" => Task.FromResult<object>(HandleListTags(doc, p)),
                "list_elements_missing_keynote" => Task.FromResult<object>(HandleListMissing(doc, p)),
                "set_element_keynote" => Task.FromResult<object>(HandleSetElementKeynote(doc, p)),
                _ => throw new InvalidOperationException("keynotes.action must be list_tags|list_elements_missing_keynote|set_element_keynote.")
            };
        }

        private static object HandleListTags(Document doc, Params p)
        {
            var view = ResolveView(doc, p.viewId);
            var max = NormalizeMax(p.max, 200, 5000);

            var collector = view == null
                ? new FilteredElementCollector(doc)
                : new FilteredElementCollector(doc, view.Id);

            var tags = collector
                .OfCategory(BuiltInCategory.OST_KeynoteTags)
                .WhereElementIsNotElementType()
                .ToElements()
                .Take(max)
                .Select(e =>
                {
                    string? tagText = TryReadProperty(e, "TagText");
                    var ownerViewId = TryReadElementIdProperty(e, "OwnerViewId");
                    var taggedElementId = TryReadTaggedElementId(e);
                    return new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                        name = e.Name,
                        keyValue = TryReadKeynoteValue(e),
                        tagText,
                        ownerViewId,
                        taggedElementId
                    };
                })
                .ToArray();

            return new
            {
                status = "Success",
                action = "list_tags",
                count = tags.Length,
                view = view == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id), name = view.Name },
                tags
            };
        }

        private static object HandleListMissing(Document doc, Params p)
        {
            var targets = ResolveTargetElements(doc, p);
            var max = NormalizeMax(p.max, 200, 5000);

            var missing = targets
                .Where(e => string.IsNullOrWhiteSpace(TryReadKeynoteValue(e)))
                .Take(max)
                .Select(e => new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                    name = e.Name,
                    category = e.Category?.Name
                })
                .ToArray();

            return new
            {
                status = "Success",
                action = "list_elements_missing_keynote",
                requested = targets.Count,
                missingCount = missing.Length,
                missing
            };
        }

        private static object HandleSetElementKeynote(Document doc, Params p)
        {
            if (p.elementIds == null || p.elementIds.Length == 0)
                throw new InvalidOperationException("keynotes.set_element_keynote requires elementIds.");
            var value = (p.keynoteValue ?? "").Trim();
            if (value.Length == 0)
                throw new InvalidOperationException("keynotes.set_element_keynote requires keynoteValue.");

            var targets = p.elementIds
                .Where(x => x > 0)
                .Distinct()
                .Select(id => doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id)))
                .Where(e => e != null)
                .ToList();
            if (targets.Count == 0)
                throw new InvalidOperationException("No target elements found for provided elementIds.");

            var dryRun = p.dryRun ?? false;
            if (dryRun)
            {
                return new
                {
                    status = "Dry Run",
                    action = "set_element_keynote",
                    dryRun = true,
                    keynoteValue = value,
                    targetCount = targets.Count,
                    targets = targets.Take(100).Select(e => new { id = RevitBridge.Common.ElementIdCompat.GetValue(e!.Id), name = e.Name, category = e.Category?.Name }).ToArray()
                };
            }

            var changed = new List<object>();
            var skipped = new List<object>();
            var errors = new List<object>();
            using (var tx = new Transaction(doc, "Set Element Keynote"))
            {
                tx.Start();

                foreach (var e in targets)
                {
                    try
                    {
                        var before = TryReadKeynoteValue(e!);
                        var ok = TrySetKeynoteValue(e!, value);
                        var after = TryReadKeynoteValue(e!);
                        if (ok)
                        {
                            changed.Add(new { id = RevitBridge.Common.ElementIdCompat.GetValue(e!.Id), before, after });
                        }
                        else
                        {
                            skipped.Add(new { id = RevitBridge.Common.ElementIdCompat.GetValue(e!.Id), reason = "No writable keynote parameter found." });
                        }
                    }
                    catch (Exception ex)
                    {
                        errors.Add(new { id = RevitBridge.Common.ElementIdCompat.GetValue(e!.Id), error = ex.Message });
                    }
                }

                tx.Commit();
            }

            return new
            {
                status = "Success",
                action = "set_element_keynote",
                keynoteValue = value,
                summary = new
                {
                    requested = targets.Count,
                    changed = changed.Count,
                    skipped = skipped.Count,
                    errors = errors.Count
                },
                changed = changed.Take(100).ToArray(),
                skipped = skipped.Take(100).ToArray(),
                errors = errors.Take(100).ToArray()
            };
        }

        private static View? ResolveView(Document doc, long? viewId)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
            }

            return null;
        }

        private static List<Element> ResolveTargetElements(Document doc, Params p)
        {
            if (p.elementIds != null && p.elementIds.Length > 0)
            {
                return p.elementIds
                    .Where(x => x > 0)
                    .Distinct()
                    .Select(id => doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id)))
                    .Where(e => e != null)
                    .Cast<Element>()
                    .ToList();
            }

            var view = ResolveView(doc, p.viewId);
            var collector = view == null
                ? new FilteredElementCollector(doc)
                : new FilteredElementCollector(doc, view.Id);

            var cats = ResolveCategories(doc, p.categoryNames);
            if (cats.Count == 0 && view == null)
                throw new InvalidOperationException("keynotes.list_elements_missing_keynote requires elementIds, viewId, or categoryNames.");

            var elements = collector
                .WhereElementIsNotElementType()
                .Where(e => e != null && e.Category != null)
                .Where(e => cats.Count == 0 || cats.Any(c => c.Id == e.Category.Id))
                .ToList();

            return elements;
        }

        private static List<Category> ResolveCategories(Document doc, string[]? categoryNames)
        {
            if (categoryNames == null || categoryNames.Length == 0) return new List<Category>();

            var outList = new List<Category>();
            foreach (var raw in categoryNames)
            {
                var name = (raw ?? "").Trim();
                if (name.Length == 0) continue;

                if (Enum.TryParse(name, ignoreCase: true, out BuiltInCategory bic))
                {
                    try
                    {
                        var byBic = doc.Settings.Categories.get_Item(bic);
                        if (byBic != null) outList.Add(byBic);
                        continue;
                    }
                    catch
                    {
                        // fallback by name below
                    }
                }

                try
                {
                    var byName = doc.Settings.Categories
                        .Cast<Category>()
                        .FirstOrDefault(c => (c?.Name ?? "").Equals(name, StringComparison.OrdinalIgnoreCase));
                    if (byName != null) outList.Add(byName);
                }
                catch
                {
                    // ignore
                }
            }

            return outList
                .GroupBy(x => RevitBridge.Common.ElementIdCompat.GetValue(x.Id))
                .Select(g => g.First())
                .ToList();
        }

        private static string? TryReadKeynoteValue(Element e)
        {
            foreach (var name in KeynoteParameterCandidates)
            {
                try
                {
                    var p = e.LookupParameter(name);
                    if (p == null) continue;
                    var v = p.AsString();
                    if (!string.IsNullOrWhiteSpace(v)) return v;
                    v = p.AsValueString();
                    if (!string.IsNullOrWhiteSpace(v)) return v;
                }
                catch
                {
                    // ignore
                }
            }

            foreach (var builtIn in KeynoteBuiltInCandidates)
            {
                try
                {
                    var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), builtIn, ignoreCase: true);
                    var p = e.get_Parameter(bip);
                    if (p == null) continue;
                    var v = p.AsString();
                    if (!string.IsNullOrWhiteSpace(v)) return v;
                    v = p.AsValueString();
                    if (!string.IsNullOrWhiteSpace(v)) return v;
                }
                catch
                {
                    // ignore
                }
            }

            return null;
        }

        private static bool TrySetKeynoteValue(Element e, string value)
        {
            foreach (var name in KeynoteParameterCandidates)
            {
                try
                {
                    var p = e.LookupParameter(name);
                    if (p == null || p.IsReadOnly || p.StorageType != StorageType.String) continue;
                    if (p.Set(value)) return true;
                }
                catch
                {
                    // ignore
                }
            }

            foreach (var builtIn in KeynoteBuiltInCandidates)
            {
                if (TrySetBuiltInStringParameter(e, builtIn, value)) return true;
            }

            return false;
        }

        private static bool TrySetBuiltInStringParameter(Element e, string builtInParameterName, string value)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), builtInParameterName, ignoreCase: true);
                var p = e.get_Parameter(bip);
                if (p == null || p.IsReadOnly || p.StorageType != StorageType.String) return false;
                return p.Set(value);
            }
            catch
            {
                return false;
            }
        }

        private static string? TryReadProperty(object target, string propName)
        {
            try
            {
                var p = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(target, null);
                return raw?.ToString();
            }
            catch
            {
                return null;
            }
        }

        private static long? TryReadElementIdProperty(object target, string propName)
        {
            try
            {
                var p = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(target, null);
                if (raw is ElementId eid) return RevitBridge.Common.ElementIdCompat.GetValue(eid);
                return null;
            }
            catch
            {
                return null;
            }
        }

        private static long? TryReadTaggedElementId(Element e)
        {
            var taggedId = TryReadElementIdProperty(e, "TaggedLocalElementId");
            if (taggedId.HasValue) return taggedId.Value;
            return null;
        }

        private static int NormalizeMax(int? raw, int fallback, int cap)
        {
            var v = raw ?? fallback;
            if (v < 1) v = 1;
            if (v > cap) v = cap;
            return v;
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class TagElementsHandler : IRequestHandler
    {
        public sealed class CategoryTagTypeMap
        {
            public string? categoryName { get; set; }
            public long? tagTypeId { get; set; }
            public string? tagTypeName { get; set; }
            public string? tagFamilyName { get; set; }
        }

        public sealed class TagRequest
        {
            public long? viewId { get; set; }
            public string? viewName { get; set; }
            public List<long>? elementIds { get; set; }
            public List<string>? categoryNames { get; set; }
            public List<CategoryTagTypeMap>? categoryTagTypeMap { get; set; }
            public long? tagTypeId { get; set; }
            public string? tagTypeName { get; set; }
            public string? tagFamilyName { get; set; } // compatibility alias
            public bool? onlyUntagged { get; set; }
            public bool? addLeader { get; set; }
            public string? orientation { get; set; } // horizontal|vertical
            public double? offsetX { get; set; }
            public double? offsetY { get; set; }
            public int? max { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new TagRequest()
                : (JsonSerializer.Deserialize<TagRequest>(jsonData) ?? new TagRequest());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var view = ResolveView(doc, p.viewId, p.viewName, app.ActiveUIDocument?.ActiveView);
            if (view == null) throw new InvalidOperationException("tag-elements requires viewId or viewName (or an active view).");

            var max = p.max.GetValueOrDefault(5000);
            if (max < 1) max = 1;
            if (max > 5000) max = 5000;

            var targets = ResolveTargets(doc, view, p, max, out var unresolvedCategories);
            var onlyUntagged = p.onlyUntagged ?? true;
            var addLeader = p.addLeader ?? false;
            var offset = new XYZ(p.offsetX ?? 1.0, p.offsetY ?? 1.0, 0);
            var orientation = ResolveOrientation(p.orientation);
            var dryRun = p.dryRun ?? false;

            var existingTagged = onlyUntagged
                ? CollectTaggedElementIdsOnView(doc, view.Id)
                : new HashSet<long>();

            var mapping = ResolveCategoryTagTypeMap(doc, p.categoryTagTypeMap, out var mappingWarnings);
            var defaultTypeId = ResolveDefaultTagTypeId(doc, p.tagTypeId, p.tagTypeName, p.tagFamilyName);

            var planned = targets
                .Select(e => new
                {
                    elementId = ElementIdCompat.GetValue(e.Id),
                    category = e.Category?.Name,
                    alreadyTagged = existingTagged.Contains(ElementIdCompat.GetValue(e.Id))
                })
                .ToList();

            var skippedAlready = onlyUntagged ? planned.Count(x => x.alreadyTagged) : 0;
            var plannedToTag = onlyUntagged ? planned.Count(x => !x.alreadyTagged) : planned.Count;

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    viewId = ElementIdCompat.GetValue(view.Id),
                    targetCount = planned.Count,
                    plannedToTag,
                    skippedAlreadyTagged = skippedAlready,
                    unresolvedCategories,
                    mappingWarnings,
                    defaultTagTypeId = defaultTypeId == null ? (long?)null : ElementIdCompat.GetValue(defaultTypeId),
                    targets = planned.Take(200).ToList()
                });
            }

            var tagIds = new List<long>();
            var tagReadback = new List<object>();
            var errors = new List<object>();
            var skippedNoLocation = 0;

            using (var t = new Transaction(doc, "Tag Elements"))
            {
                t.Start();
                foreach (var element in targets)
                {
                    var elementId = ElementIdCompat.GetValue(element.Id);
                    if (onlyUntagged && existingTagged.Contains(elementId))
                    {
                        continue;
                    }

                    var point = ResolveTagPoint(element, view, offset);
                    if (point == null)
                    {
                        skippedNoLocation++;
                        continue;
                    }

                    try
                    {
                        var tag = CreateTagElement(doc, view, element, addLeader, orientation, point);

                        var mappedTypeId = ResolveMappedTypeForElement(element, mapping);
                        var targetTypeId = mappedTypeId ?? defaultTypeId;
                        if (targetTypeId != null && targetTypeId != ElementId.InvalidElementId)
                        {
                            try
                            {
                                tag.ChangeTypeId(targetTypeId);
                            }
                            catch
                            {
                                // Keep created tag even if specific type is invalid for this category/view.
                            }
                        }

                        tagIds.Add(ElementIdCompat.GetValue(tag.Id));
                        tagReadback.Add(BuildTagReadback(doc, tag, element, view));
                        if (onlyUntagged) existingTagged.Add(elementId);
                    }
                    catch (Exception ex)
                    {
                        errors.Add(new { elementId, error = ex.Message });
                    }
                }

                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                viewId = ElementIdCompat.GetValue(view.Id),
                targetCount = planned.Count,
                taggedCount = tagIds.Count,
                skippedAlreadyTagged = skippedAlready,
                skippedNoLocation,
                errorCount = errors.Count,
                unresolvedCategories,
                mappingWarnings,
                tagIds,
                tags = tagReadback,
                tagReadback,
                errors = errors.Take(200).ToList()
            });
        }

        private static View? ResolveView(Document doc, long? viewId, string? viewName, View? activeView)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(viewId.Value)) as View;
                if (byId != null) return byId;
            }

            var name = (viewName ?? string.Empty).Trim();
            if (name.Length > 0)
            {
                var byName = new FilteredElementCollector(doc)
                    .OfClass(typeof(View))
                    .Cast<View>()
                    .FirstOrDefault(v => !v.IsTemplate && string.Equals((v.Name ?? string.Empty).Trim(), name, StringComparison.OrdinalIgnoreCase));
                if (byName != null) return byName;
            }

            return activeView;
        }

        private static List<Element> ResolveTargets(Document doc, View view, TagRequest p, int max, out List<string> unresolvedCategories)
        {
            unresolvedCategories = new List<string>();
            var byId = new Dictionary<long, Element>();

            var ids = p.elementIds ?? new List<long>();
            foreach (var id in ids)
            {
                if (id <= 0) continue;
                var element = doc.GetElement(ElementIdCompat.Create(id));
                if (element == null || element.Category == null) continue;
                byId[ElementIdCompat.GetValue(element.Id)] = element;
                if (byId.Count >= max) break;
            }

            var categoryNames = (p.categoryNames ?? new List<string>())
                .Select(x => (x ?? string.Empty).Trim())
                .Where(x => x.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            if (categoryNames.Count > 0 && byId.Count < max)
            {
                var categoryIds = new HashSet<long>();
                foreach (var categoryName in categoryNames)
                {
                    var category = ResolveCategory(doc, categoryName);
                    if (category == null)
                    {
                        unresolvedCategories.Add(categoryName);
                        continue;
                    }
                    categoryIds.Add(ElementIdCompat.GetValue(category.Id));
                }

                var collector = new FilteredElementCollector(doc, view.Id)
                    .WhereElementIsNotElementType()
                    .ToElements();

                foreach (var element in collector)
                {
                    if (element?.Category == null) continue;
                    if (!categoryIds.Contains(ElementIdCompat.GetValue(element.Category.Id))) continue;
                    byId[ElementIdCompat.GetValue(element.Id)] = element;
                    if (byId.Count >= max) break;
                }
            }

            if (byId.Count == 0)
            {
                throw new InvalidOperationException("tag-elements requires elementIds and/or categoryNames with at least one resolvable target.");
            }

            return byId.Values.ToList();
        }

        private static Category? ResolveCategory(Document doc, string token)
        {
            var trimmed = (token ?? string.Empty).Trim();
            if (trimmed.Length == 0) return null;

            foreach (Category cat in doc.Settings.Categories)
            {
                if (cat == null) continue;
                if (string.Equals(cat.Name, trimmed, StringComparison.OrdinalIgnoreCase))
                {
                    return cat;
                }
            }

            if (Enum.TryParse(trimmed, true, out BuiltInCategory bic))
            {
                try
                {
                    return Category.GetCategory(doc, bic);
                }
                catch
                {
                    // ignore
                }
            }

            return null;
        }

        private static TagOrientation ResolveOrientation(string? orientation)
        {
            var value = (orientation ?? "horizontal").Trim().ToLowerInvariant();
            return value == "vertical"
                ? TagOrientation.Vertical
                : TagOrientation.Horizontal;
        }

        private static XYZ? ResolveTagPoint(Element element, View view, XYZ offset)
        {
            if (element.Location is LocationPoint lp && lp.Point != null)
            {
                return lp.Point + offset;
            }

            var bbox = element.get_BoundingBox(view);
            if (bbox != null)
            {
                return ((bbox.Min + bbox.Max) * 0.5) + offset;
            }

            return null;
        }

        private static Element CreateTagElement(Document doc, View view, Element element, bool addLeader, TagOrientation orientation, XYZ point)
        {
            if (element is Room room)
            {
                var tag = doc.Create.NewRoomTag(new LinkElementId(room.Id), new UV(point.X, point.Y), view.Id);
                if (tag == null) throw new InvalidOperationException("Room tag creation returned null.");
                return tag;
            }

            if (element is Space space)
            {
                var tag = doc.Create.NewSpaceTag(space, new UV(point.X, point.Y), view);
                if (tag == null) throw new InvalidOperationException("Space tag creation returned null.");
                return tag;
            }

            return IndependentTag.Create(
                doc,
                view.Id,
                new Reference(element),
                addLeader,
                TagMode.TM_ADDBY_CATEGORY,
                orientation,
                point);
        }

        private static object BuildTagReadback(Document doc, Element tag, Element target, View view)
        {
            var type = doc.GetElement(tag.GetTypeId()) as ElementType;
            var family = type is FamilySymbol fs ? fs.FamilyName : type?.FamilyName;
            return new
            {
                tagId = ElementIdCompat.GetValue(tag.Id),
                targetElementId = ElementIdCompat.GetValue(target.Id),
                viewId = ElementIdCompat.GetValue(view.Id),
                targetCategory = target.Category?.Name,
                tagCategory = tag.Category?.Name,
                tagTypeId = type == null ? (long?)null : ElementIdCompat.GetValue(type.Id),
                tagTypeName = type?.Name,
                tagFamilyName = family,
                value = ReadTagDisplayValue(tag)
            };
        }

        private static string? ReadTagDisplayValue(Element tag)
        {
            if (tag is IndependentTag independentTag)
            {
                return independentTag.TagText;
            }

            var tagText = tag.GetType().GetProperty("TagText", BindingFlags.Instance | BindingFlags.Public);
            if (tagText != null && tagText.GetValue(tag, null) is string reflectedTagText)
            {
                return reflectedTagText;
            }

            return null;
        }

        private static HashSet<long> CollectTaggedElementIdsOnView(Document doc, ElementId viewId)
        {
            var ids = new HashSet<long>();
            var tags = new FilteredElementCollector(doc, viewId)
                .OfClass(typeof(IndependentTag))
                .Cast<IndependentTag>();

            foreach (var tag in tags)
            {
                foreach (var id in GetTaggedElementIds(tag))
                {
                    if (id != null && id != ElementId.InvalidElementId)
                    {
                        ids.Add(ElementIdCompat.GetValue(id));
                    }
                }
            }

            return ids;
        }

        private static IEnumerable<ElementId> GetTaggedElementIds(IndependentTag tag)
        {
            var method = tag.GetType().GetMethod("GetTaggedLocalElementIds", BindingFlags.Instance | BindingFlags.Public);
            if (method != null)
            {
                var values = method.Invoke(tag, null) as System.Collections.IEnumerable;
                if (values != null)
                {
                    foreach (var item in values)
                    {
                        if (item is ElementId id) yield return id;
                    }
                    yield break;
                }
            }

            var prop = tag.GetType().GetProperty("TaggedLocalElementId", BindingFlags.Instance | BindingFlags.Public);
            if (prop != null && prop.GetValue(tag, null) is ElementId singleId)
            {
                yield return singleId;
            }
        }

        private static Dictionary<long, ElementId?> ResolveCategoryTagTypeMap(Document doc, List<CategoryTagTypeMap>? map, out List<object> warnings)
        {
            var resolved = new Dictionary<long, ElementId?>();
            warnings = new List<object>();
            if (map == null || map.Count == 0) return resolved;

            foreach (var entry in map)
            {
                var categoryName = (entry?.categoryName ?? string.Empty).Trim();
                if (categoryName.Length == 0) continue;

                var category = ResolveCategory(doc, categoryName);
                if (category == null)
                {
                    warnings.Add(new { categoryName, warning = "Category not found." });
                    continue;
                }

                var typeId = ResolveDefaultTagTypeId(doc, entry?.tagTypeId, entry?.tagTypeName, entry?.tagFamilyName);
                if (typeId == null)
                {
                    warnings.Add(new { categoryName, warning = "Tag type not found." });
                }

                resolved[ElementIdCompat.GetValue(category.Id)] = typeId;
            }

            return resolved;
        }

        private static ElementId? ResolveMappedTypeForElement(Element element, Dictionary<long, ElementId?> map)
        {
            if (element.Category == null) return null;
            var categoryId = ElementIdCompat.GetValue(element.Category.Id);
            return map.TryGetValue(categoryId, out var typeId) ? typeId : null;
        }

        private static ElementId? ResolveDefaultTagTypeId(Document doc, long? tagTypeId, string? tagTypeName, string? tagFamilyName)
        {
            if (tagTypeId.HasValue && tagTypeId.Value > 0)
            {
                var byId = ElementIdCompat.Create(tagTypeId.Value);
                if (doc.GetElement(byId) is ElementType) return byId;
            }

            var typeName = (tagTypeName ?? string.Empty).Trim();
            var familyName = (tagFamilyName ?? string.Empty).Trim();
            if (typeName.Length == 0 && familyName.Length == 0) return null;

            var symbols = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>();

            foreach (var symbol in symbols)
            {
                var symbolName = (symbol.Name ?? string.Empty).Trim();
                var family = (symbol.FamilyName ?? string.Empty).Trim();

                var typeMatch = typeName.Length == 0 || symbolName.Equals(typeName, StringComparison.OrdinalIgnoreCase) || symbolName.IndexOf(typeName, StringComparison.OrdinalIgnoreCase) >= 0;
                var familyMatch = familyName.Length == 0 || family.Equals(familyName, StringComparison.OrdinalIgnoreCase) || family.IndexOf(familyName, StringComparison.OrdinalIgnoreCase) >= 0;
                if (typeMatch && familyMatch)
                {
                    return symbol.Id;
                }
            }

            return null;
        }
    }
}

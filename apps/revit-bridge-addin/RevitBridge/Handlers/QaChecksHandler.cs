using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class QaChecksHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? action { get; set; }

            // Interference check options
            public List<string>? sourceCategories { get; set; }
            public List<string>? targetCategories { get; set; }
            public long? viewId { get; set; }
            public int? maxClashes { get; set; }

            // View-bounds check options
            public List<long>? viewIds { get; set; }
            public List<string>? categories { get; set; }
            public int? maxViews { get; set; }
            public int? maxFindingsPerView { get; set; }
            public int? maxElementsPerView { get; set; }
            public double? marginFeet { get; set; }
        }

        private sealed class ViewBoundsContext
        {
            public BoundingBoxXYZ? cropBox { get; set; }
            public BoundingBoxXYZ? sectionBox { get; set; }
            public BoundingBoxXYZ? scopeBox { get; set; }
            public string? scopeBoxName { get; set; }
            public bool hasCrop => cropBox != null;
            public bool hasSection => sectionBox != null;
            public bool hasScope => scopeBox != null;
        }

        private static readonly BuiltInCategory[] DefaultInterferenceSourceCategories =
        {
            BuiltInCategory.OST_DuctCurves,
            BuiltInCategory.OST_DuctFitting,
            BuiltInCategory.OST_DuctAccessory
        };

        private static readonly BuiltInCategory[] DefaultInterferenceTargetCategories =
        {
            BuiltInCategory.OST_StructuralFraming
        };

        private static readonly Dictionary<string, BuiltInCategory> CategoryAliases =
            new Dictionary<string, BuiltInCategory>(StringComparer.OrdinalIgnoreCase)
            {
                { "ducts", BuiltInCategory.OST_DuctCurves },
                { "ductcurves", BuiltInCategory.OST_DuctCurves },
                { "duct fittings", BuiltInCategory.OST_DuctFitting },
                { "ductfittings", BuiltInCategory.OST_DuctFitting },
                { "duct accessories", BuiltInCategory.OST_DuctAccessory },
                { "ductaccessories", BuiltInCategory.OST_DuctAccessory },
                { "air terminals", BuiltInCategory.OST_DuctTerminal },
                { "airterminals", BuiltInCategory.OST_DuctTerminal },
                { "structural framing", BuiltInCategory.OST_StructuralFraming },
                { "structuralframing", BuiltInCategory.OST_StructuralFraming },
                { "framing", BuiltInCategory.OST_StructuralFraming },
                { "structural columns", BuiltInCategory.OST_StructuralColumns },
                { "structuralcolumns", BuiltInCategory.OST_StructuralColumns },
                { "columns", BuiltInCategory.OST_StructuralColumns },
                { "walls", BuiltInCategory.OST_Walls },
                { "mechanical equipment", BuiltInCategory.OST_MechanicalEquipment },
                { "mechanicalequipment", BuiltInCategory.OST_MechanicalEquipment },
                { "pipes", BuiltInCategory.OST_PipeCurves },
                { "pipecurves", BuiltInCategory.OST_PipeCurves }
            };

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "NoDocument",
                    message = "No active Revit document."
                });
            }

            var action = NormalizeAction(p.action);
            if (action == "interference_basic")
            {
                return Task.FromResult<object>(RunInterferenceBasic(doc, p));
            }

            if (action == "view_bounds")
            {
                return Task.FromResult<object>(RunViewBounds(doc, app.ActiveUIDocument?.ActiveView, p));
            }

            throw new InvalidOperationException("qa-checks.action must be 'interference_basic' or 'view_bounds'.");
        }

        private static object RunInterferenceBasic(Document doc, Params p)
        {
            var warnings = new List<string>();
            var unknownSourceCategories = new List<string>();
            var unknownTargetCategories = new List<string>();
            var sourceCategories = ResolveCategories(
                p.sourceCategories,
                DefaultInterferenceSourceCategories,
                unknownSourceCategories);
            var targetCategories = ResolveCategories(
                p.targetCategories,
                DefaultInterferenceTargetCategories,
                unknownTargetCategories);

            if (unknownSourceCategories.Count > 0)
            {
                warnings.Add("Unknown sourceCategories ignored: " + string.Join(", ", unknownSourceCategories));
            }
            if (unknownTargetCategories.Count > 0)
            {
                warnings.Add("Unknown targetCategories ignored: " + string.Join(", ", unknownTargetCategories));
            }
            if (sourceCategories.Count == 0)
            {
                throw new InvalidOperationException("qa-checks.interference_basic requires at least one source category.");
            }
            if (targetCategories.Count == 0)
            {
                throw new InvalidOperationException("qa-checks.interference_basic requires at least one target category.");
            }

            View? viewScope = null;
            if (p.viewId.HasValue && p.viewId.Value > 0)
            {
                viewScope = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
                if (viewScope == null)
                {
                    throw new InvalidOperationException($"View {p.viewId.Value} not found.");
                }
            }

            var sourceElements = CollectElementsByCategory(doc, viewScope, sourceCategories);
            var targetElements = CollectElementsByCategory(doc, viewScope, targetCategories);
            var maxClashes = Clamp(p.maxClashes ?? 500, 1, 5000);

            var targetIds = new HashSet<long>(targetElements.Select(e => RevitBridge.Common.ElementIdCompat.GetValue(e.Id)));
            var targetIdList = targetElements.Select(e => e.Id).ToList();

            var clashes = new List<object>();
            var seenPairs = new HashSet<string>(StringComparer.Ordinal);
            var sourcesScanned = 0;
            var intersectionErrors = 0;

            ElementIdSetFilter? targetIdFilter = null;
            if (targetIdList.Count > 0)
            {
                targetIdFilter = new ElementIdSetFilter(targetIdList);
            }

            foreach (var source in sourceElements)
            {
                if (source == null) continue;
                sourcesScanned++;

                IEnumerable<Element> hits;
                try
                {
                    if (targetIdFilter == null)
                    {
                        hits = Enumerable.Empty<Element>();
                    }
                    else
                    {
                        var sourceIntersects = new ElementIntersectsElementFilter(source);
                        var collector = viewScope == null
                            ? new FilteredElementCollector(doc)
                            : new FilteredElementCollector(doc, viewScope.Id);
                        hits = collector
                            .WhereElementIsNotElementType()
                            .WherePasses(targetIdFilter)
                            .WherePasses(sourceIntersects)
                            .ToElements();
                    }
                }
                catch
                {
                    intersectionErrors++;
                    hits = FallbackIntersectionsByBoundingBox(source, targetElements, viewScope);
                }

                foreach (var target in hits)
                {
                    if (target == null) continue;
                    if (target.Id == source.Id) continue;
                    if (!targetIds.Contains(RevitBridge.Common.ElementIdCompat.GetValue(target.Id))) continue;

                    var a = RevitBridge.Common.ElementIdCompat.GetValue(source.Id);
                    var b = RevitBridge.Common.ElementIdCompat.GetValue(target.Id);
                    var key = a < b ? $"{a}:{b}" : $"{b}:{a}";
                    if (!seenPairs.Add(key)) continue;

                    clashes.Add(new
                    {
                        sourceElementId = a,
                        sourceCategory = source.Category?.Name,
                        sourceName = source.Name,
                        targetElementId = b,
                        targetCategory = target.Category?.Name,
                        targetName = target.Name
                    });

                    if (clashes.Count >= maxClashes)
                    {
                        break;
                    }
                }

                if (clashes.Count >= maxClashes)
                {
                    break;
                }
            }

            if (intersectionErrors > 0)
            {
                warnings.Add($"ElementIntersectsElement fallback used for {intersectionErrors} source element(s).");
            }
            if (clashes.Count >= maxClashes)
            {
                warnings.Add($"Clash results truncated to maxClashes={maxClashes}.");
            }

            return new
            {
                status = "Ok",
                action = "interference_basic",
                generatedAt = DateTime.UtcNow.ToString("o"),
                scope = new
                {
                    viewId = viewScope == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(viewScope.Id),
                    viewName = viewScope?.Name
                },
                categories = new
                {
                    source = sourceCategories.Select(c => c.ToString()).ToList(),
                    target = targetCategories.Select(c => c.ToString()).ToList()
                },
                summary = new
                {
                    sourceElements = sourceElements.Count,
                    targetElements = targetElements.Count,
                    checkedSources = sourcesScanned,
                    clashesFound = clashes.Count,
                    truncated = clashes.Count >= maxClashes
                },
                clashes,
                warnings
            };
        }

        private static object RunViewBounds(Document doc, View? activeView, Params p)
        {
            var globalWarnings = new List<string>();
            var unknownCategories = new List<string>();
            var categories = ResolveCategories(p.categories, Array.Empty<BuiltInCategory>(), unknownCategories);
            if (unknownCategories.Count > 0)
            {
                globalWarnings.Add("Unknown categories ignored: " + string.Join(", ", unknownCategories));
            }

            var maxViews = Clamp(p.maxViews ?? 20, 1, 200);
            var maxFindingsPerView = Clamp(p.maxFindingsPerView ?? 200, 1, 5000);
            var maxElementsPerView = Clamp(p.maxElementsPerView ?? 10000, 100, 50000);
            var marginFeet = p.marginFeet.GetValueOrDefault(0.0);
            if (marginFeet < 0) marginFeet = 0;
            if (marginFeet > 10) marginFeet = 10;

            var views = ResolveTargetViews(doc, activeView, p, maxViews, globalWarnings);
            var viewResults = new List<object>();
            var totalFindings = 0;

            foreach (var view in views)
            {
                if (view == null) continue;

                var perViewWarnings = new List<string>();
                if (view.IsTemplate || view.ViewType == ViewType.DrawingSheet)
                {
                    perViewWarnings.Add("View skipped: templates and drawing sheets are not supported for view-bounds checks.");
                    viewResults.Add(new
                    {
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                        viewName = view.Name,
                        viewType = view.ViewType.ToString(),
                        checkedElements = 0,
                        findingsCount = 0,
                        truncated = false,
                        findings = Array.Empty<object>(),
                        warnings = perViewWarnings
                    });
                    continue;
                }

                var bounds = ResolveViewBoundsContext(doc, view);
                if (!bounds.hasCrop && !bounds.hasSection && !bounds.hasScope)
                {
                    perViewWarnings.Add("No crop/section/scope boundary found for this view.");
                    viewResults.Add(new
                    {
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                        viewName = view.Name,
                        viewType = view.ViewType.ToString(),
                        bounds = new
                        {
                            hasCropBox = false,
                            hasSectionBox = false,
                            hasScopeBox = false,
                            scopeBoxName = (string?)null
                        },
                        checkedElements = 0,
                        findingsCount = 0,
                        truncated = false,
                        findings = Array.Empty<object>(),
                        warnings = perViewWarnings
                    });
                    continue;
                }

                var findings = new List<object>();
                var checkedElements = 0;
                var truncated = false;

                foreach (var element in CollectViewElements(doc, view, categories))
                {
                    if (element == null) continue;
                    checkedElements++;
                    if (checkedElements > maxElementsPerView)
                    {
                        truncated = true;
                        perViewWarnings.Add($"Element scan truncated to maxElementsPerView={maxElementsPerView}.");
                        break;
                    }

                    if (!TryGetCheckPoint(element, view, out var point) || point == null)
                    {
                        continue;
                    }

                    var reasons = new List<string>();
                    if (bounds.cropBox != null && !IsPointInside(bounds.cropBox, point, marginFeet))
                    {
                        reasons.Add("outsideCropBox");
                    }
                    if (bounds.sectionBox != null && !IsPointInside(bounds.sectionBox, point, marginFeet))
                    {
                        reasons.Add("outsideSectionBox");
                    }
                    if (bounds.scopeBox != null && !IsPointInside(bounds.scopeBox, point, marginFeet))
                    {
                        reasons.Add("outsideScopeBox");
                    }

                    if (reasons.Count == 0) continue;

                    findings.Add(new
                    {
                        elementId = RevitBridge.Common.ElementIdCompat.GetValue(element.Id),
                        category = element.Category?.Name,
                        name = element.Name,
                        reasons,
                        point = new { x = point.X, y = point.Y, z = point.Z }
                    });

                    if (findings.Count >= maxFindingsPerView)
                    {
                        truncated = true;
                        perViewWarnings.Add($"Findings truncated to maxFindingsPerView={maxFindingsPerView}.");
                        break;
                    }
                }

                totalFindings += findings.Count;
                viewResults.Add(new
                {
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    viewName = view.Name,
                    viewType = view.ViewType.ToString(),
                    bounds = new
                    {
                        hasCropBox = bounds.hasCrop,
                        hasSectionBox = bounds.hasSection,
                        hasScopeBox = bounds.hasScope,
                        scopeBoxName = bounds.scopeBoxName
                    },
                    checkedElements = Math.Min(checkedElements, maxElementsPerView),
                    findingsCount = findings.Count,
                    truncated,
                    findings,
                    warnings = perViewWarnings
                });
            }

            return new
            {
                status = "Ok",
                action = "view_bounds",
                generatedAt = DateTime.UtcNow.ToString("o"),
                summary = new
                {
                    viewsRequested = views.Count,
                    viewsChecked = viewResults.Count,
                    totalFindings
                },
                views = viewResults,
                warnings = globalWarnings
            };
        }

        private static List<View> ResolveTargetViews(Document doc, View? activeView, Params p, int maxViews, List<string> warnings)
        {
            var viewIds = new List<long>();
            if (p.viewIds != null)
            {
                foreach (var id in p.viewIds)
                {
                    if (id > 0) viewIds.Add(id);
                }
            }
            if (p.viewId.HasValue && p.viewId.Value > 0)
            {
                viewIds.Add(p.viewId.Value);
            }

            var orderedDistinct = viewIds.Distinct().ToList();
            var views = new List<View>();
            foreach (var id in orderedDistinct)
            {
                var v = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id)) as View;
                if (v == null)
                {
                    warnings.Add($"View {id} was not found and was skipped.");
                    continue;
                }
                views.Add(v);
            }

            if (views.Count == 0 && activeView != null)
            {
                views.Add(activeView);
            }

            if (views.Count > maxViews)
            {
                views = views.Take(maxViews).ToList();
                warnings.Add($"View list truncated to maxViews={maxViews}.");
            }

            return views;
        }

        private static IEnumerable<Element> CollectViewElements(Document doc, View view, List<BuiltInCategory> categories)
        {
            var collector = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType();
            if (categories.Count > 0)
            {
                var catIds = categories
                    .Select(c => RevitBridge.Common.ElementIdCompat.Create((long)c))
                    .Cast<ElementId>()
                    .ToList();
                var filter = new ElementMulticategoryFilter(catIds);
                collector = collector.WherePasses(filter);
            }

            return collector.ToElements();
        }

        private static ViewBoundsContext ResolveViewBoundsContext(Document doc, View view)
        {
            var ctx = new ViewBoundsContext();

            try
            {
                if (view.CropBoxActive)
                {
                    var crop = view.CropBox;
                    if (crop != null) ctx.cropBox = crop;
                }
            }
            catch
            {
                // ignore
            }

            if (view is View3D view3D)
            {
                try
                {
                    if (view3D.IsSectionBoxActive)
                    {
                        var section = view3D.GetSectionBox();
                        if (section != null) ctx.sectionBox = section;
                    }
                }
                catch
                {
                    // ignore
                }
            }

            try
            {
                var scopeParam = view.get_Parameter(BuiltInParameter.VIEWER_VOLUME_OF_INTEREST_CROP);
                var scopeId = scopeParam?.AsElementId();
                if (scopeId != null && scopeId != ElementId.InvalidElementId)
                {
                    var scopeElem = doc.GetElement(scopeId);
                    var scopeBox = scopeElem?.get_BoundingBox(null);
                    if (scopeBox != null)
                    {
                        ctx.scopeBox = scopeBox;
                        ctx.scopeBoxName = scopeElem?.Name;
                    }
                }
            }
            catch
            {
                // ignore
            }

            return ctx;
        }

        private static bool TryGetCheckPoint(Element element, View view, out XYZ? point)
        {
            point = null;
            if (element == null) return false;

            try
            {
                var box = element.get_BoundingBox(view) ?? element.get_BoundingBox(null);
                if (box != null)
                {
                    point = (box.Min + box.Max) * 0.5;
                    return true;
                }
            }
            catch
            {
                // ignore
            }

            try
            {
                if (element.Location is LocationPoint lp && lp.Point != null)
                {
                    point = lp.Point;
                    return true;
                }

                if (element.Location is LocationCurve lc && lc.Curve != null)
                {
                    point = lc.Curve.Evaluate(0.5, true);
                    return point != null;
                }
            }
            catch
            {
                // ignore
            }

            return false;
        }

        private static bool IsPointInside(BoundingBoxXYZ box, XYZ point, double marginFeet)
        {
            if (box == null || point == null) return true;

            var local = point;
            try
            {
                var t = box.Transform;
                if (t != null)
                {
                    local = t.Inverse.OfPoint(point);
                }
            }
            catch
            {
                // If transform inversion fails, keep world point as best effort.
            }

            return local.X >= box.Min.X - marginFeet &&
                   local.X <= box.Max.X + marginFeet &&
                   local.Y >= box.Min.Y - marginFeet &&
                   local.Y <= box.Max.Y + marginFeet &&
                   local.Z >= box.Min.Z - marginFeet &&
                   local.Z <= box.Max.Z + marginFeet;
        }

        private static IEnumerable<Element> FallbackIntersectionsByBoundingBox(Element source, List<Element> targets, View? viewScope)
        {
            var sourceBox = TryGetBoundingBox(source, viewScope);
            if (sourceBox == null) yield break;

            foreach (var target in targets)
            {
                if (target == null || target.Id == source.Id) continue;
                var targetBox = TryGetBoundingBox(target, viewScope);
                if (targetBox == null) continue;

                if (Intersects(sourceBox, targetBox))
                {
                    yield return target;
                }
            }
        }

        private static BoundingBoxXYZ? TryGetBoundingBox(Element e, View? viewScope)
        {
            if (e == null) return null;
            try
            {
                return e.get_BoundingBox(viewScope) ?? e.get_BoundingBox(null);
            }
            catch
            {
                return null;
            }
        }

        private static bool Intersects(BoundingBoxXYZ a, BoundingBoxXYZ b)
        {
            if (!TryToWorldAabb(a, out var aMin, out var aMax)) return false;
            if (!TryToWorldAabb(b, out var bMin, out var bMax)) return false;

            return aMin.X <= bMax.X && aMax.X >= bMin.X &&
                   aMin.Y <= bMax.Y && aMax.Y >= bMin.Y &&
                   aMin.Z <= bMax.Z && aMax.Z >= bMin.Z;
        }

        private static bool TryToWorldAabb(BoundingBoxXYZ box, out XYZ min, out XYZ max)
        {
            min = XYZ.Zero;
            max = XYZ.Zero;
            if (box == null) return false;

            var points = new List<XYZ>(8);
            var xVals = new[] { box.Min.X, box.Max.X };
            var yVals = new[] { box.Min.Y, box.Max.Y };
            var zVals = new[] { box.Min.Z, box.Max.Z };

            foreach (var x in xVals)
            {
                foreach (var y in yVals)
                {
                    foreach (var z in zVals)
                    {
                        var p = new XYZ(x, y, z);
                        try
                        {
                            var t = box.Transform;
                            if (t != null) p = t.OfPoint(p);
                        }
                        catch
                        {
                            // keep local point
                        }
                        points.Add(p);
                    }
                }
            }

            if (points.Count == 0) return false;
            min = new XYZ(points.Min(p => p.X), points.Min(p => p.Y), points.Min(p => p.Z));
            max = new XYZ(points.Max(p => p.X), points.Max(p => p.Y), points.Max(p => p.Z));
            return true;
        }

        private static List<Element> CollectElementsByCategory(Document doc, View? viewScope, List<BuiltInCategory> categories)
        {
            if (categories.Count == 0) return new List<Element>();
            var catIds = categories
                .Select(c => RevitBridge.Common.ElementIdCompat.Create((long)c))
                .Cast<ElementId>()
                .ToList();

            var filter = new ElementMulticategoryFilter(catIds);
            var collector = viewScope == null
                ? new FilteredElementCollector(doc)
                : new FilteredElementCollector(doc, viewScope.Id);
            return collector
                .WhereElementIsNotElementType()
                .WherePasses(filter)
                .ToElements()
                .ToList();
        }

        private static List<BuiltInCategory> ResolveCategories(
            List<string>? requested,
            IEnumerable<BuiltInCategory> defaults,
            List<string> unknownCategories)
        {
            var result = new List<BuiltInCategory>();
            if (requested == null || requested.Count == 0)
            {
                result.AddRange(defaults);
                return result.Distinct().ToList();
            }

            foreach (var raw in requested)
            {
                var token = (raw ?? "").Trim();
                if (token.Length == 0) continue;

                if (TryResolveCategory(token, out var category))
                {
                    if (!result.Contains(category))
                    {
                        result.Add(category);
                    }
                }
                else
                {
                    unknownCategories.Add(token);
                }
            }

            return result;
        }

        private static bool TryResolveCategory(string token, out BuiltInCategory category)
        {
            if (Enum.TryParse(token, true, out category))
            {
                return true;
            }

            var normalized = NormalizeCategoryToken(token);
            if (CategoryAliases.TryGetValue(normalized, out category))
            {
                return true;
            }

            var prefixed = "OST_" + token.Replace(" ", "").Replace("-", "").Replace("/", "").Trim();
            if (Enum.TryParse(prefixed, true, out category))
            {
                return true;
            }

            category = default;
            return false;
        }

        private static string NormalizeCategoryToken(string token)
        {
            return (token ?? "")
                .Trim()
                .Replace("_", " ")
                .Replace("-", " ")
                .ToLowerInvariant();
        }

        private static string NormalizeAction(string? action)
        {
            var value = (action ?? "").Trim().ToLowerInvariant();
            if (value.Length == 0) return "interference_basic";

            if (value == "interference_basic" ||
                value == "interference" ||
                value == "clash" ||
                value == "clash_check")
            {
                return "interference_basic";
            }

            if (value == "view_bounds" ||
                value == "outside_crop_or_scope" ||
                value == "outside_crop" ||
                value == "outside_scope" ||
                value == "crop_scope_bounds")
            {
                return "view_bounds";
            }

            return value;
        }

        private static int Clamp(int value, int min, int max)
        {
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }
    }
}

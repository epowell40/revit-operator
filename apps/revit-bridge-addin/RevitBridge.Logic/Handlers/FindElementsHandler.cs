using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.Semantic;

namespace RevitBridge.Logic.Handlers
{
    public class FindElementsHandler : IRequestHandler
    {
        public sealed class SheetRegion
        {
            public double? minU { get; set; }
            public double? minV { get; set; }
            public double? maxU { get; set; }
            public double? maxV { get; set; }
        }

        public sealed class Params
        {
            // Scope
            public long? viewId { get; set; }
            public string? sheetNumber { get; set; }
            public bool includeSheetElements { get; set; } = false;
            public bool includeViewportElements { get; set; } = true;
            public List<SheetRegion>? sheetRegions { get; set; }
            public double? regionPaddingFt { get; set; }

            // Filters
            public string? category { get; set; }
            public List<string>? categories { get; set; }
            public string? typeNameContains { get; set; }
            public string? familyNameContains { get; set; }
            public string? nameContains { get; set; }
            public string? markContains { get; set; }
            public string? textContains { get; set; }
            public List<string>? identityTerms { get; set; }
            public bool physicalElementsOnly { get; set; } = false;
            public bool topLevelInstancesOnly { get; set; } = false;
            public bool expandIdentityAcronymsInParameters { get; set; } = false;

            public int? limit { get; set; } = 500;
        }

        private sealed class CandidateElement
        {
            public Element Element { get; set; } = null!;
            public ElementId? SourceViewId { get; set; }
        }

        private sealed class SearchableTextMatch
        {
            public string Text { get; set; } = "";
            public string TextNormalized { get; set; } = "";
            public string Source { get; set; } = "";
            public string? ParameterName { get; set; }
        }

        private sealed class UvRect
        {
            public double MinU { get; set; }
            public double MinV { get; set; }
            public double MaxU { get; set; }
            public double MaxV { get; set; }
        }

        private sealed class ViewportSheetMap
        {
            public long ViewId { get; set; }
            public View View { get; set; } = null!;
            public BoundingBoxXYZ CropBox { get; set; } = null!;
            public XYZ ViewCenter { get; set; } = null!;
            public XYZ SheetCenter { get; set; } = null!;
            public ViewportRotation Rotation { get; set; }
            public int Scale { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var warnings = new List<string>();

            var scopeViewId = p?.viewId;
            if (scopeViewId.HasValue && scopeViewId.Value <= 0) scopeViewId = null;

            var sheetNumber = (p?.sheetNumber ?? "").Trim();
            if (scopeViewId.HasValue && !string.IsNullOrWhiteSpace(sheetNumber))
            {
                warnings.Add("Both viewId and sheetNumber provided; using viewId scope.");
                sheetNumber = "";
            }

            var viewIds = new List<ElementId>();
            string scopeKind;
            long? sheetId = null;
            ViewSheet? sheetScope = null;
            var includeViewportElements = p?.includeViewportElements != false;

            if (scopeViewId.HasValue)
            {
                var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(scopeViewId.Value)) as View;
                if (view == null) throw new InvalidOperationException($"View {scopeViewId.Value} not found.");
                viewIds.Add(view.Id);
                scopeKind = "View";
            }
            else if (!string.IsNullOrWhiteSpace(sheetNumber))
            {
                var sheet = FindSheetByNumber(doc, sheetNumber);
                if (sheet == null) throw new InvalidOperationException($"Sheet '{sheetNumber}' not found.");
                sheetScope = sheet;
                sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id);
                scopeKind = "Sheet";

                if (includeViewportElements)
                {
                    foreach (var vid in sheet.GetAllViewports())
                    {
                        var vp = doc.GetElement(vid) as Viewport;
                        if (vp == null) continue;
                        var vId = vp.ViewId;
                        if (vId == ElementId.InvalidElementId) continue;
                        viewIds.Add(vId);
                    }
                }

                viewIds = viewIds.Distinct().ToList();

                if (viewIds.Count == 0 && !p.includeSheetElements && includeViewportElements)
                {
                    warnings.Add("Sheet has no viewports; set includeSheetElements=true to search sheet-owned elements (titleblock/annotations).");
                }
            }
            else
            {
                scopeKind = "Document";
            }

            var requestedCats = new List<string>();
            if (!string.IsNullOrWhiteSpace(p?.category)) requestedCats.Add(p.category.Trim());
            if (p?.categories != null) requestedCats.AddRange(p.categories.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()));

            var resolvedCategories = ResolveRequestedCategories(doc, requestedCats);
            var categoryIds = resolvedCategories.Select(x => x.Id).ToHashSet();
            if (requestedCats.Count > 0 && categoryIds.Count == 0)
                throw new ArgumentException("No requested category resolved to a native Revit category; refusing an unfiltered collector.");

            var nameContains = (p?.nameContains ?? "").Trim();
            var typeNameContains = (p?.typeNameContains ?? "").Trim();
            var familyNameContains = (p?.familyNameContains ?? "").Trim();
            var markContains = (p?.markContains ?? "").Trim();
            var textContains = (p?.textContains ?? "").Trim();
            var textContainsNorm = NormalizeForSearch(textContains);
            var identityTerms = (p?.identityTerms ?? new List<string>())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(8)
                .ToList();
            var includeIdentityMatches = identityTerms.Count > 0;
            if (includeIdentityMatches && identityTerms.All(term => ElementIdentitySearchUtil.Tokenize(term).Count == 0))
                throw new ArgumentException("identityTerms did not contain a searchable identity token.");
            var identityAcronyms = p?.expandIdentityAcronymsInParameters == true
                ? ElementIdentitySearchUtil.BuildAcronyms(identityTerms).ToList()
                : new List<string>();
            if (scopeKind == "Document" && !ElementIdentitySearchUtil.HasBoundedDocumentPredicate(
                categoryIds.Count,
                new[] { nameContains, typeNameContains, familyNameContains, markContains, textContains }.Concat(identityTerms)))
                throw new ArgumentException("Document-scope find-elements requires a resolved category or a bounded name, family, type, Mark, text, or identity predicate.");

            var cap = p?.limit.HasValue == true && p.limit.Value > 0 ? Math.Min(p.limit.Value, 5000) : 500;
            var includeTextMatches = !string.IsNullOrWhiteSpace(textContainsNorm);
            var includeResultItems = includeTextMatches || includeIdentityMatches || categoryIds.Count > 0
                || !string.IsNullOrWhiteSpace(nameContains) || !string.IsNullOrWhiteSpace(markContains)
                || !string.IsNullOrWhiteSpace(typeNameContains) || !string.IsNullOrWhiteSpace(familyNameContains);
            var items = new List<object>();

            if (includeTextMatches && scopeKind == "Document")
            {
                warnings.Add("textContains without viewId or sheetNumber scans the full document. Prefer a view or sheet scope when possible.");
            }

            var regionPaddingFt = p?.regionPaddingFt.HasValue == true
                ? Math.Max(0.0, Math.Min(2.0, p.regionPaddingFt.Value))
                : 0.0;
            var sheetRegions = NormalizeSheetRegions(p?.sheetRegions, regionPaddingFt);
            var useSheetRegionFilter = scopeKind == "Sheet" && sheetScope != null && sheetRegions.Count > 0;
            var viewportMapByViewId = useSheetRegionFilter
                ? BuildViewportSheetMaps(doc, sheetScope!)
                : new Dictionary<long, List<ViewportSheetMap>>();
            if (useSheetRegionFilter && viewportMapByViewId.Count == 0 && !p.includeSheetElements)
            {
                warnings.Add("sheetRegions provided but no viewport mapping was available; set includeSheetElements=true to allow sheet-owned matching.");
            }

            var ids = new List<long>();
            var seenIds = new HashSet<long>();
            var seedCategoryIds = new HashSet<long>();
            var scanned = 0;
            var scanCapReached = false;
            var identityExpansionCount = 0;
            var identityExpansionScanCapReached = false;

            foreach (var candidate in EnumerateCandidates(
                doc,
                viewIds,
                sheetId,
                includeSheetElements: p?.includeSheetElements == true,
                includeViewportElements: includeViewportElements,
                scopeKind,
                categoryIds))
            {
                var e = candidate.Element;
                scanned++;
                if (scanned > 500000)
                {
                    warnings.Add("Scan cap reached (500000); results may be incomplete. Provide scope and/or category filters.");
                    scanCapReached = true;
                    break;
                }

                if (!TryApplyIndependentFilters(
                    doc, candidate, p, categoryIds,
                    useSheetRegionFilter, sheetScope, sheetRegions, viewportMapByViewId,
                    includeTextMatches, textContainsNorm,
                    nameContains, markContains, typeNameContains, familyNameContains,
                    out var resolvedTypeName, out var resolvedFamilyName, out var resolvedMark, out var textMatch)) continue;
                ElementIdentityMatch? identityMatch = null;
                SearchableTextMatch? identityParameterMatch = null;
                if (includeIdentityMatches)
                {
                    identityMatch = ElementIdentitySearchUtil.Match(
                        new[]
                        {
                            new ElementIdentityField { Name = "name", Value = e.Name },
                            new ElementIdentityField { Name = "familyName", Value = resolvedFamilyName },
                            new ElementIdentityField { Name = "typeName", Value = resolvedTypeName },
                            new ElementIdentityField { Name = "category", Value = e.Category?.Name },
                            new ElementIdentityField { Name = "mark", Value = resolvedMark }
                        },
                        identityTerms);
                    if (!identityMatch.IsMatch) continue;
                    if (identityAcronyms.Count > 0)
                        identityParameterMatch = FindIdentityParameterAcronymMatch(e, identityAcronyms);
                }
                if (includeIdentityMatches)
                {
                    var seedCategoryId = ElementIdCompat.GetValue(e.Category?.Id);
                    if (seedCategoryId != 0) seedCategoryIds.Add(seedCategoryId);
                }

                var elementId = RevitBridge.Common.ElementIdCompat.GetValue(e.Id);
                ids.Add(elementId);
                seenIds.Add(elementId);

                if (includeResultItems)
                {
                    var nested = e as FamilyInstance;
                    items.Add(new
                    {
                        elementId,
                        category = e.Category?.Name,
                        builtInCategory = e.Category?.BuiltInCategory.ToString(),
                        name = e.Name,
                        familyName = resolvedFamilyName,
                        typeName = resolvedTypeName,
                        mark = resolvedMark,
                        superComponentId = TryGetElementIdValue(nested?.SuperComponent?.Id),
                        isNested = nested?.SuperComponent != null,
                        identityMatch = identityMatch == null ? null : new
                        {
                            score = identityMatch.Score,
                            matchedTerm = identityMatch.MatchedTerm,
                            matchedTokens = identityMatch.MatchedTokens,
                            matchedFields = identityMatch.MatchedFields
                        },
                        identityParameterEvidence = identityParameterMatch == null ? null : new
                        {
                            text = identityParameterMatch.Text,
                            textNormalized = identityParameterMatch.TextNormalized,
                            source = identityParameterMatch.Source,
                            parameterName = identityParameterMatch.ParameterName
                        },
                        matchedText = textMatch?.Text ?? identityParameterMatch?.Text,
                        matchedTextNormalized = textMatch?.TextNormalized ?? identityParameterMatch?.TextNormalized,
                        matchedTextSource = textMatch?.Source ?? identityParameterMatch?.Source,
                        matchedParameterName = textMatch?.ParameterName ?? identityParameterMatch?.ParameterName,
                        ownerViewId = TryGetElementIdValue(e.OwnerViewId),
                        sourceViewId = TryGetElementIdValue(candidate.SourceViewId)
                    });
                }

                if (ids.Count >= cap) break;
            }

            if (ids.Count < cap && identityAcronyms.Count > 0 && seedCategoryIds.Count > 0)
            {
                var expansionScanned = 0;
                foreach (var candidate in EnumerateCandidates(
                    doc,
                    viewIds,
                    sheetId,
                    includeSheetElements: p?.includeSheetElements == true,
                    includeViewportElements: includeViewportElements,
                    scopeKind,
                    categoryIds: seedCategoryIds))
                {
                    var e = candidate.Element;
                    expansionScanned++;
                    if (expansionScanned > 500000)
                    {
                        identityExpansionScanCapReached = true;
                        warnings.Add("Identity acronym expansion scan cap reached (500000); expanded results may be incomplete.");
                        break;
                    }
                    var elementId = ElementIdCompat.GetValue(e.Id);
                    if (seenIds.Contains(elementId)) continue;
                    if (!TryApplyIndependentFilters(
                        doc, candidate, p, seedCategoryIds,
                        useSheetRegionFilter, sheetScope, sheetRegions, viewportMapByViewId,
                        includeTextMatches, textContainsNorm,
                        nameContains, markContains, typeNameContains, familyNameContains,
                        out var resolvedTypeName, out var resolvedFamilyName, out var resolvedMark, out var textMatch)) continue;

                    var parameterMatch = FindIdentityParameterAcronymMatch(e, identityAcronyms);
                    if (parameterMatch == null) continue;
                    var nested = e as FamilyInstance;
                    var acronym = ElementIdentitySearchUtil.Tokenize(parameterMatch.Text)
                        .FirstOrDefault(token => identityAcronyms.Contains(token, StringComparer.OrdinalIgnoreCase));

                    ids.Add(elementId);
                    seenIds.Add(elementId);
                    identityExpansionCount++;
                    items.Add(new
                    {
                        elementId,
                        category = e.Category?.Name,
                        builtInCategory = e.Category?.BuiltInCategory.ToString(),
                        name = e.Name,
                        familyName = resolvedFamilyName,
                        typeName = resolvedTypeName,
                        mark = resolvedMark,
                        superComponentId = TryGetElementIdValue(nested?.SuperComponent?.Id),
                        isNested = nested?.SuperComponent != null,
                        identityMatch = new
                        {
                            score = 0.45,
                            matchedTerm = acronym,
                            matchedTokens = acronym == null ? new List<string>() : new List<string> { acronym },
                            matchedFields = new List<string> { $"parameter:{parameterMatch.ParameterName ?? "unknown"}" }
                        },
                        identityParameterEvidence = new
                        {
                            text = parameterMatch.Text,
                            textNormalized = parameterMatch.TextNormalized,
                            source = parameterMatch.Source,
                            parameterName = parameterMatch.ParameterName
                        },
                        matchedText = textMatch?.Text ?? parameterMatch.Text,
                        matchedTextNormalized = textMatch?.TextNormalized ?? parameterMatch.TextNormalized,
                        matchedTextSource = textMatch?.Source ?? parameterMatch.Source,
                        matchedParameterName = textMatch?.ParameterName ?? parameterMatch.ParameterName,
                        ownerViewId = TryGetElementIdValue(e.OwnerViewId),
                        sourceViewId = TryGetElementIdValue(candidate.SourceViewId)
                    });
                    if (ids.Count >= cap) break;
                }
            }

            var truncated = ids.Count >= cap;
            if (truncated) warnings.Add($"Results truncated to limit={cap}.");
            var distinctIds = ids.Distinct().OrderBy(x => x).ToList();

            return Task.FromResult<object>(new
            {
                status = "Ok",
                scope = new
                {
                    kind = scopeKind,
                    viewIds = viewIds.Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x)).OrderBy(x => x).ToList(),
                    sheetId
                },
                count = distinctIds.Count,
                elementIds = distinctIds,
                categoryFilterApplied = categoryIds.Count > 0,
                resolvedCategories = resolvedCategories.Select(x => new
                {
                    requested = x.RequestedToken,
                    categoryId = x.Id,
                    name = x.Name,
                    builtInToken = x.BuiltInToken
                }).ToList(),
                textFilterApplied = includeTextMatches,
                textSearch = includeTextMatches ? new { textContains, normalized = textContainsNorm } : null,
                identityFilterApplied = includeIdentityMatches,
                identityTerms,
                physicalElementsOnlyApplied = p?.physicalElementsOnly == true,
                topLevelInstancesOnlyApplied = p?.topLevelInstancesOnly == true,
                identityAcronymExpansionApplied = identityAcronyms.Count > 0 && seedCategoryIds.Count > 0,
                identityAcronyms,
                identitySeedCategoryIds = seedCategoryIds.OrderBy(id => id).ToList(),
                identityExpansionCount,
                items,
                sheetRegionFilterApplied = useSheetRegionFilter,
                sheetRegionCount = useSheetRegionFilter ? sheetRegions.Count : 0,
                truncated,
                scanCapReached,
                identityExpansionScanCapReached,
                itemsComplete = !truncated && !scanCapReached && !identityExpansionScanCapReached,
                warnings
            });
        }

        private static bool TryApplyIndependentFilters(
            Document doc,
            CandidateElement candidate,
            Params? p,
            IReadOnlyCollection<long> categoryIds,
            bool useSheetRegionFilter,
            ViewSheet? sheetScope,
            List<UvRect> sheetRegions,
            Dictionary<long, List<ViewportSheetMap>> viewportMapByViewId,
            bool includeTextMatches,
            string textContainsNorm,
            string nameContains,
            string markContains,
            string typeNameContains,
            string familyNameContains,
            out string? resolvedTypeName,
            out string? resolvedFamilyName,
            out string? resolvedMark,
            out SearchableTextMatch? textMatch)
        {
            var e = candidate.Element;
            resolvedTypeName = null;
            resolvedFamilyName = null;
            resolvedMark = null;
            textMatch = null;

            if (useSheetRegionFilter &&
                (sheetScope == null || !ElementMatchesAnySheetRegion(doc, e, candidate.SourceViewId, sheetScope, sheetRegions, viewportMapByViewId))) return false;
            if (includeTextMatches)
            {
                textMatch = FindSearchableTextMatch(e, textContainsNorm);
                if (textMatch == null) return false;
            }
            if (categoryIds.Count > 0 && !categoryIds.Contains(ElementIdCompat.GetValue(e.Category?.Id))) return false;
            if (p?.physicalElementsOnly == true && !IsPhysicalModelElement(e)) return false;
            if (p?.topLevelInstancesOnly == true && e is FamilyInstance nestedInstance && nestedInstance.SuperComponent != null) return false;
            TryGetTypeInfo(doc, e, out resolvedTypeName, out resolvedFamilyName);
            resolvedMark = TryGetMark(e);
            return ElementIdentitySearchUtil.MatchesIndependentIdentityFilters(
                e.Name, resolvedMark, resolvedTypeName, resolvedFamilyName,
                nameContains, markContains, typeNameContains, familyNameContains);
        }

        private static IEnumerable<CandidateElement> EnumerateCandidates(
            Document doc,
            List<ElementId> viewIds,
            long? sheetId,
            bool includeSheetElements,
            bool includeViewportElements,
            string scopeKind,
            IReadOnlyCollection<long> categoryIds)
        {
            if (scopeKind == "View")
            {
                foreach (var v in viewIds)
                {
                    foreach (var e in CreateCollector(doc, v, categoryIds))
                        yield return new CandidateElement { Element = e, SourceViewId = v };
                }
                yield break;
            }

            if (scopeKind == "Sheet")
            {
                if (includeViewportElements)
                {
                    foreach (var v in viewIds)
                    {
                        foreach (var e in CreateCollector(doc, v, categoryIds))
                            yield return new CandidateElement { Element = e, SourceViewId = v };
                    }
                }

                if (includeSheetElements && sheetId.HasValue)
                {
                    var sheetViewId = RevitBridge.Common.ElementIdCompat.Create(sheetId.Value);
                    foreach (var e in CreateCollector(doc, sheetViewId, categoryIds))
                        yield return new CandidateElement { Element = e, SourceViewId = sheetViewId };
                }

                yield break;
            }

            foreach (var e in CreateCollector(doc, null, categoryIds))
                yield return new CandidateElement { Element = e, SourceViewId = null };
        }

        private static FilteredElementCollector CreateCollector(Document doc, ElementId? viewId, IReadOnlyCollection<long> categoryIds)
        {
            var collector = viewId == null
                ? new FilteredElementCollector(doc)
                : new FilteredElementCollector(doc, viewId);
            collector.WhereElementIsNotElementType();
            if (categoryIds.Count == 0) return collector;

            var filters = categoryIds
                .Select(x => (ElementFilter)new ElementCategoryFilter(ElementIdCompat.Create(x)))
                .ToList();
            return filters.Count == 1
                ? collector.WherePasses(filters[0])
                : collector.WherePasses(new LogicalOrFilter(filters));
        }

        private static IReadOnlyList<StrictCategoryResolution> ResolveRequestedCategories(Document doc, IReadOnlyCollection<string> requested)
        {
            if (requested.Count == 0) return Array.Empty<StrictCategoryResolution>();
            var catalog = new List<StrictCategoryDescriptor>();
            foreach (Category category in doc.Settings.Categories)
            {
                var id = ElementIdCompat.GetValue(category.Id);
                var builtInToken = StrictCategoryResolver.TryGetEnumName(typeof(BuiltInCategory), id);
                catalog.Add(new StrictCategoryDescriptor
                {
                    Id = id,
                    Name = category.Name ?? string.Empty,
                    BuiltInToken = builtInToken
                });
            }
            return StrictCategoryResolver.Resolve(requested, catalog);
        }

        private static string? TryGetMark(Element e)
        {
            try
            {
                return e.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()
                    ?? e.LookupParameter("Mark")?.AsString();
            }
            catch
            {
                return null;
            }
        }

        private static bool IsPhysicalModelElement(Element e)
        {
            if (e?.Category == null || e.Category.CategoryType != CategoryType.Model) return false;
            if (TryGetElementIdValue(e.OwnerViewId).HasValue) return false;
            try
            {
                if (e.Location != null) return true;
            }
            catch { }
            try
            {
                return e.get_BoundingBox(null) != null;
            }
            catch
            {
                return false;
            }
        }

        private static SearchableTextMatch? FindIdentityParameterAcronymMatch(Element e, IReadOnlyCollection<string> acronyms)
        {
            if (e == null || acronyms == null || acronyms.Count == 0) return null;
            try
            {
                var parameterCount = 0;
                foreach (Parameter parameter in e.Parameters)
                {
                    if (parameter == null || parameter.StorageType != StorageType.String) continue;
                    if (!ElementIdentitySearchUtil.IsIdentityBearingParameterName(parameter.Definition?.Name)) continue;
                    parameterCount++;
                    if (parameterCount > 80) break;
                    var raw = (parameter.AsString() ?? "").Trim();
                    if (raw.Length == 0) continue;
                    var tokens = ElementIdentitySearchUtil.Tokenize(raw);
                    if (!tokens.Any(token => acronyms.Contains(token, StringComparer.OrdinalIgnoreCase))) continue;
                    return new SearchableTextMatch
                    {
                        Text = raw,
                        TextNormalized = ElementIdentitySearchUtil.Normalize(raw),
                        Source = "identityParameterAcronym",
                        ParameterName = parameter.Definition?.Name
                    };
                }
            }
            catch { }
            return null;
        }

        private static bool TryGetTypeInfo(Document doc, Element e, out string? typeName, out string? familyName)
        {
            typeName = null;
            familyName = null;
            try
            {
                var typeId = e.GetTypeId();
                if (typeId == ElementId.InvalidElementId) return false;
                var t = doc.GetElement(typeId) as ElementType;
                if (t == null) return false;
                typeName = t.Name;
                familyName = t is FamilySymbol fs ? fs.FamilyName : t.FamilyName;
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static ViewSheet? FindSheetByNumber(Document doc, string sheetNumber)
        {
            var q = (sheetNumber ?? "").Trim();
            if (q.Length == 0) return null;
            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .FirstOrDefault(s => (s.SheetNumber ?? "").Trim().Equals(q, StringComparison.OrdinalIgnoreCase));
        }

        private static List<UvRect> NormalizeSheetRegions(List<SheetRegion>? raw, double paddingFt)
        {
            var outRegions = new List<UvRect>();
            if (raw == null || raw.Count == 0) return outRegions;

            foreach (var r in raw)
            {
                if (r == null) continue;
                if (!r.minU.HasValue || !r.minV.HasValue || !r.maxU.HasValue || !r.maxV.HasValue) continue;
                var minU = Math.Min(r.minU.Value, r.maxU.Value) - paddingFt;
                var minV = Math.Min(r.minV.Value, r.maxV.Value) - paddingFt;
                var maxU = Math.Max(r.minU.Value, r.maxU.Value) + paddingFt;
                var maxV = Math.Max(r.minV.Value, r.maxV.Value) + paddingFt;
                if (!IsFinite(minU) || !IsFinite(minV) || !IsFinite(maxU) || !IsFinite(maxV)) continue;
                if (maxU <= minU || maxV <= minV) continue;
                outRegions.Add(new UvRect
                {
                    MinU = minU,
                    MinV = minV,
                    MaxU = maxU,
                    MaxV = maxV
                });
                if (outRegions.Count >= 120) break;
            }

            return outRegions;
        }

        private static Dictionary<long, List<ViewportSheetMap>> BuildViewportSheetMaps(Document doc, ViewSheet sheet)
        {
            var outMap = new Dictionary<long, List<ViewportSheetMap>>();
            foreach (var vpId in sheet.GetAllViewports())
            {
                var vp = doc.GetElement(vpId) as Viewport;
                if (vp == null) continue;
                var view = doc.GetElement(vp.ViewId) as View;
                if (view == null) continue;

                BoundingBoxXYZ? crop;
                try { crop = view.CropBox; }
                catch { crop = null; }
                if (crop == null) continue;

                Outline? o;
                XYZ? center;
                try
                {
                    o = vp.GetBoxOutline();
                    center = vp.GetBoxCenter();
                }
                catch
                {
                    o = null;
                    center = null;
                }

                if (o == null || center == null) continue;

                var viewCenter = (crop.Min + crop.Max) * 0.5;
                var scale = view.Scale;
                if (scale <= 0) scale = 1;
                var key = RevitBridge.Common.ElementIdCompat.GetValue(vp.ViewId);
                if (key <= 0) continue;

                if (!outMap.TryGetValue(key, out var list))
                {
                    list = new List<ViewportSheetMap>();
                    outMap[key] = list;
                }

                list.Add(new ViewportSheetMap
                {
                    ViewId = key,
                    View = view,
                    CropBox = crop,
                    ViewCenter = viewCenter,
                    SheetCenter = center,
                    Rotation = vp.Rotation,
                    Scale = scale
                });
            }
            return outMap;
        }

        private static bool ElementMatchesAnySheetRegion(
            Document doc,
            Element e,
            ElementId? sourceViewId,
            ViewSheet sheet,
            List<UvRect> regions,
            Dictionary<long, List<ViewportSheetMap>> viewportMapByViewId)
        {
            if (regions.Count == 0) return true;
            if (!TryBuildElementSheetRect(doc, e, sourceViewId, sheet, viewportMapByViewId, out var rect)) return false;
            for (var i = 0; i < regions.Count; i++)
            {
                if (RectIntersects(rect, regions[i])) return true;
            }
            return false;
        }

        private static bool TryBuildElementSheetRect(
            Document doc,
            Element e,
            ElementId? sourceViewId,
            ViewSheet sheet,
            Dictionary<long, List<ViewportSheetMap>> viewportMapByViewId,
            out UvRect rect)
        {
            rect = new UvRect();
            if (e == null) return false;

            if (e is Viewport vp)
            {
                try
                {
                    var o = vp.GetBoxOutline();
                    rect = NormalizeRect(new UvRect
                    {
                        MinU = o.MinimumPoint.X,
                        MinV = o.MinimumPoint.Y,
                        MaxU = o.MaximumPoint.X,
                        MaxV = o.MaximumPoint.Y
                    });
                    return true;
                }
                catch { }
            }

            try
            {
                var bbSheet = e.get_BoundingBox(sheet);
                if (bbSheet != null && TryRectFromBbox(bbSheet, out rect)) return true;
            }
            catch { }

            var maps = new List<ViewportSheetMap>();
            AddViewportMapsFromViewId(sourceViewId, viewportMapByViewId, maps);

            try
            {
                var owner = e.OwnerViewId;
                AddViewportMapsFromViewId(owner, viewportMapByViewId, maps);
            }
            catch { }

            if (maps.Count == 0)
            {
                foreach (var kv in viewportMapByViewId)
                {
                    maps.AddRange(kv.Value);
                    if (maps.Count >= 12) break;
                }
            }

            for (var i = 0; i < maps.Count; i++)
            {
                if (TryProjectElementBoundingBoxToSheet(e, maps[i], out rect)) return true;
            }

            for (var i = 0; i < maps.Count; i++)
            {
                if (TryProjectElementLocationToSheet(e, maps[i], out rect)) return true;
            }

            return false;
        }

        private static void AddViewportMapsFromViewId(
            ElementId? maybeViewId,
            Dictionary<long, List<ViewportSheetMap>> viewportMapByViewId,
            List<ViewportSheetMap> output)
        {
            if (maybeViewId == null) return;
            if (maybeViewId == ElementId.InvalidElementId) return;
            var key = RevitBridge.Common.ElementIdCompat.GetValue(maybeViewId);
            if (key <= 0) return;
            if (!viewportMapByViewId.TryGetValue(key, out var maps) || maps == null || maps.Count == 0) return;
            for (var i = 0; i < maps.Count; i++)
            {
                if (!output.Contains(maps[i])) output.Add(maps[i]);
            }
        }

        private static bool TryProjectElementBoundingBoxToSheet(Element e, ViewportSheetMap map, out UvRect rect)
        {
            rect = new UvRect();
            BoundingBoxXYZ? bbView;
            try { bbView = e.get_BoundingBox(map.View); }
            catch { bbView = null; }
            if (bbView == null) return false;

            var corners = new[]
            {
                new XYZ(bbView.Min.X, bbView.Min.Y, bbView.Min.Z),
                new XYZ(bbView.Min.X, bbView.Min.Y, bbView.Max.Z),
                new XYZ(bbView.Min.X, bbView.Max.Y, bbView.Min.Z),
                new XYZ(bbView.Min.X, bbView.Max.Y, bbView.Max.Z),
                new XYZ(bbView.Max.X, bbView.Min.Y, bbView.Min.Z),
                new XYZ(bbView.Max.X, bbView.Min.Y, bbView.Max.Z),
                new XYZ(bbView.Max.X, bbView.Max.Y, bbView.Min.Z),
                new XYZ(bbView.Max.X, bbView.Max.Y, bbView.Max.Z)
            };

            var gotAny = false;
            var minU = double.PositiveInfinity;
            var minV = double.PositiveInfinity;
            var maxU = double.NegativeInfinity;
            var maxV = double.NegativeInfinity;

            for (var i = 0; i < corners.Length; i++)
            {
                if (!TryProjectModelToSheet(corners[i], map, out var u, out var v)) continue;
                gotAny = true;
                if (u < minU) minU = u;
                if (v < minV) minV = v;
                if (u > maxU) maxU = u;
                if (v > maxV) maxV = v;
            }

            if (!gotAny) return false;
            if (!IsFinite(minU) || !IsFinite(minV) || !IsFinite(maxU) || !IsFinite(maxV)) return false;

            rect = NormalizeRect(new UvRect
            {
                MinU = minU,
                MinV = minV,
                MaxU = maxU,
                MaxV = maxV
            });

            return true;
        }

        private static bool TryProjectElementLocationToSheet(Element e, ViewportSheetMap map, out UvRect rect)
        {
            rect = new UvRect();
            XYZ? model = null;
            try
            {
                if (e.Location is LocationPoint lp)
                {
                    model = lp.Point;
                }
                else if (e.Location is LocationCurve lc)
                {
                    var c = lc.Curve;
                    model = c?.Evaluate(0.5, true);
                }
            }
            catch
            {
                model = null;
            }
            if (model == null) return false;
            if (!TryProjectModelToSheet(model, map, out var u, out var v)) return false;

            const double eps = 0.01; // ~1/8"
            rect = new UvRect
            {
                MinU = u - eps,
                MinV = v - eps,
                MaxU = u + eps,
                MaxV = v + eps
            };
            return true;
        }

        private static bool TryProjectModelToSheet(XYZ modelPoint, ViewportSheetMap map, out double u, out double v)
        {
            u = 0;
            v = 0;
            if (map == null || map.CropBox == null) return false;

            XYZ inView;
            try { inView = map.CropBox.Transform.Inverse.OfPoint(modelPoint); }
            catch { return false; }

            var dvX = inView.X - map.ViewCenter.X;
            var dvY = inView.Y - map.ViewCenter.Y;

            double rx, ry;
            if (map.Rotation == ViewportRotation.None)
            {
                rx = dvX;
                ry = dvY;
            }
            else if (map.Rotation == ViewportRotation.Clockwise)
            {
                rx = dvY;
                ry = -dvX;
            }
            else if (map.Rotation == ViewportRotation.Counterclockwise)
            {
                rx = -dvY;
                ry = dvX;
            }
            else
            {
                rx = dvX;
                ry = dvY;
            }

            var scale = map.Scale <= 0 ? 1.0 : (double)map.Scale;
            u = map.SheetCenter.X + (rx / scale);
            v = map.SheetCenter.Y + (ry / scale);
            return IsFinite(u) && IsFinite(v);
        }

        private static bool TryRectFromBbox(BoundingBoxXYZ bb, out UvRect rect)
        {
            rect = new UvRect();
            if (bb == null) return false;
            rect = NormalizeRect(new UvRect
            {
                MinU = bb.Min.X,
                MinV = bb.Min.Y,
                MaxU = bb.Max.X,
                MaxV = bb.Max.Y
            });
            return IsFinite(rect.MinU) && IsFinite(rect.MinV) && IsFinite(rect.MaxU) && IsFinite(rect.MaxV);
        }

        private static UvRect NormalizeRect(UvRect rect)
        {
            var minU = Math.Min(rect.MinU, rect.MaxU);
            var minV = Math.Min(rect.MinV, rect.MaxV);
            var maxU = Math.Max(rect.MinU, rect.MaxU);
            var maxV = Math.Max(rect.MinV, rect.MaxV);

            // Keep line/point-like geometry matchable against sheet regions.
            const double eps = 1e-4;
            if (maxU - minU < eps)
            {
                minU -= eps * 0.5;
                maxU += eps * 0.5;
            }
            if (maxV - minV < eps)
            {
                minV -= eps * 0.5;
                maxV += eps * 0.5;
            }

            return new UvRect
            {
                MinU = minU,
                MinV = minV,
                MaxU = maxU,
                MaxV = maxV
            };
        }

        private static bool RectIntersects(UvRect a, UvRect b)
        {
            const double eps = 1e-6;
            return !(a.MaxU < b.MinU - eps || a.MinU > b.MaxU + eps || a.MaxV < b.MinV - eps || a.MinV > b.MaxV + eps);
        }

        private static bool IsFinite(double v)
        {
            return !double.IsNaN(v) && !double.IsInfinity(v);
        }

        private static SearchableTextMatch? FindSearchableTextMatch(Element e, string containsNorm)
        {
            if (string.IsNullOrWhiteSpace(containsNorm) || e == null) return null;

            foreach (var candidate in EnumerateSearchableText(e))
            {
                if (candidate.TextNormalized.IndexOf(containsNorm, StringComparison.OrdinalIgnoreCase) >= 0)
                    return candidate;
            }

            return null;
        }

        private static IEnumerable<SearchableTextMatch> EnumerateSearchableText(Element e)
        {
            var results = new List<SearchableTextMatch>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            void AddCandidate(string? text, string source, string? parameterName = null)
            {
                var raw = (text ?? "").Trim();
                if (raw.Length == 0) return;
                var normalized = NormalizeForSearch(raw);
                if (normalized.Length == 0) return;

                var key = $"{source}|{parameterName ?? ""}|{normalized}";
                if (!seen.Add(key)) return;

                results.Add(new SearchableTextMatch
                {
                    Text = raw,
                    TextNormalized = normalized,
                    Source = source,
                    ParameterName = parameterName
                });
            }

            try
            {
                if (e is TextElement textElement)
                    AddCandidate(textElement.Text, "text");
            }
            catch { }

            try
            {
                if (e is IndependentTag tag)
                    AddCandidate(tag.TagText, "tagText");
            }
            catch { }

            try
            {
                var parameterCount = 0;
                foreach (Parameter param in e.Parameters)
                {
                    if (param == null || param.StorageType != StorageType.String) continue;
                    var value = param.AsString();
                    if (string.IsNullOrWhiteSpace(value)) continue;

                    var definitionName = param.Definition?.Name;
                    AddCandidate(value, "parameter", string.IsNullOrWhiteSpace(definitionName) ? null : definitionName.Trim());

                    parameterCount++;
                    if (parameterCount >= 40) break;
                }
            }
            catch { }

            return results;
        }

        private static string NormalizeForSearch(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var chars = s.Replace("\r\n", "\n").Replace('\r', '\n').ToCharArray();
            var outChars = new System.Text.StringBuilder(chars.Length);
            var inWhitespace = false;
            foreach (var c in chars)
            {
                var keep = char.IsLetterOrDigit(c);
                if (!keep)
                {
                    if (!inWhitespace)
                    {
                        outChars.Append(' ');
                        inWhitespace = true;
                    }
                    continue;
                }

                inWhitespace = false;
                outChars.Append(char.ToLowerInvariant(c));
            }

            return outChars.ToString().Trim();
        }

        private static long? TryGetElementIdValue(ElementId? id)
        {
            if (id == null || id == ElementId.InvalidElementId) return null;
            var value = RevitBridge.Common.ElementIdCompat.GetValue(id);
            return value > 0 ? value : null;
        }
    }
}


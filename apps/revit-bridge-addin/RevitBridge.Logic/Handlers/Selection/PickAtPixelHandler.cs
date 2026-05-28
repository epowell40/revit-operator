using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class PickAtPixelHandler : IRequestHandler
    {
        public class Params
        {
            public string frameId { get; set; } = "";
            public int xPx { get; set; }
            public int yPx { get; set; }

            // Legacy (v0): kept for backwards compatibility.
            public List<string>? categories { get; set; }
            public double searchRadiusModel { get; set; } = 0.35;
            public int maxCandidates { get; set; } = 10;
            public List<string>? preferCategories { get; set; }
            public bool includeLinked { get; set; } = true;
            public bool preferViewLevel { get; set; } = false;

            // v1: robust, category-aware picking.
            public List<string>? includeCategories { get; set; }
            public List<string>? excludeCategories { get; set; }
            public string prefer { get; set; } = "modelGeometry"; // modelGeometry | annotation | any
            public int maxHits { get; set; } = 5;
        }

        private sealed class Candidate
        {
            public Element element { get; set; } = null!;
            public double score { get; set; }
            public string? category { get; set; }
            public string? categoryType { get; set; }
            public bool bboxContains { get; set; }
            public double bboxArea2d { get; set; }
            public bool viewLevelMatch { get; set; }

            public double distanceWorldFt { get; set; }
            public double distancePx { get; set; }
            public double bboxDistanceWorldFt { get; set; }
            public double? geometryDistanceWorldFt { get; set; }
            public string why { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");
            if (string.IsNullOrWhiteSpace(p.frameId)) throw new ArgumentException("Missing required parameter: frameId");

            if (!FrameStore.TryGet(p.frameId, out var frame) || frame == null)
                throw new ArgumentException($"Unknown or expired frameId '{p.frameId}'. Re-run export-view-frame.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new Exception("No active UI document.");
            var doc = uidoc.Document;

            var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(frame.viewId)) as View;
            if (view == null) throw new ArgumentException($"View {frame.viewId} not found.");

            var pickPoint = SelectionUtil.PixelToModel(p.xPx, p.yPx, frame.widthPx, frame.heightPx, frame.topLeft, frame.topRight, frame.bottomLeft);

            var warnings = new List<string>();

            // Back-compat: if includeCategories not provided, use legacy categories.
            var includeCatsRaw = (p.includeCategories != null && p.includeCategories.Count > 0) ? p.includeCategories : p.categories;
            var excludeCatsRaw = p.excludeCategories;

            SelectionUtil.TryParseBuiltInCategories(includeCatsRaw, out var includeBics, out var invalidInclude);
            SelectionUtil.TryParseBuiltInCategories(excludeCatsRaw, out var excludeBics, out var invalidExclude);

            var invalidCats = invalidInclude.Concat(invalidExclude).Distinct().ToList();
            if (invalidCats.Count > 0)
                warnings.Add($"Unrecognized categories ignored: {string.Join(", ", invalidCats)}");

            FilteredElementCollector collector;
            try
            {
                collector = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType();
            }
            catch
            {
                collector = new FilteredElementCollector(doc).WhereElementIsNotElementType().WherePasses(new ElementOwnerViewFilter(view.Id));
            }

            // Fast pre-filter for BuiltInCategories when provided.
            if (includeBics.Count > 0)
            {
                var bicList = includeBics.Select(c => RevitBridge.Common.ElementIdCompat.Create((long)c)).ToList();
                collector = collector.WherePasses(new ElementMulticategoryFilter(bicList));
            }

            var xAxis = (frame.topRight - frame.topLeft).Normalize();
            var yAxis = (frame.bottomLeft - frame.topLeft).Normalize();
            var origin = frame.topLeft;
            var pickX = (pickPoint - origin).DotProduct(xAxis);
            var pickY = (pickPoint - origin).DotProduct(yAxis);

            var worldPerPxX = (frame.topRight - frame.topLeft).GetLength() / Math.Max(1.0, frame.widthPx - 1.0);
            var worldPerPxY = (frame.bottomLeft - frame.topLeft).GetLength() / Math.Max(1.0, frame.heightPx - 1.0);

            bool CategoryTokenMatches(string? token, IEnumerable<string>? filter)
            {
                if (token == null || filter == null) return false;
                foreach (var s in filter)
                {
                    if (string.IsNullOrWhiteSpace(s)) continue;
                    if (string.Equals(s.Trim(), token, StringComparison.OrdinalIgnoreCase)) return true;
                }
                return false;
            }

            bool IsViewLevelMatch(Element e)
            {
                if (!p.preferViewLevel) return false;
                if (view is not ViewPlan vp) return false;
                Level? lvl = null;
                try { lvl = vp.GenLevel; } catch { lvl = null; }
                if (lvl == null) return false;
                try { return e.LevelId != ElementId.InvalidElementId && e.LevelId == lvl.Id; }
                catch { return false; }
            }

            bool PreferAllows(Element e, string preferToken)
            {
                var catType = e.Category?.CategoryType;
                if (string.Equals(preferToken, "any", StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(preferToken, "annotation", StringComparison.OrdinalIgnoreCase))
                    return catType == CategoryType.Annotation;

                // modelGeometry (default)
                if (catType == null) return true;
                return catType == CategoryType.Model || catType == CategoryType.AnalyticalModel;
            }

            (double x, double y) ProjectToView2d(XYZ pt)
            {
                var v = pt - origin;
                return (v.DotProduct(xAxis), v.DotProduct(yAxis));
            }

            bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

            (double distance, bool contains, double area2d, double insideDepth) Bbox2dInfo(Element e)
            {
                BoundingBoxXYZ? bbox = null;
                try { bbox = e.get_BoundingBox(view); } catch { bbox = null; }
                if (bbox == null) return (double.PositiveInfinity, false, double.PositiveInfinity, 0.0);

                var min = bbox.Min;
                var max = bbox.Max;
                var corners = new[]
                {
                    new XYZ(min.X, min.Y, min.Z),
                    new XYZ(min.X, min.Y, max.Z),
                    new XYZ(min.X, max.Y, min.Z),
                    new XYZ(min.X, max.Y, max.Z),
                    new XYZ(max.X, min.Y, min.Z),
                    new XYZ(max.X, min.Y, max.Z),
                    new XYZ(max.X, max.Y, min.Z),
                    new XYZ(max.X, max.Y, max.Z),
                };

                double minX = double.PositiveInfinity, minY = double.PositiveInfinity;
                double maxX = double.NegativeInfinity, maxY = double.NegativeInfinity;
                foreach (var c in corners)
                {
                    var (cx, cy) = ProjectToView2d(c);
                    minX = Math.Min(minX, cx);
                    minY = Math.Min(minY, cy);
                    maxX = Math.Max(maxX, cx);
                    maxY = Math.Max(maxY, cy);
                }

                if (!IsFinite(minX) || !IsFinite(minY) || !IsFinite(maxX) || !IsFinite(maxY))
                    return (double.PositiveInfinity, false, double.PositiveInfinity, 0.0);

                var contains = pickX >= minX && pickX <= maxX && pickY >= minY && pickY <= maxY;

                var dx = 0.0;
                if (pickX < minX) dx = minX - pickX;
                else if (pickX > maxX) dx = pickX - maxX;

                var dy = 0.0;
                if (pickY < minY) dy = minY - pickY;
                else if (pickY > maxY) dy = pickY - maxY;

                var d = Math.Sqrt(dx * dx + dy * dy);
                var area2d = Math.Max(0.0, (maxX - minX) * (maxY - minY));
                var insideDepth = contains ? Math.Min(Math.Min(pickX - minX, maxX - pickX), Math.Min(pickY - minY, maxY - pickY)) : 0.0;

                return (d, contains, area2d, insideDepth);
            }

            double Distance2dPx(double dxWorldFt, double dyWorldFt)
            {
                var dxPx = worldPerPxX > 1e-12 ? (dxWorldFt / worldPerPxX) : 0.0;
                var dyPx = worldPerPxY > 1e-12 ? (dyWorldFt / worldPerPxY) : 0.0;
                var d = Math.Sqrt(dxPx * dxPx + dyPx * dyPx);
                if (!IsFinite(d)) return double.PositiveInfinity;
                return d;
            }

            double? GeometryDistance2dWorldFt(Element e, out XYZ closest, out string why)
            {
                closest = null;
                why = "";

                try
                {
                    if (e.Location is LocationCurve lc)
                    {
                        var proj = lc.Curve.Project(pickPoint);
                        if (proj != null)
                        {
                            closest = proj.XYZPoint;
                            why = "location_curve_project";
                            var (cx, cy) = ProjectToView2d(closest);
                            var dx = pickX - cx;
                            var dy = pickY - cy;
                            return Math.Sqrt(dx * dx + dy * dy);
                        }
                    }

                    if (e.Location is LocationPoint lp)
                    {
                        closest = lp.Point;
                        why = "location_point";
                        var (cx, cy) = ProjectToView2d(closest);
                        var dx = pickX - cx;
                        var dy = pickY - cy;
                        return Math.Sqrt(dx * dx + dy * dy);
                    }
                }
                catch
                {
                    // fall through
                }

                return null;
            }

            var preferToken = (p.prefer ?? "modelGeometry").Trim();

            var candidates = new List<Candidate>();
            foreach (var e in collector)
            {
                if (e == null) continue;
                if (!p.includeLinked && e is RevitLinkInstance) continue;

                var catToken = SelectionUtil.GetCategoryToken(e);

                // Strict category include/exclude (token-based), for deterministic picking.
                if (includeCatsRaw != null && includeCatsRaw.Count > 0 && !CategoryTokenMatches(catToken, includeCatsRaw))
                    continue;
                if (excludeCatsRaw != null && excludeCatsRaw.Count > 0 && CategoryTokenMatches(catToken, excludeCatsRaw))
                    continue;

                var (bboxDist, contains, area2d, insideDepth) = Bbox2dInfo(e);
                if (double.IsInfinity(bboxDist)) continue;
                if (!contains && bboxDist > Math.Max(0.0, p.searchRadiusModel)) continue;

                var viewLevelMatch = IsViewLevelMatch(e);
                var allowedByPrefer = PreferAllows(e, preferToken);

                var geomDist = GeometryDistance2dWorldFt(e, out var closest, out var geomWhy);
                var distWorld = geomDist ?? bboxDist;

                var proximity = (distWorld <= 1e-12) ? 1.0 : (1.0 / (1.0 + distWorld));
                var areaScore = (area2d <= 0.0 || double.IsInfinity(area2d)) ? 0.0 : (1.0 / (1.0 + Math.Sqrt(area2d)));
                var insideDepthScore = contains ? (insideDepth / (insideDepth + 1.0)) : 0.0;

                var score = proximity;
                if (contains) score += 0.10;
                score += 0.08 * areaScore;
                if (contains) score += 0.03 * insideDepthScore;
                if (viewLevelMatch) score += 0.05;

                if (!string.Equals(preferToken, "any", StringComparison.OrdinalIgnoreCase))
                {
                    if (allowedByPrefer) score += 0.06;
                    else score -= 0.06;
                }

                if (p.preferCategories != null && catToken != null)
                {
                    if (p.preferCategories.Any(pc => string.Equals(pc, catToken, StringComparison.OrdinalIgnoreCase)))
                        score += 0.05;
                }

                score = Math.Max(0.0, Math.Min(1.0, score));

                var dxWorld = distWorld;
                var dyWorld = 0.0;
                if (closest != null)
                {
                    var (cx, cy) = ProjectToView2d(closest);
                    dxWorld = pickX - cx;
                    dyWorld = pickY - cy;
                }
                else
                {
                    // Best-effort px distance from bbox-only distance.
                    dxWorld = distWorld;
                    dyWorld = 0.0;
                }

                var distancePx = Distance2dPx(dxWorld, dyWorld);

                candidates.Add(new Candidate
                {
                    element = e,
                    score = score,
                    category = catToken,
                    categoryType = e.Category != null ? e.Category.CategoryType.ToString() : null,
                    bboxContains = contains,
                    bboxArea2d = area2d,
                    viewLevelMatch = viewLevelMatch,
                    distanceWorldFt = distWorld,
                    distancePx = distancePx,
                    bboxDistanceWorldFt = bboxDist,
                    geometryDistanceWorldFt = geomDist,
                    why = geomDist.HasValue ? geomWhy : (contains ? "contains_bbox" : "nearest_bbox_edge")
                });
            }

            if (includeCatsRaw != null && includeCatsRaw.Count > 0 && candidates.Count == 0)
            {
                return Task.FromResult<object>(new
                {
                    best = (object?)null,
                    hits = new List<object>(),
                    candidates = new List<object>(),
                    pickPointXyz = new[] { pickPoint.X, pickPoint.Y, pickPoint.Z },
                    noHit = new { reason = "NoValidHit", detail = "No elements matched includeCategories near the requested pixel." },
                    warnings
                });
            }

            var take = Math.Max(1, Math.Min(Math.Max(1, p.maxCandidates), Math.Max(1, p.maxHits)));
            var ranked = candidates
                .OrderByDescending(c => c.score)
                .ThenByDescending(c => c.bboxContains)
                .ThenByDescending(c => c.viewLevelMatch)
                .ThenBy(c => c.bboxArea2d)
                .ThenBy(c => c.distanceWorldFt)
                .Take(take)
                .ToList();

            if (ranked.Count > 1 && Math.Abs(ranked[0].score - ranked[1].score) < 0.05)
                warnings.Add("Overlapping candidates; returning top-N.");

            object? best = null;
            if (ranked.Count > 0)
            {
                var b = ranked[0];
                best = new
                {
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(b.element.Id),
                    score = b.score,
                    category = b.category,
                    reason = b.why
                };
            }

            var hits = ranked.Take(Math.Max(1, p.maxHits)).Select((c, i) =>
            {
                long? elementId = null;
                long? linkInstanceId = null;
                if (c.element is RevitLinkInstance)
                    linkInstanceId = RevitBridge.Common.ElementIdCompat.GetValue(c.element.Id);
                else
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(c.element.Id);

                return new
                {
                    rank = i + 1,
                    elementId,
                    linkInstanceId,
                    category = c.category,
                    categoryType = c.categoryType,
                    isElementType = false,
                    distancePx = c.distancePx,
                    distanceWorldFt = c.distanceWorldFt,
                    score = c.score,
                    why = c.why,
                    bboxContains = c.bboxContains,
                    bboxArea2d = c.bboxArea2d,
                    viewLevelMatch = c.viewLevelMatch,
                    debug = new
                    {
                        bboxDistanceWorldFt = c.bboxDistanceWorldFt,
                        geometryDistanceWorldFt = c.geometryDistanceWorldFt
                    }
                };
            }).ToList();

            // Legacy response shape: keep `candidates` (subset) for existing callers.
            var outCandidates = hits.Select(h => new
            {
                elementId = h.elementId,
                linkInstanceId = h.linkInstanceId,
                score = h.score,
                category = h.category,
                distance = h.distanceWorldFt,
                bboxContains = h.bboxContains,
                bboxArea2d = h.bboxArea2d,
                viewLevelMatch = h.viewLevelMatch
            }).ToList();

            return Task.FromResult<object>(new
            {
                best,
                hits,
                candidates = outCandidates,
                pickPointXyz = new[] { pickPoint.X, pickPoint.Y, pickPoint.Z },
                warnings
            });
        }
    }
}

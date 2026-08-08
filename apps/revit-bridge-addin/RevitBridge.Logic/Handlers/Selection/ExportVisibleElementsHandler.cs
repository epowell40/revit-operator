using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.Core;

namespace RevitBridge.Logic.Handlers
{
    public class ExportVisibleElementsHandler : IRequestHandler
    {
        private sealed class PixelProjection
        {
            public double X { get; set; }
            public double Y { get; set; }
            public double NormalizedX { get; set; }
            public double NormalizedY { get; set; }
            public bool InsideFrame { get; set; }
        }

        private sealed class HostProvenanceResolution
        {
            public string Source { get; set; } = "none";
            public long? HostId { get; set; }
            public string? HostScopedId { get; set; }
            public string? HostCategory { get; set; }
            public string? HostBuiltInCategory { get; set; }
            public string? HostName { get; set; }
            public long? LinkInstanceId { get; set; }
            public string? LinkInstanceName { get; set; }
            public string? LinkDocumentTitle { get; set; }
            public string? LinkDocumentPath { get; set; }
            public long? LinkedElementId { get; set; }
            public string? LinkedElementScopedId { get; set; }
        }

        public sealed class Params
        {
            public long? viewId { get; set; }
            public int imageSize { get; set; } = 2200;
            public string folder { get; set; } = "";
            public bool includeMapping { get; set; } = true;
            public List<string>? categories { get; set; }
            public List<string>? excludeCategories { get; set; }
            public bool includeGeometry { get; set; } = true;
            public bool includeLinked { get; set; } = true;
            public List<double>? modelBounds { get; set; }
            public int? limit { get; set; } = 500;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            View? view = null;
            if (p.viewId.HasValue && p.viewId.Value > 0)
            {
                view = doc.GetElement(ElementIdCompat.Create(p.viewId.Value)) as View;
            }
            else
            {
                view = doc.ActiveView;
            }

            if (view == null) throw new InvalidOperationException("View not found.");
            if (!SelectionUtil.IsSupported2dView(view))
                throw new ArgumentException($"View type '{view.ViewType}' is not supported for export-visible-elements.");

            var warnings = new List<string>();
            var restoreCropBoxActive = false;
            EnsureCropBoxActiveForInventoryExport(doc, view, warnings, out restoreCropBoxActive);

            try
            {
                var folder = SelectionUtil.EnsureDefaultSelectionCaptureFolder(p.folder);
                var frameId = Guid.NewGuid().ToString("N");
                var stem = $"Revit_{ElementIdCompat.GetValue(view.Id)}_{frameId}_inventory";
                var path = SelectionUtil.ExportViewImage(doc, view, p.imageSize, folder, stem);
                var (widthPx, heightPx) = SelectionUtil.ReadImageSize(path);
                RasterAffineFrame frame;
                try
                {
                    frame = SelectionUtil.BuildRasterAffineFrameFromViewOutline(view, widthPx, heightPx);
                    if (frame.CropAspect <= 1e-9 || frame.FrameAspect <= 1e-9)
                        throw new InvalidOperationException("The view outline produced a degenerate exported-raster frame.");
                    warnings.Add("export-visible-elements mapped the fit-to-page raster from View.Outline and view basis directions.");
                }
                catch (Exception ex)
                {
                    frame = SelectionUtil.BuildRasterAffineFrame(view, widthPx, heightPx);
                    warnings.Add($"View.Outline raster mapping was unavailable; fell back to CropBox mapping ({ex.Message}).");
                }

                if (frame.AspectCorrectionApplied)
                {
                    warnings.Add(
                        $"export-visible-elements adjusted the frame X span to match the exported raster aspect (crop={frame.CropAspect:0.000000}, raster={frame.RasterAspect:0.000000}).");
                }

                var stored = new StoredViewFrame
                {
                    frameId = frameId,
                    viewId = ElementIdCompat.GetValue(view.Id),
                    viewType = view.ViewType.ToString(),
                    viewName = view.Name,
                    path = path,
                    widthPx = widthPx,
                    heightPx = heightPx,
                    topLeft = frame.TopLeft,
                    topRight = frame.TopRight,
                    bottomLeft = frame.BottomLeft,
                    createdUtc = DateTime.UtcNow
                };
                FrameStore.Put(stored);

                SelectionUtil.TryParseBuiltInCategories(p.categories, out var includeBics, out var invalidInclude);
                SelectionUtil.TryParseBuiltInCategories(p.excludeCategories, out var excludeBics, out var invalidExclude);

                var invalidCats = invalidInclude.Concat(invalidExclude).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                if (invalidCats.Count > 0)
                    warnings.Add($"Unrecognized category tokens were matched by exact category name only when possible: {string.Join(", ", invalidCats)}");

                var includeRaw = NormalizeCategoryList(p.categories);
                var excludeRaw = NormalizeCategoryList(p.excludeCategories);
                var limit = p.limit.HasValue ? Math.Max(1, Math.Min(2000, p.limit.Value)) : 500;
                var modelBounds = ResolveModelBounds(p.modelBounds);

                FilteredElementCollector collector;
                try
                {
                    collector = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType();
                }
                catch
                {
                    collector = new FilteredElementCollector(doc).WhereElementIsNotElementType().WherePasses(new ElementOwnerViewFilter(view.Id));
                    warnings.Add("View-scoped collector was unavailable; fell back to owner-view filtering.");
                }

                if (includeBics.Count > 0)
                {
                    var bicIds = includeBics.Select(x => ElementIdCompat.Create((long)x)).ToList();
                    collector = collector.WherePasses(new ElementMulticategoryFilter(bicIds));
                }
                if (modelBounds != null)
                {
                    collector = collector.WherePasses(new BoundingBoxIntersectsFilter(modelBounds));
                    warnings.Add("Visible-element inventory restricted to the requested host-model bounding box, with a bounded annotation-anchor recovery pass.");
                }

                var items = new List<object>();
                var seenScopedIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var scanned = 0;

                foreach (var e in collector)
                {
                    if (e == null) continue;
                    if (e is RevitLinkInstance) continue;
                    scanned++;

                    if (excludeBics.Count > 0 && IsInCategories(e, excludeBics)) continue;
                    if (includeRaw.Count > 0 && !MatchesCategoryFilter(e, includeRaw)) continue;
                    if (excludeRaw.Count > 0 && MatchesCategoryFilter(e, excludeRaw)) continue;

                    var scopedId = DatasetExportUtil.CreateSourceScopedId(e, null);
                    if (!seenScopedIds.Add(scopedId)) continue;
                    items.Add(BuildVisibleElementPayload(doc, view, e, null, p.includeGeometry, widthPx, heightPx, frame.TopLeft, frame.TopRight, frame.BottomLeft));

                    if (items.Count >= limit) break;
                }

                if (modelBounds != null && items.Count < limit)
                {
                    FilteredElementCollector anchorCollector;
                    try
                    {
                        anchorCollector = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType();
                    }
                    catch
                    {
                        anchorCollector = new FilteredElementCollector(doc).WhereElementIsNotElementType().WherePasses(new ElementOwnerViewFilter(view.Id));
                    }
                    if (includeBics.Count > 0)
                    {
                        var bicIds = includeBics.Select(x => ElementIdCompat.Create((long)x)).ToList();
                        anchorCollector = anchorCollector.WherePasses(new ElementMulticategoryFilter(bicIds));
                    }

                    foreach (var e in anchorCollector)
                    {
                        if (e == null || e is RevitLinkInstance) continue;
                        var scopedId = DatasetExportUtil.CreateSourceScopedId(e, null);
                        if (seenScopedIds.Contains(scopedId)) continue;
                        if (excludeBics.Count > 0 && IsInCategories(e, excludeBics)) continue;
                        if (includeRaw.Count > 0 && !MatchesCategoryFilter(e, includeRaw)) continue;
                        if (excludeRaw.Count > 0 && MatchesCategoryFilter(e, excludeRaw)) continue;

                        var anchor = ResolveAnchorPointInHostCoordinates(e, null, null);
                        if (!PointInsideModelBounds(anchor, modelBounds)) continue;
                        scanned++;
                        if (!seenScopedIds.Add(scopedId)) continue;
                        items.Add(BuildVisibleElementPayload(doc, view, e, null, p.includeGeometry, widthPx, heightPx, frame.TopLeft, frame.TopRight, frame.BottomLeft));
                        if (items.Count >= limit) break;
                    }
                }

                if (p.includeLinked && items.Count < limit)
                {
                    warnings.Add("Linked visible elements are included using transformed model geometry and best-effort crop intersection.");
                    var links = new FilteredElementCollector(doc)
                        .OfClass(typeof(RevitLinkInstance))
                        .Cast<RevitLinkInstance>()
                        .ToList();

                    foreach (var link in links)
                    {
                        Document? linkDoc = null;
                        try { linkDoc = link.GetLinkDocument(); } catch { linkDoc = null; }
                        if (linkDoc == null)
                        {
                            warnings.Add($"Linked model '{link.Name}' is unloaded or inaccessible; linked visible-element export skipped for that instance.");
                            continue;
                        }

                        var linkCollector = new FilteredElementCollector(linkDoc).WhereElementIsNotElementType();
                        if (includeBics.Count > 0)
                        {
                            var bicIds = includeBics.Select(x => ElementIdCompat.Create((long)x)).ToList();
                            linkCollector = linkCollector.WherePasses(new ElementMulticategoryFilter(bicIds));
                        }

                        foreach (var linkedElement in linkCollector)
                        {
                            if (linkedElement == null) continue;
                            scanned++;

                            if (excludeBics.Count > 0 && IsInCategories(linkedElement, excludeBics)) continue;
                            if (includeRaw.Count > 0 && !MatchesCategoryFilter(linkedElement, includeRaw)) continue;
                            if (excludeRaw.Count > 0 && MatchesCategoryFilter(linkedElement, excludeRaw)) continue;
                            if (modelBounds != null && !LinkedElementIntersectsModelBounds(linkedElement, link, modelBounds)) continue;
                            if (!ShouldIncludeLinkedElement(linkedElement, link, widthPx, heightPx, frame.TopLeft, frame.TopRight, frame.BottomLeft)) continue;

                            var scopedId = DatasetExportUtil.CreateSourceScopedId(linkedElement, link);
                            if (!seenScopedIds.Add(scopedId)) continue;
                            items.Add(BuildVisibleElementPayload(doc, view, linkedElement, link, p.includeGeometry, widthPx, heightPx, frame.TopLeft, frame.TopRight, frame.BottomLeft));

                            if (items.Count >= limit) break;
                        }

                        if (items.Count >= limit) break;
                    }
                }

                var truncated = items.Count >= limit;
                if (truncated) warnings.Add($"Results truncated to limit={limit}.");

                object? mapping = null;
                if (p.includeMapping)
                {
                    mapping = SelectionUtil.BuildRasterAffineMappingPayload(
                        frame,
                        frame.SourceFrameKind == "view_outline"
                            ? "Per-element pixel/image coordinates are derived from View.Outline, view Origin/RightDirection/UpDirection, and the same fit-to-page raster used for the saved frame."
                            : "Per-element pixel/image coordinates use the CropBox fallback because View.Outline mapping was unavailable.");
                }

                string? projectUniqueId = null;
                try { projectUniqueId = doc.ProjectInformation?.UniqueId; } catch { }
                var projectFingerprint = "sha256:" + OperatorRevitBatchBinding.ComputeProjectFingerprint(
                    doc.Title,
                    doc.PathName,
                    projectUniqueId);

                return Task.FromResult<object>(new
                {
                    document = new
                    {
                        sessionId = OperatorNativeDocumentSessionAuthority.GetSessionId(doc),
                        nativeExecutionAttestation = OperatorNativeExecutionAttestationAuthority.PublicBinding(),
                        projectIdentity = new { fingerprint = projectFingerprint },
                        activeView = new { id = ElementIdCompat.GetValue(doc.ActiveView.Id) }
                    },
                    frameId,
                    viewId = ElementIdCompat.GetValue(view.Id),
                    viewType = view.ViewType.ToString(),
                    viewName = view.Name,
                    path,
                    widthPx,
                    heightPx,
                    targetLevel = SelectionUtil.BuildTargetLevelPayload(view),
                    mapping,
                    count = items.Count,
                    scanned,
                    truncated,
                    modelBoundsApplied = modelBounds != null,
                    modelBoundsFt = modelBounds == null ? null : new
                    {
                        min = new { x = modelBounds.MinimumPoint.X, y = modelBounds.MinimumPoint.Y, z = modelBounds.MinimumPoint.Z },
                        max = new { x = modelBounds.MaximumPoint.X, y = modelBounds.MaximumPoint.Y, z = modelBounds.MaximumPoint.Z }
                    },
                    items,
                    warnings = warnings.Count > 0 ? warnings : null
                });
            }
            finally
            {
                if (restoreCropBoxActive)
                {
                    TryRestoreCropBoxActive(doc, view, warnings);
                }
            }
        }

        private static Dictionary<string, object?> BuildVisibleElementPayload(
            Document hostDocument,
            View view,
            Element element,
            RevitLinkInstance? linkInstance,
            bool includeGeometry,
            int widthPx,
            int heightPx,
            XYZ topLeft,
            XYZ topRight,
            XYZ bottomLeft)
        {
            BoundingBoxXYZ? bbox = linkInstance == null
                ? TryGetBoundingBox(element, view)
                : DatasetExportUtil.TryGetBoundingBoxInHostCoordinates(element, null, linkInstance);
            var bboxCenter = DatasetExportUtil.GetBoundingBoxCenter(bbox);
            var anchorPoint = ResolveAnchorPointInHostCoordinates(element, linkInstance, bboxCenter);
            var anchor = anchorPoint == null ? null : BuildProjectedPoint(anchorPoint, widthPx, heightPx, topLeft, topRight, bottomLeft);
            object? bboxModel = bbox == null ? null : new
            {
                min = HostedPlacementUtil.BuildVector(bbox.Min),
                max = HostedPlacementUtil.BuildVector(bbox.Max)
            };
            var bboxPayload = bbox == null ? null : BuildBoundingBoxPayload(bbox, widthPx, heightPx, topLeft, topRight, bottomLeft);
            var geometry = includeGeometry
                ? BuildGeometryPayload(element, linkInstance, widthPx, heightPx, topLeft, topRight, bottomLeft)
                : null;

            var payload = DatasetExportUtil.BuildCommonElementPayload(
                hostDocument,
                element,
                linkInstance,
                hostPointOverride: anchorPoint,
                hostBoundingBoxOverride: bbox);
            payload["elementId"] = ElementIdCompat.GetValue(element.Id);
            payload["ownerViewId"] = linkInstance == null ? TryGetElementIdValue(element.OwnerViewId) : null;
            payload["bboxModel"] = bboxModel;
            payload["anchor"] = anchor;
            payload["bbox"] = bboxPayload;
            payload["geometry"] = geometry;
            payload["categoryToken"] = SelectionUtil.GetCategoryToken(element);
            payload["orientation"] = BuildOrientationPayload(element, linkInstance);
            ApplyReadableAnnotationPayload(payload, element, linkInstance);
            ApplyHostProvenance(payload);

            return payload;
        }

        private static void ApplyReadableAnnotationPayload(
            Dictionary<string, object?> payload,
            Element element,
            RevitLinkInstance? linkInstance)
        {
            try
            {
                if (element is TextNote textNote)
                {
                    var text = textNote.Text;
                    if (!string.IsNullOrWhiteSpace(text))
                        payload["visibleText"] = text;
                }
            }
            catch { }

            try
            {
                if (element is RoomTag roomTag)
                {
                    var tagText = roomTag.TagText;
                    if (!string.IsNullOrWhiteSpace(tagText))
                        payload["visibleText"] = tagText;
                    payload["taggedSpatial"] = BuildTaggedSpatialPayload(roomTag.Room, "Room");
                }
            }
            catch { }

            try
            {
                if (element is SpaceTag spaceTag)
                {
                    var tagText = spaceTag.TagText;
                    if (!string.IsNullOrWhiteSpace(tagText))
                        payload["visibleText"] = tagText;
                    payload["taggedSpatial"] = BuildTaggedSpatialPayload(spaceTag.Space, "Space");
                }
            }
            catch { }

            try
            {
                if (element is IndependentTag independentTag)
                {
                    var tagText = independentTag.TagText;
                    if (!string.IsNullOrWhiteSpace(tagText) && !payload.ContainsKey("visibleText"))
                        payload["visibleText"] = tagText;
                }
            }
            catch { }

            var tagAnnotation = BuildTagAnnotationPayload(element, linkInstance);
            if (tagAnnotation != null)
                payload["tagAnnotation"] = tagAnnotation;
        }

        private static object? BuildTagAnnotationPayload(Element element, RevitLinkInstance? linkInstance)
        {
            if (element is not IndependentTag && element is not RoomTag && element is not SpaceTag)
                return null;

            var head = TransformNullablePointToHost(linkInstance, TryReadXyzProperty(element, "TagHeadPosition"));
            var leaderElbow = TransformNullablePointToHost(linkInstance, TryReadXyzProperty(element, "LeaderElbow"));
            var leaderEnd = TransformNullablePointToHost(linkInstance, TryReadXyzProperty(element, "LeaderEnd"));
            var hasLeader = TryReadBoolProperty(element, "HasLeader");
            var leaderEndCondition = TryReadProperty(element, "LeaderEndCondition")?.ToString();

            if (head == null && leaderElbow == null && leaderEnd == null && hasLeader == null && string.IsNullOrWhiteSpace(leaderEndCondition))
                return null;

            return new
            {
                tagHeadPosition = head == null ? null : BuildVector(head),
                hasLeader,
                leaderEndCondition,
                leaderElbow = leaderElbow == null ? null : BuildVector(leaderElbow),
                leaderEnd = leaderEnd == null ? null : BuildVector(leaderEnd)
            };
        }

        private static object? TryReadProperty(object source, string propertyName)
        {
            try
            {
                var property = source.GetType().GetProperty(propertyName);
                return property == null ? null : property.GetValue(source);
            }
            catch
            {
                return null;
            }
        }

        private static XYZ? TryReadXyzProperty(object source, string propertyName)
        {
            return TryReadProperty(source, propertyName) as XYZ;
        }

        private static bool? TryReadBoolProperty(object source, string propertyName)
        {
            var value = TryReadProperty(source, propertyName);
            return value is bool b ? b : null;
        }

        private static object? BuildTaggedSpatialPayload(SpatialElement? spatial, string kind)
        {
            if (spatial == null) return null;
            try
            {
                return new
                {
                    id = ElementIdCompat.GetValue(spatial.Id),
                    number = spatial.Number,
                    name = spatial.Name,
                    type = kind
                };
            }
            catch
            {
                return null;
            }
        }

        private static bool ShouldIncludeLinkedElement(
            Element element,
            RevitLinkInstance linkInstance,
            int widthPx,
            int heightPx,
            XYZ topLeft,
            XYZ topRight,
            XYZ bottomLeft)
        {
            var anchorPoint = ResolveAnchorPointInHostCoordinates(element, linkInstance, null);
            var anchorProjection = anchorPoint == null
                ? null
                : TryProjectPointToImage(anchorPoint, widthPx, heightPx, topLeft, topRight, bottomLeft);
            if (anchorProjection?.InsideFrame == true) return true;

            var bbox = DatasetExportUtil.TryGetBoundingBoxInHostCoordinates(element, null, linkInstance);
            if (bbox == null) return false;
            return BoundingBoxIntersectsFrame(bbox, widthPx, heightPx, topLeft, topRight, bottomLeft);
        }

        private static Outline? ResolveModelBounds(List<double>? values)
        {
            if (values == null || values.Count == 0) return null;
            if (values.Count != 6 || values.Any(value => !IsFinite(value)))
                throw new ArgumentException("modelBounds must contain exactly six finite numbers: minX,minY,minZ,maxX,maxY,maxZ.");

            var min = new XYZ(values[0], values[1], values[2]);
            var max = new XYZ(values[3], values[4], values[5]);
            if (min.X >= max.X || min.Y >= max.Y || min.Z >= max.Z)
                throw new ArgumentException("modelBounds minimum coordinates must be strictly below maximum coordinates.");
            return new Outline(min, max);
        }

        private static bool PointInsideModelBounds(XYZ? point, Outline modelBounds)
        {
            return point != null
                && point.X >= modelBounds.MinimumPoint.X && point.X <= modelBounds.MaximumPoint.X
                && point.Y >= modelBounds.MinimumPoint.Y && point.Y <= modelBounds.MaximumPoint.Y
                && point.Z >= modelBounds.MinimumPoint.Z && point.Z <= modelBounds.MaximumPoint.Z;
        }

        private static bool LinkedElementIntersectsModelBounds(
            Element element,
            RevitLinkInstance linkInstance,
            Outline modelBounds)
        {
            var bbox = DatasetExportUtil.TryGetBoundingBoxInHostCoordinates(element, null, linkInstance);
            if (bbox == null)
                return PointInsideModelBounds(
                    ResolveAnchorPointInHostCoordinates(element, linkInstance, null),
                    modelBounds);

            var corners = GetBoundingBoxWorldCorners(bbox).ToList();
            if (corners.Count == 0) return false;
            var minX = corners.Min(point => point.X);
            var minY = corners.Min(point => point.Y);
            var minZ = corners.Min(point => point.Z);
            var maxX = corners.Max(point => point.X);
            var maxY = corners.Max(point => point.Y);
            var maxZ = corners.Max(point => point.Z);
            return maxX >= modelBounds.MinimumPoint.X && minX <= modelBounds.MaximumPoint.X
                && maxY >= modelBounds.MinimumPoint.Y && minY <= modelBounds.MaximumPoint.Y
                && maxZ >= modelBounds.MinimumPoint.Z && minZ <= modelBounds.MaximumPoint.Z;
        }

        private static List<string> NormalizeCategoryList(List<string>? categories)
        {
            return (categories ?? new List<string>())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static bool MatchesCategoryFilter(Element e, List<string> filters)
        {
            if (filters.Count == 0) return true;

            var builtIn = e.Category?.BuiltInCategory.ToString() ?? "";
            var categoryName = e.Category?.Name ?? "";
            var token = SelectionUtil.GetCategoryToken(e) ?? "";

            foreach (var filter in filters)
            {
                if (string.Equals(filter, builtIn, StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(filter, categoryName, StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(filter, token, StringComparison.OrdinalIgnoreCase)) return true;
            }

            return false;
        }

        private static bool IsInCategories(Element e, List<BuiltInCategory> bics)
        {
            try
            {
                if (e?.Category?.Id == null) return false;
                var id = e.Category.Id.IntegerValue;
                foreach (var bic in bics)
                {
                    if ((int)bic == id) return true;
                }
            }
            catch { }
            return false;
        }

        private static BoundingBoxXYZ? TryGetBoundingBox(Element e, View view)
        {
            try
            {
                return e.get_BoundingBox(view) ?? e.get_BoundingBox(null);
            }
            catch
            {
                return null;
            }
        }

        private static XYZ? ResolveAnchorPoint(Element e, XYZ? bboxCenter)
        {
            var annotationPoint = TryGetAnnotationAnchorPoint(e);
            if (annotationPoint != null) return annotationPoint;

            try
            {
                if (e.Location is LocationPoint lp && lp.Point != null) return lp.Point;
            }
            catch { }

            try
            {
                if (e.Location is LocationCurve lc && lc.Curve != null)
                {
                    return lc.Curve.Evaluate(0.5, true);
                }
            }
            catch { }

            return bboxCenter;
        }

        private static XYZ? ResolveAnchorPointInHostCoordinates(
            Element element,
            RevitLinkInstance? linkInstance,
            XYZ? hostBoundingBoxCenter)
        {
            var sourcePoint = ResolveAnchorPoint(element, null);
            if (sourcePoint != null) return TransformPointToHost(linkInstance, sourcePoint);
            return hostBoundingBoxCenter;
        }

        private static XYZ? TryGetAnnotationAnchorPoint(Element element)
        {
            if (element is IndependentTag || element is RoomTag || element is SpaceTag)
                return TryReadXyzProperty(element, "TagHeadPosition");

            if (element is TextNote textNote)
            {
                try { return textNote.Coord; } catch { return null; }
            }

            return null;
        }

        private static object? BuildGeometryPayload(
            Element e,
            RevitLinkInstance? linkInstance,
            int widthPx,
            int heightPx,
            XYZ topLeft,
            XYZ topRight,
            XYZ bottomLeft)
        {
            try
            {
                var annotationPoint = TryGetAnnotationAnchorPoint(e);
                if (annotationPoint != null)
                {
                    var point = TransformPointToHost(linkInstance, annotationPoint);
                    return new
                    {
                        kind = "annotation-point",
                        point = BuildProjectedPoint(point, widthPx, heightPx, topLeft, topRight, bottomLeft)
                    };
                }

                if (e.Location is LocationPoint lp && lp.Point != null)
                {
                    var point = DatasetExportUtil.TransformPointToHost(linkInstance, lp.Point);
                    return new
                    {
                        kind = "point",
                        point = BuildProjectedPoint(point, widthPx, heightPx, topLeft, topRight, bottomLeft)
                    };
                }

                if (e.Location is LocationCurve lc && lc.Curve != null)
                {
                    var curve = lc.Curve;
                    var start = DatasetExportUtil.TransformPointToHost(linkInstance, curve.GetEndPoint(0));
                    var end = DatasetExportUtil.TransformPointToHost(linkInstance, curve.GetEndPoint(1));
                    XYZ? mid = null;
                    try { mid = DatasetExportUtil.TransformPointToHost(linkInstance, curve.Evaluate(0.5, true)); } catch { mid = (start + end) * 0.5; }

                    return new
                    {
                        kind = "curve",
                        lengthFt = curve.Length,
                        start = BuildProjectedPoint(start, widthPx, heightPx, topLeft, topRight, bottomLeft),
                        end = BuildProjectedPoint(end, widthPx, heightPx, topLeft, topRight, bottomLeft),
                        midpoint = BuildProjectedPoint(mid, widthPx, heightPx, topLeft, topRight, bottomLeft)
                    };
                }
            }
            catch { }

            return new { kind = "none" };
        }

        private static bool BoundingBoxIntersectsFrame(
            BoundingBoxXYZ bbox,
            int widthPx,
            int heightPx,
            XYZ topLeft,
            XYZ topRight,
            XYZ bottomLeft)
        {
            double minU = double.PositiveInfinity;
            double minV = double.PositiveInfinity;
            double maxU = double.NegativeInfinity;
            double maxV = double.NegativeInfinity;

            foreach (var corner in GetBoundingBoxWorldCorners(bbox))
            {
                var projection = TryProjectPointToImage(corner, widthPx, heightPx, topLeft, topRight, bottomLeft);
                if (projection == null) continue;
                minU = Math.Min(minU, projection.NormalizedX);
                minV = Math.Min(minV, projection.NormalizedY);
                maxU = Math.Max(maxU, projection.NormalizedX);
                maxV = Math.Max(maxV, projection.NormalizedY);
            }

            if (!IsFinite(minU) || !IsFinite(minV) || !IsFinite(maxU) || !IsFinite(maxV)) return false;
            return maxU >= 0.0 && maxV >= 0.0 && minU <= 1.0 && minV <= 1.0;
        }

        private static object? BuildBoundingBoxPayload(
            BoundingBoxXYZ bbox,
            int widthPx,
            int heightPx,
            XYZ topLeft,
            XYZ topRight,
            XYZ bottomLeft)
        {
            var corners = GetBoundingBoxWorldCorners(bbox).ToList();
            if (corners.Count == 0) return null;
            var minX = corners.Min(x => x.X);
            var minY = corners.Min(x => x.Y);
            var minZ = corners.Min(x => x.Z);
            var maxX = corners.Max(x => x.X);
            var maxY = corners.Max(x => x.Y);
            var maxZ = corners.Max(x => x.Z);
            var center = GetBoundingBoxWorldCenter(bbox);
            var imageRect = TryProjectBoundingBoxToRect(bbox, widthPx, heightPx, topLeft, topRight, bottomLeft);
            return new
            {
                model = new
                {
                    min = new { x = minX, y = minY, z = minZ },
                    max = new { x = maxX, y = maxY, z = maxZ },
                    center = new { x = center.X, y = center.Y, z = center.Z }
                },
                image = imageRect
            };
        }

        private static object? BuildOrientationPayload(Element e, RevitLinkInstance? linkInstance)
        {
            XYZ? facingVector = null;
            XYZ? handVector = null;
            XYZ? curveDirectionVector = null;
            XYZ? basisXVector = null;
            XYZ? basisYVector = null;
            XYZ? basisZVector = null;
            XYZ? transformOrigin = null;
            XYZ? locationPointVector = null;
            double? rotationRadians = null;
            bool? mirrored = null;
            bool? handFlipped = null;
            bool? facingFlipped = null;
            bool? canFlipFacing = null;
            bool? canFlipHand = null;
            bool? workPlaneFlipped = null;
            string? locationKind = null;

            if (e is FamilyInstance fi)
            {
                try { facingVector = TransformVectorToHost(linkInstance, fi.FacingOrientation); } catch { }
                try { handVector = TransformVectorToHost(linkInstance, fi.HandOrientation); } catch { }
                try { mirrored = fi.Mirrored; } catch { }
                try { handFlipped = fi.HandFlipped; } catch { }
                try { facingFlipped = fi.FacingFlipped; } catch { }
                try { canFlipFacing = fi.CanFlipFacing; } catch { }
                try { canFlipHand = fi.CanFlipHand; } catch { }
                try { workPlaneFlipped = fi.IsWorkPlaneFlipped; } catch { }

                var familyTransform = TryGetElementTransform(fi);
                if (familyTransform != null)
                {
                    transformOrigin = TransformPointToHost(linkInstance, familyTransform.Origin);
                    basisXVector = TransformVectorToHost(linkInstance, familyTransform.BasisX);
                    basisYVector = TransformVectorToHost(linkInstance, familyTransform.BasisY);
                    basisZVector = TransformVectorToHost(linkInstance, familyTransform.BasisZ);
                }
            }

            if (basisXVector == null || basisYVector == null || basisZVector == null || transformOrigin == null)
            {
                var elementTransform = TryGetElementTransform(e);
                if (elementTransform != null)
                {
                    if (transformOrigin == null) transformOrigin = TransformPointToHost(linkInstance, elementTransform.Origin);
                    if (basisXVector == null) basisXVector = TransformVectorToHost(linkInstance, elementTransform.BasisX);
                    if (basisYVector == null) basisYVector = TransformVectorToHost(linkInstance, elementTransform.BasisY);
                    if (basisZVector == null) basisZVector = TransformVectorToHost(linkInstance, elementTransform.BasisZ);
                }
            }

            try
            {
                if (e.Location is LocationPoint lp)
                {
                    locationKind = "point";
                    locationPointVector = TransformPointToHost(linkInstance, lp.Point);
                    rotationRadians = lp.Rotation;
                }
                else if (e.Location is LocationCurve lc && lc.Curve != null)
                {
                    locationKind = "curve";
                    var start = TransformPointToHost(linkInstance, lc.Curve.GetEndPoint(0));
                    var end = TransformPointToHost(linkInstance, lc.Curve.GetEndPoint(1));
                    var dir = end - start;
                    if (dir.GetLength() > 1e-9) curveDirectionVector = dir.Normalize();
                }
            }
            catch { }

            var planAzimuthRadians = TryComputePlanAzimuthRadians(facingVector);
            var planAzimuthSource = planAzimuthRadians.HasValue ? "facing" : (string?)null;

            if (!planAzimuthRadians.HasValue)
            {
                planAzimuthRadians = TryComputePlanAzimuthRadians(curveDirectionVector);
                if (planAzimuthRadians.HasValue) planAzimuthSource = "curveDirection";
            }

            if (!planAzimuthRadians.HasValue)
            {
                planAzimuthRadians = TryComputePlanAzimuthRadians(basisXVector);
                if (planAzimuthRadians.HasValue) planAzimuthSource = "basisX";
            }

            if (!planAzimuthRadians.HasValue && rotationRadians.HasValue)
            {
                if (linkInstance != null)
                {
                    var transformedRotation = TransformVectorToHost(linkInstance, new XYZ(Math.Cos(rotationRadians.Value), Math.Sin(rotationRadians.Value), 0.0));
                    planAzimuthRadians = TryComputePlanAzimuthRadians(transformedRotation);
                    if (planAzimuthRadians.HasValue) planAzimuthSource = "rotationTransformed";
                }

                if (!planAzimuthRadians.HasValue)
                {
                    planAzimuthRadians = NormalizeRadians(rotationRadians.Value);
                    planAzimuthSource = "rotation";
                }
            }

            var facing = BuildVectorOrNull(facingVector);
            var hand = BuildVectorOrNull(handVector);
            var curveDirection = BuildVectorOrNull(curveDirectionVector);
            var basisX = BuildVectorOrNull(basisXVector);
            var basisY = BuildVectorOrNull(basisYVector);
            var basisZ = BuildVectorOrNull(basisZVector);
            var origin = BuildVectorOrNull(transformOrigin);
            var locationPoint = BuildVectorOrNull(locationPointVector);
            var rotationDegrees = rotationRadians.HasValue ? rotationRadians.Value * (180.0 / Math.PI) : (double?)null;
            var planAzimuthDegrees = planAzimuthRadians.HasValue ? planAzimuthRadians.Value * (180.0 / Math.PI) : (double?)null;
            var sourceToHostTransform = BuildLinkTransformPayload(linkInstance);

            if (facing == null &&
                hand == null &&
                curveDirection == null &&
                basisX == null &&
                basisY == null &&
                basisZ == null &&
                origin == null &&
                locationPoint == null &&
                rotationRadians == null &&
                mirrored == null &&
                handFlipped == null &&
                facingFlipped == null &&
                canFlipFacing == null &&
                canFlipHand == null &&
                workPlaneFlipped == null &&
                planAzimuthRadians == null &&
                sourceToHostTransform == null)
            {
                return null;
            }

            return new
            {
                facing,
                hand,
                curveDirection,
                transform = new
                {
                    origin,
                    basisX,
                    basisY,
                    basisZ
                },
                sourceToHostTransform,
                locationPoint,
                rotationRadians,
                rotationDegrees,
                planAzimuthRadians,
                planAzimuthDegrees,
                planAzimuthSource,
                locationKind,
                mirrored,
                handFlipped,
                facingFlipped,
                canFlipFacing,
                canFlipHand,
                workPlaneFlipped,
                linkTransformed = linkInstance != null,
                coordinateSpace = linkInstance == null ? "host_model" : "host_model_from_link"
            };
        }

        private static object? BuildVectorOrNull(XYZ? xyz)
        {
            return xyz == null ? null : BuildVector(xyz);
        }

        private static object? BuildLinkTransformPayload(RevitLinkInstance? linkInstance)
        {
            var transform = TryGetLinkTransform(linkInstance);
            if (transform == null) return null;
            return new
            {
                origin = BuildVectorOrNull(transform.Origin),
                basisX = BuildVectorOrNull(transform.BasisX),
                basisY = BuildVectorOrNull(transform.BasisY),
                basisZ = BuildVectorOrNull(transform.BasisZ)
            };
        }

        private static Transform? TryGetElementTransform(Element? element)
        {
            if (element == null) return null;
            if (element is Instance instance)
            {
                try { return instance.GetTransform(); } catch { }
            }
            return null;
        }

        private static Transform? TryGetLinkTransform(RevitLinkInstance? linkInstance)
        {
            if (linkInstance == null) return null;
            try { return linkInstance.GetTotalTransform(); } catch { }
            try { return linkInstance.GetTransform(); } catch { }
            return null;
        }

        private static XYZ TransformPointToHost(RevitLinkInstance? linkInstance, XYZ point)
        {
            var transform = TryGetLinkTransform(linkInstance);
            if (transform == null) return point;
            try { return transform.OfPoint(point); } catch { return point; }
        }

        private static XYZ? TransformNullablePointToHost(RevitLinkInstance? linkInstance, XYZ? point)
        {
            return point == null ? null : TransformPointToHost(linkInstance, point);
        }

        private static XYZ TransformVectorToHost(RevitLinkInstance? linkInstance, XYZ vector)
        {
            var transform = TryGetLinkTransform(linkInstance);
            if (transform == null) return vector;
            try { return transform.OfVector(vector); } catch { return vector; }
        }

        private static double NormalizeRadians(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) return 0.0;
            var angle = value;
            while (angle <= -Math.PI) angle += Math.PI * 2.0;
            while (angle > Math.PI) angle -= Math.PI * 2.0;
            return angle;
        }

        private static double? TryComputePlanAzimuthRadians(XYZ? vector)
        {
            if (vector == null) return null;
            if (Math.Abs(vector.X) < 1e-9 && Math.Abs(vector.Y) < 1e-9) return null;
            return NormalizeRadians(Math.Atan2(vector.Y, vector.X));
        }

        private static void ApplyHostProvenance(Dictionary<string, object?> payload)
        {
            var host = TryGetDictionary(payload, "host");
            var hostingSurface = TryGetDictionary(payload, "hostingSurface");

            var resolved = ResolveHostProvenance(payload, host, hostingSurface);

            if (resolved.HostId.HasValue && resolved.HostId.Value > 0) payload["hostId"] = resolved.HostId.Value;
            if (!string.IsNullOrWhiteSpace(resolved.HostScopedId)) payload["hostScopedId"] = resolved.HostScopedId;
            if (!string.IsNullOrWhiteSpace(resolved.HostCategory)) payload["hostCategory"] = resolved.HostCategory;
            if (!string.IsNullOrWhiteSpace(resolved.HostBuiltInCategory)) payload["hostBuiltInCategory"] = resolved.HostBuiltInCategory;

            if (!string.IsNullOrWhiteSpace(resolved.HostScopedId))
            {
                payload["hostSourceScopedId"] = resolved.HostScopedId;
            }

            if (!string.IsNullOrWhiteSpace(resolved.Source) && !string.Equals(resolved.Source, "none", StringComparison.OrdinalIgnoreCase))
            {
                payload["hostProvenance"] = new
                {
                    source = resolved.Source,
                    hostScopedId = resolved.HostScopedId,
                    linkInstanceId = resolved.LinkInstanceId,
                    linkInstanceName = resolved.LinkInstanceName,
                    linkedElementId = resolved.LinkedElementId,
                    linkedElementScopedId = resolved.LinkedElementScopedId
                };
            }

            var hasResolvedHost =
                (resolved.HostId.HasValue && resolved.HostId.Value > 0) ||
                !string.IsNullOrWhiteSpace(resolved.HostScopedId) ||
                !string.IsNullOrWhiteSpace(resolved.HostCategory) ||
                !string.IsNullOrWhiteSpace(resolved.HostBuiltInCategory);
            if (!hasResolvedHost && host == null) return;

            if (host == null)
            {
                host = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                payload["host"] = host;
            }

            if (resolved.HostId.HasValue && resolved.HostId.Value > 0) host["id"] = resolved.HostId.Value;
            if (!string.IsNullOrWhiteSpace(resolved.HostScopedId))
            {
                host["scopedId"] = resolved.HostScopedId;
                host["sourceScopedId"] = resolved.HostScopedId;
            }
            if (!string.IsNullOrWhiteSpace(resolved.HostCategory)) host["category"] = resolved.HostCategory;
            if (!string.IsNullOrWhiteSpace(resolved.HostBuiltInCategory)) host["builtInCategory"] = resolved.HostBuiltInCategory;
            if (!string.IsNullOrWhiteSpace(resolved.HostName)) host["name"] = resolved.HostName;
            if (resolved.LinkInstanceId.HasValue && resolved.LinkInstanceId.Value > 0) host["linkInstanceId"] = resolved.LinkInstanceId.Value;
            if (!string.IsNullOrWhiteSpace(resolved.LinkInstanceName)) host["linkInstanceName"] = resolved.LinkInstanceName;
            if (!string.IsNullOrWhiteSpace(resolved.LinkDocumentTitle)) host["linkDocumentTitle"] = resolved.LinkDocumentTitle;
            if (!string.IsNullOrWhiteSpace(resolved.LinkDocumentPath)) host["linkDocumentPath"] = resolved.LinkDocumentPath;
            if (!string.IsNullOrWhiteSpace(resolved.Source) && !string.Equals(resolved.Source, "none", StringComparison.OrdinalIgnoreCase))
            {
                host["resolvedFrom"] = resolved.Source;
            }

            payload["host"] = host;
        }

        private static HostProvenanceResolution ResolveHostProvenance(
            Dictionary<string, object?> payload,
            Dictionary<string, object?>? host,
            Dictionary<string, object?>? hostingSurface)
        {
            var linkedScopedId = ReadString(hostingSurface, "linkedElementScopedId");
            if (!string.IsNullOrWhiteSpace(linkedScopedId))
            {
                return new HostProvenanceResolution
                {
                    Source = "hostingSurface.linkedElement",
                    HostId = ReadLong(hostingSurface, "linkedElementId"),
                    HostScopedId = linkedScopedId,
                    HostCategory = ReadString(hostingSurface, "linkedElementCategory"),
                    HostBuiltInCategory = ReadString(hostingSurface, "linkedElementBuiltInCategory"),
                    HostName = ReadString(hostingSurface, "linkedElementName"),
                    LinkInstanceId = ReadLong(hostingSurface, "linkInstanceId"),
                    LinkInstanceName = ReadString(hostingSurface, "linkInstanceName"),
                    LinkDocumentTitle = ReadString(hostingSurface, "linkDocumentTitle"),
                    LinkDocumentPath = ReadString(hostingSurface, "linkDocumentPath"),
                    LinkedElementId = ReadLong(hostingSurface, "linkedElementId"),
                    LinkedElementScopedId = linkedScopedId
                };
            }

            var hostElementScopedId = ReadString(hostingSurface, "hostElementScopedId");
            if (!string.IsNullOrWhiteSpace(hostElementScopedId))
            {
                return new HostProvenanceResolution
                {
                    Source = "hostingSurface.hostElement",
                    HostId = ReadLong(hostingSurface, "hostElementId"),
                    HostScopedId = hostElementScopedId,
                    HostCategory = ReadString(hostingSurface, "hostElementCategory"),
                    HostBuiltInCategory = ReadString(hostingSurface, "hostElementBuiltInCategory"),
                    HostName = ReadString(hostingSurface, "hostElementName"),
                    LinkInstanceId = ReadLong(hostingSurface, "linkInstanceId"),
                    LinkInstanceName = ReadString(hostingSurface, "linkInstanceName"),
                    LinkDocumentTitle = ReadString(hostingSurface, "linkDocumentTitle"),
                    LinkDocumentPath = ReadString(hostingSurface, "linkDocumentPath")
                };
            }

            var hostScopedId = ReadString(host, "scopedId") ?? ReadString(host, "sourceScopedId");
            if (!string.IsNullOrWhiteSpace(hostScopedId))
            {
                return new HostProvenanceResolution
                {
                    Source = "host",
                    HostId = ReadLong(host, "id") ?? ReadLong(payload, "hostId"),
                    HostScopedId = hostScopedId,
                    HostCategory = ReadString(host, "category") ?? ReadString(payload, "hostCategory"),
                    HostBuiltInCategory = ReadString(host, "builtInCategory") ?? ReadString(payload, "hostBuiltInCategory"),
                    HostName = ReadString(host, "name"),
                    LinkInstanceId = ReadLong(host, "linkInstanceId"),
                    LinkInstanceName = ReadString(host, "linkInstanceName"),
                    LinkDocumentTitle = ReadString(host, "linkDocumentTitle"),
                    LinkDocumentPath = ReadString(host, "linkDocumentPath")
                };
            }

            return new HostProvenanceResolution
            {
                Source = "topLevel",
                HostId = ReadLong(payload, "hostId"),
                HostScopedId = ReadString(payload, "hostScopedId"),
                HostCategory = ReadString(payload, "hostCategory"),
                HostBuiltInCategory = ReadString(payload, "hostBuiltInCategory")
            };
        }

        private static Dictionary<string, object?>? TryGetDictionary(Dictionary<string, object?> payload, string key)
        {
            if (!payload.TryGetValue(key, out var raw) || raw == null) return null;
            if (raw is Dictionary<string, object?> typed) return typed;
            if (raw is IDictionary<string, object?> genericTyped)
            {
                return genericTyped.ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.OrdinalIgnoreCase);
            }
            if (raw is IDictionary<string, object> generic)
            {
                return generic.ToDictionary(kvp => kvp.Key, kvp => (object?)kvp.Value, StringComparer.OrdinalIgnoreCase);
            }
            return null;
        }

        private static string? ReadString(Dictionary<string, object?>? payload, string key)
        {
            if (payload == null || !payload.TryGetValue(key, out var raw) || raw == null) return null;
            if (raw is string s)
            {
                var value = s.Trim();
                return value.Length == 0 ? null : value;
            }
            return null;
        }

        private static long? ReadLong(Dictionary<string, object?>? payload, string key)
        {
            if (payload == null || !payload.TryGetValue(key, out var raw) || raw == null) return null;
            if (raw is long l) return l > 0 ? l : (long?)null;
            if (raw is int i) return i > 0 ? i : (long?)null;
            if (raw is short sh) return sh > 0 ? sh : (long?)null;
            if (raw is double d && IsFinite(d))
            {
                var rounded = (long)Math.Round(d);
                if (Math.Abs(d - rounded) < 1e-6 && rounded > 0) return rounded;
                return null;
            }
            if (raw is string s && long.TryParse(s.Trim(), out var parsed) && parsed > 0) return parsed;
            return null;
        }

        private static object BuildVector(XYZ xyz)
        {
            return new { x = xyz.X, y = xyz.Y, z = xyz.Z };
        }

        private static object BuildProjectedPoint(
            XYZ point,
            int widthPx,
            int heightPx,
            XYZ topLeft,
            XYZ topRight,
            XYZ bottomLeft)
        {
            var projection = TryProjectPointToImage(point, widthPx, heightPx, topLeft, topRight, bottomLeft);
            return new
            {
                model = new { x = point.X, y = point.Y, z = point.Z },
                image = BuildProjectionPayload(projection)
            };
        }

        private static object BuildProjectionPayload(PixelProjection? projection)
        {
            if (projection == null)
            {
                return new { x = (double?)null, y = (double?)null, normalizedX = (double?)null, normalizedY = (double?)null, insideFrame = false };
            }

            return new
            {
                x = (double?)projection.X,
                y = (double?)projection.Y,
                normalizedX = (double?)projection.NormalizedX,
                normalizedY = (double?)projection.NormalizedY,
                insideFrame = projection.InsideFrame
            };
        }

        private static PixelProjection? TryProjectPointToImage(
            XYZ point,
            int widthPx,
            int heightPx,
            XYZ topLeft,
            XYZ topRight,
            XYZ bottomLeft)
        {
            var xAxis = topRight - topLeft;
            var yAxis = bottomLeft - topLeft;
            var xLenSq = xAxis.DotProduct(xAxis);
            var yLenSq = yAxis.DotProduct(yAxis);

            if (xLenSq < 1e-9 || yLenSq < 1e-9)
            {
                return null;
            }

            var rel = point - topLeft;
            var u = rel.DotProduct(xAxis) / xLenSq;
            var v = rel.DotProduct(yAxis) / yLenSq;
            var xPx = u * Math.Max(1.0, widthPx - 1.0);
            var yPx = v * Math.Max(1.0, heightPx - 1.0);
            var inside = u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0;

            return new PixelProjection
            {
                X = xPx,
                Y = yPx,
                NormalizedX = u,
                NormalizedY = v,
                InsideFrame = inside
            };
        }

        private static object? TryProjectBoundingBoxToRect(
            BoundingBoxXYZ bbox,
            int widthPx,
            int heightPx,
            XYZ topLeft,
            XYZ topRight,
            XYZ bottomLeft)
        {
            double minX = double.PositiveInfinity;
            double minY = double.PositiveInfinity;
            double maxX = double.NegativeInfinity;
            double maxY = double.NegativeInfinity;
            double minU = double.PositiveInfinity;
            double minV = double.PositiveInfinity;
            double maxU = double.NegativeInfinity;
            double maxV = double.NegativeInfinity;

            foreach (var corner in GetBoundingBoxWorldCorners(bbox))
            {
                var projection = TryProjectPointToImage(corner, widthPx, heightPx, topLeft, topRight, bottomLeft);
                if (projection == null) continue;
                minX = Math.Min(minX, projection.X);
                minY = Math.Min(minY, projection.Y);
                maxX = Math.Max(maxX, projection.X);
                maxY = Math.Max(maxY, projection.Y);
                minU = Math.Min(minU, projection.NormalizedX);
                minV = Math.Min(minV, projection.NormalizedY);
                maxU = Math.Max(maxU, projection.NormalizedX);
                maxV = Math.Max(maxV, projection.NormalizedY);
            }

            if (!IsFinite(minX) || !IsFinite(minY) || !IsFinite(maxX) || !IsFinite(maxY))
                return null;

            var intersectsFrame = maxU >= 0.0 && maxV >= 0.0 && minU <= 1.0 && minV <= 1.0;

            return new
            {
                minX,
                minY,
                maxX,
                maxY,
                minNormalizedX = minU,
                minNormalizedY = minV,
                maxNormalizedX = maxU,
                maxNormalizedY = maxV,
                intersectsFrame
            };
        }

        private static XYZ GetBoundingBoxWorldCenter(BoundingBoxXYZ bbox)
        {
            var worldCorners = GetBoundingBoxWorldCorners(bbox).ToList();
            if (worldCorners.Count == 0) return XYZ.Zero;

            var sx = 0.0;
            var sy = 0.0;
            var sz = 0.0;
            foreach (var c in worldCorners)
            {
                sx += c.X;
                sy += c.Y;
                sz += c.Z;
            }
            var count = worldCorners.Count;
            return new XYZ(sx / count, sy / count, sz / count);
        }

        private static IEnumerable<XYZ> GetBoundingBoxWorldCorners(BoundingBoxXYZ bbox)
        {
            var t = bbox.Transform ?? Transform.Identity;
            var min = bbox.Min;
            var max = bbox.Max;
            yield return t.OfPoint(new XYZ(min.X, min.Y, min.Z));
            yield return t.OfPoint(new XYZ(min.X, min.Y, max.Z));
            yield return t.OfPoint(new XYZ(min.X, max.Y, min.Z));
            yield return t.OfPoint(new XYZ(min.X, max.Y, max.Z));
            yield return t.OfPoint(new XYZ(max.X, min.Y, min.Z));
            yield return t.OfPoint(new XYZ(max.X, min.Y, max.Z));
            yield return t.OfPoint(new XYZ(max.X, max.Y, min.Z));
            yield return t.OfPoint(new XYZ(max.X, max.Y, max.Z));
        }

        private static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);

        private static void TryGetTypeInfo(Document doc, Element e, out long? typeId, out string? typeName, out string? familyName)
        {
            typeId = null;
            typeName = null;
            familyName = null;

            try
            {
                var id = e.GetTypeId();
                if (id == ElementId.InvalidElementId) return;
                var type = doc.GetElement(id) as ElementType;
                if (type == null) return;
                typeId = ElementIdCompat.GetValue(id);
                typeName = type.Name;
                familyName = type is FamilySymbol fs ? fs.FamilyName : type.FamilyName;
            }
            catch { }
        }

        private static Space? GetSpace(Element e)
        {
            if (e is Space space) return space;

            try
            {
                if (e is FamilyInstance fi) return fi.Space;
            }
            catch { }

            return null;
        }

        private static long? TryGetElementIdValue(ElementId id)
        {
            if (id == null || id == ElementId.InvalidElementId) return null;
            return ElementIdCompat.GetValue(id);
        }

        private static void EnsureCropBoxActiveForInventoryExport(Document doc, View view, List<string> warnings, out bool restoreAfter)
        {
            restoreAfter = false;
            bool cropActive;
            try
            {
                cropActive = view.CropBoxActive;
            }
            catch
            {
                throw new ArgumentException("View crop box state is not available for this view.");
            }

            if (cropActive) return;

            try
            {
                using (var tx = new Transaction(doc, "Operator Export Visible Elements (Activate Crop Box)"))
                {
                    tx.Start();
                    view.CropBoxActive = true;
                    doc.Regenerate();
                    tx.Commit();
                }
                restoreAfter = true;
                warnings.Add("export-visible-elements temporarily activated CropBoxActive for deterministic mapping.");
            }
            catch (Exception ex)
            {
                throw new ArgumentException(
                    "export-visible-elements requires an active crop box and auto-activation failed: " + ex.Message +
                    ". Activate crop in the target view or use /revit/export-view-region.",
                    ex
                );
            }
        }

        private static void TryRestoreCropBoxActive(Document doc, View view, List<string> warnings)
        {
            try
            {
                using (var tx = new Transaction(doc, "Operator Export Visible Elements (Restore Crop Box)"))
                {
                    tx.Start();
                    view.CropBoxActive = false;
                    doc.Regenerate();
                    tx.Commit();
                }
                warnings.Add("export-visible-elements restored CropBoxActive to false after capture.");
            }
            catch (Exception ex)
            {
                warnings.Add("export-visible-elements warning: failed to restore CropBoxActive: " + ex.Message);
            }
        }
    }
}

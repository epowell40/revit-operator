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
    public class HighlightAndExportHandler : IRequestHandler
    {
        public class OverrideStyle
        {
            public int? lineWeight { get; set; }
            public int? r { get; set; }
            public int? g { get; set; }
            public int? b { get; set; }
        }

        public class HighlightGroup
        {
            public string? name { get; set; }
            public List<long> elementIds { get; set; } = new List<long>();
            public OverrideStyle? overrideStyle { get; set; }
        }

        public class LabelSpec
        {
            public string text { get; set; } = "";
            public double[]? pointXyz { get; set; } // [x,y,z] in model feet
        }

        public class Params
        {
            public long? viewId { get; set; }
            public List<long> elementIds { get; set; } = new List<long>();
            public int imageSize { get; set; } = 2200;
            public string folder { get; set; } = "";
            public string highlightMode { get; set; } = "temporary_override";
            public OverrideStyle? overrideStyle { get; set; }
            public List<HighlightGroup>? highlightGroups { get; set; }
            public List<LabelSpec>? labels { get; set; }
            public bool traceElementCurves { get; set; } = false;

            // Optional: export a focused image by temporarily cropping the view to the union of these elements' view bboxes.
            // (Rolled back after export.)
            public List<long>? focusElementIds { get; set; }
            public double focusPaddingFt { get; set; } = 2.0;
        }

        private class FocusCropResult
        {
            public bool requested { get; set; }
            public bool applied { get; set; }
            public int elementCount { get; set; }
            public double paddingFt { get; set; }
            public double? widthFt { get; set; }
            public double? heightFt { get; set; }
            public bool scopeBoxCleared { get; set; }
        }

        private class TraceResult
        {
            public bool requested { get; set; }
            public int createdCount { get; set; }
            public int failedCount { get; set; }
        }

        private sealed class ElementVisibilityCheck
        {
            public long elementId { get; set; }
            public bool found { get; set; }
            public string? category { get; set; }
            public bool? inViewCollector { get; set; }
            public bool viewSpecificBoundingBoxAvailable { get; set; }
            public bool? elementHidden { get; set; }
            public bool? categoryHidden { get; set; }
            public bool visibleInRequestedView { get; set; }
            public List<string> blockingReasons { get; set; } = new List<string>();
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new Exception("No active UI document.");
            var doc = uidoc.Document;

            View? view = null;
            if (p.viewId.HasValue && p.viewId.Value != 0)
                view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
            else
                view = doc.ActiveView;
            if (view == null) throw new Exception("View not found.");

            if (!string.Equals(p.highlightMode, "temporary_override", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException($"Unsupported highlightMode '{p.highlightMode}'. Only 'temporary_override' is supported.");

            var folder = SelectionUtil.EnsureDefaultSelectionCaptureFolder(p.folder);
            var exportId = Guid.NewGuid().ToString("N");
            var stem = $"Revit_{RevitBridge.Common.ElementIdCompat.GetValue(view.Id)}_{exportId}_highlight";

            var groups = (p.highlightGroups != null && p.highlightGroups.Count > 0)
                ? p.highlightGroups
                : new List<HighlightGroup> { new HighlightGroup { name = "default", elementIds = p.elementIds ?? new List<long>(), overrideStyle = p.overrideStyle } };

            if (groups.All(g => g == null || g.elementIds == null || g.elementIds.Count == 0))
                throw new ArgumentException("highlight-and-export requires elementIds or highlightGroups[].elementIds.");

            var requestedIds = (p.elementIds ?? new List<long>())
                .Concat(groups.Where(g => g != null).SelectMany(g => g.elementIds ?? new List<long>()))
                .Where(id => id != 0)
                .Distinct()
                .ToList();
            var elementVisibility = AssessElementVisibility(doc, view, requestedIds);

            string path;
            var warnings = new List<string>();
            FocusCropResult? focusCrop;
            TraceResult? traceResult;
            using (var tg = new TransactionGroup(doc, "Highlight and Export"))
            {
                tg.Start();

                using (var t = new Transaction(doc, "Apply Temporary Overrides"))
                {
                    t.Start();

                    foreach (var group in groups)
                    {
                        if (group == null) continue;
                        var ogs = BuildOgs(group.overrideStyle ?? p.overrideStyle);
                        foreach (var id in (group.elementIds ?? new List<long>()))
                        {
                            try { view.SetElementOverrides(RevitBridge.Common.ElementIdCompat.Create(id), ogs); } catch { /* ignore */ }
                        }
                    }

                    traceResult = TryCreateElementCurveTraces(doc, view, groups, p.overrideStyle, p.traceElementCurves, warnings);
                    TryCreateLabels(doc, view, p.labels);
                    focusCrop = TryApplyFocusCrop(doc, view, p.focusElementIds, p.focusPaddingFt, warnings);
                    t.Commit();
                }

                path = SelectionUtil.ExportViewImage(doc, view, p.imageSize, folder, stem);

                // Roll back overrides to leave the model unchanged.
                tg.RollBack();
            }

            var (widthPx, heightPx) = SelectionUtil.ReadImageSize(path);

            return Task.FromResult<object>(new
            {
                path,
                widthPx,
                heightPx,
                trace = traceResult,
                focusCrop,
                elementVisibility,
                warnings
            });
        }

        private static object AssessElementVisibility(Document doc, View view, List<long> requestedIds)
        {
            HashSet<long>? collectorIds = null;
            try
            {
                collectorIds = new FilteredElementCollector(doc, view.Id)
                    .WhereElementIsNotElementType()
                    .ToElementIds()
                    .Select(ElementIdCompat.GetValue)
                    .ToHashSet();
            }
            catch
            {
                collectorIds = null;
            }

            var checks = new List<ElementVisibilityCheck>();
            foreach (var id in requestedIds)
            {
                var check = new ElementVisibilityCheck { elementId = id };
                var element = doc.GetElement(ElementIdCompat.Create(id));
                check.found = element != null;
                check.category = element?.Category?.Name;
                check.inViewCollector = collectorIds == null ? (bool?)null : collectorIds.Contains(id);

                if (element == null)
                {
                    check.blockingReasons.Add("element_not_found");
                    checks.Add(check);
                    continue;
                }

                try { check.viewSpecificBoundingBoxAvailable = element.get_BoundingBox(view) != null; }
                catch { check.viewSpecificBoundingBoxAvailable = false; }
                try { check.elementHidden = element.IsHidden(view); }
                catch { check.elementHidden = null; }
                try { check.categoryHidden = element.Category == null ? (bool?)null : view.GetCategoryHidden(element.Category.Id); }
                catch { check.categoryHidden = null; }

                if (check.inViewCollector != true) check.blockingReasons.Add(check.inViewCollector == false ? "not_in_view_collector" : "view_collector_unavailable");
                if (!check.viewSpecificBoundingBoxAvailable) check.blockingReasons.Add("no_view_specific_bounding_box");
                if (check.elementHidden == true) check.blockingReasons.Add("element_hidden_in_view");
                if (check.categoryHidden == true) check.blockingReasons.Add("category_hidden_in_view");
                check.visibleInRequestedView = check.blockingReasons.Count == 0;
                checks.Add(check);
            }

            var visibleIds = checks.Where(x => x.visibleInRequestedView).Select(x => x.elementId).ToList();
            var notVisibleIds = checks.Where(x => !x.visibleInRequestedView).Select(x => x.elementId).ToList();
            return new
            {
                viewId = ElementIdCompat.GetValue(view.Id),
                requestedElementIds = requestedIds,
                visibleElementIds = visibleIds,
                notVisibleElementIds = notVisibleIds,
                allRequestedElementsVisible = requestedIds.Count > 0 && notVisibleIds.Count == 0,
                checks
            };
        }

        private static TraceResult? TryCreateElementCurveTraces(Document doc, View view, List<HighlightGroup> groups, OverrideStyle? defaultStyle, bool requested, List<string> warnings)
        {
            if (!requested) return null;

            var result = new TraceResult { requested = true };
            if (view.ViewType == ViewType.DrawingSheet)
            {
                warnings.Add("Element curve trace requested, but sheet views do not support detail-curve tracing.");
                return result;
            }

            Plane? plane = null;
            try { plane = view.SketchPlane?.GetPlane(); } catch { plane = null; }
            if (plane == null)
            {
                warnings.Add("Element curve trace requested, but the view has no sketch plane.");
                return result;
            }

            foreach (var group in groups)
            {
                if (group == null) continue;
                var ogs = BuildOgs(group.overrideStyle ?? defaultStyle);
                foreach (var id in (group.elementIds ?? new List<long>()).Where(x => x != 0).Distinct())
                {
                    try
                    {
                        var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                        if (e?.Location is not LocationCurve lc || lc.Curve == null)
                        {
                            result.failedCount++;
                            continue;
                        }

                        var p0 = ProjectToPlane(lc.Curve.GetEndPoint(0), plane);
                        var p1 = ProjectToPlane(lc.Curve.GetEndPoint(1), plane);
                        if (p0.DistanceTo(p1) < 1e-6)
                        {
                            result.failedCount++;
                            continue;
                        }

                        var trace = doc.Create.NewDetailCurve(view, Line.CreateBound(p0, p1));
                        if (trace != null)
                        {
                            view.SetElementOverrides(trace.Id, ogs);
                            result.createdCount++;
                        }
                        else
                        {
                            result.failedCount++;
                        }
                    }
                    catch
                    {
                        result.failedCount++;
                    }
                }
            }

            if (result.failedCount > 0)
                warnings.Add($"Element curve trace failed for {result.failedCount} highlighted element(s); the export may still show model overrides, but trace overlay evidence is incomplete.");

            return result;
        }

        private static XYZ ProjectToPlane(XYZ point, Plane plane)
        {
            var delta = point - plane.Origin;
            var distance = delta.DotProduct(plane.Normal);
            return point - plane.Normal.Multiply(distance);
        }

        private static FocusCropResult? TryApplyFocusCrop(Document doc, View view, List<long>? focusElementIds, double paddingFt, List<string> warnings)
        {
            if (view == null) return null;
            if (focusElementIds == null || focusElementIds.Count == 0) return null;

            var result = new FocusCropResult
            {
                requested = true,
                paddingFt = Math.Max(0, Math.Min(1000, paddingFt))
            };

            if (view.ViewType == ViewType.DrawingSheet)
            {
                warnings.Add("Focus crop requested, but sheet views do not support crop-box focusing. Exported full sheet.");
                return result;
            }

            var ids = focusElementIds.Where(x => x != 0).Distinct().Select(x => RevitBridge.Common.ElementIdCompat.Create(x)).ToList();
            if (ids.Count == 0) return result;

            var existing = view.CropBox;
            var cropTransform = existing != null ? existing.Transform : Transform.Identity;
            var toCrop = cropTransform.Inverse;

            XYZ? minLocal = null;
            XYZ? maxLocal = null;
            var counted = 0;
            foreach (var id in ids)
            {
                var e = doc.GetElement(id);
                if (e == null) continue;
                BoundingBoxXYZ? bb = null;
                try { bb = e.get_BoundingBox(view); } catch { bb = null; }
                if (bb == null) continue;

                var bbTransform = bb.Transform ?? Transform.Identity;
                foreach (var p in EnumerateCorners(bb))
                {
                    var local = toCrop.OfPoint(bbTransform.OfPoint(p));
                    if (minLocal == null || maxLocal == null)
                    {
                        minLocal = local;
                        maxLocal = local;
                    }
                    else
                    {
                        minLocal = new XYZ(Math.Min(minLocal.X, local.X), Math.Min(minLocal.Y, local.Y), Math.Min(minLocal.Z, local.Z));
                        maxLocal = new XYZ(Math.Max(maxLocal.X, local.X), Math.Max(maxLocal.Y, local.Y), Math.Max(maxLocal.Z, local.Z));
                    }
                }
                counted++;
            }

            result.elementCount = counted;
            if (minLocal == null || maxLocal == null)
            {
                warnings.Add("Focus crop requested, but no element bounding boxes were available in this view.");
                return result;
            }

            var pad = result.paddingFt;
            var min = new XYZ(minLocal.X - pad, minLocal.Y - pad, minLocal.Z - pad);
            var max = new XYZ(maxLocal.X + pad, maxLocal.Y + pad, maxLocal.Z + pad);

            try
            {
                result.scopeBoxCleared = TryClearScopeBox(view);

                var newBox = new BoundingBoxXYZ();
                newBox.Transform = cropTransform;
                newBox.Min = min;
                newBox.Max = max;

                view.CropBoxActive = true;
                view.CropBoxVisible = false;
                view.CropBox = newBox;
                result.applied = true;
                result.widthFt = Math.Abs(max.X - min.X);
                result.heightFt = Math.Abs(max.Y - min.Y);
            }
            catch (Exception ex)
            {
                warnings.Add($"Focus crop failed: {ex.Message}");
            }

            return result;
        }

        private static bool TryClearScopeBox(View view)
        {
            try
            {
                var p = view.get_Parameter(BuiltInParameter.VIEWER_VOLUME_OF_INTEREST_CROP);
                if (p == null || p.IsReadOnly) return false;
                var current = p.AsElementId();
                if (current == null || current == ElementId.InvalidElementId) return false;
                p.Set(ElementId.InvalidElementId);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static IEnumerable<XYZ> EnumerateCorners(BoundingBoxXYZ bb)
        {
            var min = bb.Min;
            var max = bb.Max;
            yield return new XYZ(min.X, min.Y, min.Z);
            yield return new XYZ(min.X, min.Y, max.Z);
            yield return new XYZ(min.X, max.Y, min.Z);
            yield return new XYZ(min.X, max.Y, max.Z);
            yield return new XYZ(max.X, min.Y, min.Z);
            yield return new XYZ(max.X, min.Y, max.Z);
            yield return new XYZ(max.X, max.Y, min.Z);
            yield return new XYZ(max.X, max.Y, max.Z);
        }

        private static OverrideGraphicSettings BuildOgs(OverrideStyle? style)
        {
            var ogs = new OverrideGraphicSettings();
            if (style?.lineWeight != null)
            {
                var weight = Math.Max(1, Math.Min(16, style.lineWeight.Value));
                ogs.SetProjectionLineWeight(weight);
                ogs.SetCutLineWeight(weight);
            }
            if (style?.r != null && style?.g != null && style?.b != null)
            {
                var r = (byte)Math.Max(0, Math.Min(255, style.r.Value));
                var g = (byte)Math.Max(0, Math.Min(255, style.g.Value));
                var b = (byte)Math.Max(0, Math.Min(255, style.b.Value));
                var color = new Color(r, g, b);
                ogs.SetProjectionLineColor(color);
                ogs.SetCutLineColor(color);
            }
            ogs.SetHalftone(false);
            return ogs;
        }

        private static void TryCreateLabels(Document doc, View view, List<LabelSpec>? labels)
        {
            if (labels == null || labels.Count == 0) return;
            ElementId typeId;
            try { typeId = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).FirstElementId(); }
            catch { return; }
            if (typeId == ElementId.InvalidElementId) return;

            foreach (var l in labels)
            {
                try
                {
                    if (l == null) continue;
                    var text = (l.text ?? "").Trim();
                    if (text.Length == 0) continue;
                    if (l.pointXyz == null || l.pointXyz.Length < 3) continue;
                    var pt = new XYZ(l.pointXyz[0], l.pointXyz[1], l.pointXyz[2]);
                    TextNote.Create(doc, view.Id, pt, text, typeId);
                }
                catch
                {
                    // ignore label failures
                }
            }
        }
    }
}


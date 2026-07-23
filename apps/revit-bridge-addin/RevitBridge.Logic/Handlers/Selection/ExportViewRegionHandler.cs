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

namespace RevitBridge.Logic.Handlers
{
    public class ExportViewRegionHandler : IRequestHandler
    {
        public sealed class RegionSpec
        {
            public string mode { get; set; } = ""; // focusElements | center

            // focusElements
            public List<long>? focusElementIds { get; set; }
            public double marginFt { get; set; } = 0.0;

            // center
            public double centerX { get; set; }
            public double centerY { get; set; }
            public double halfWidth { get; set; }
            public double halfHeight { get; set; }
            public string? coordinateSpace { get; set; } // view | model_xy
        }

        public sealed class Params
        {
            public long? viewId { get; set; }
            public int imageMaxSizePx { get; set; } = 2400;
            public int? imageSize { get; set; } // backward/compat alias
            public string folder { get; set; } = "";
            public bool includeMapping { get; set; } = true;
            public bool preserveViewSpecificDetailing { get; set; } = false;
            public string? fileName { get; set; }
            public RegionSpec? region { get; set; }
            public List<string>? hideCategories { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");

            if (p.region == null) throw new ArgumentException("Missing required parameter: region");
            var regionMode = (p.region.mode ?? "").Trim();
            if (string.IsNullOrWhiteSpace(regionMode)) throw new ArgumentException("region.mode is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new Exception("No active UI document.");
            var doc = uidoc.Document;

            View? view = null;
            if (p.viewId.HasValue && p.viewId.Value != 0)
                view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
            else
                view = doc.ActiveView;

            if (view == null) throw new Exception("View not found.");
            if (!SelectionUtil.IsSupported2dView(view))
                throw new ArgumentException($"View type '{view.ViewType}' is not supported for export-view-region.");

            var folder = SelectionUtil.EnsureDefaultSelectionCaptureFolder(p.folder);
            var frameId = Guid.NewGuid().ToString("N");

            var imageSize = p.imageSize.HasValue && p.imageSize.Value > 0 ? p.imageSize.Value : p.imageMaxSizePx;
            imageSize = Math.Max(256, Math.Min(8192, imageSize));

            var stem = BuildFileStem(RevitBridge.Common.ElementIdCompat.GetValue(view.Id), frameId, p.fileName);

            var warnings = new List<string>();

            ElementId tempViewId = ElementId.InvalidElementId;
            View? tempView = null;

            try
            {
                try
                {
                    using (var tx = new Transaction(doc, "Operator Export View Region (Temp View)"))
                    {
                        tx.Start();

                        var duplicateOption = p.preserveViewSpecificDetailing
                            ? ViewDuplicateOption.WithDetailing
                            : ViewDuplicateOption.Duplicate;
                        tempViewId = view.Duplicate(duplicateOption);
                        tempView = doc.GetElement(tempViewId) as View;
                        if (tempView == null) throw new Exception("Failed to duplicate view.");

                        var templateCleared = false;
                        void TryClearTemplateForCrop()
                        {
                            if (templateCleared) return;
                            templateCleared = true;
                            try
                            {
                                if (tempView.ViewTemplateId != ElementId.InvalidElementId)
                                {
                                    tempView.ViewTemplateId = ElementId.InvalidElementId;
                                    warnings.Add("Temp view template cleared to enable crop region edits.");
                                }
                            }
                            catch
                            {
                                warnings.Add("Could not clear view template on temp view; export may be restricted.");
                            }
                        }

                        // A duplicated view can retain a template that silently restores its crop after
                        // CropBox assignment. Because this view is disposable, clear the template before
                        // any crop/scope edits instead of waiting for the API setter to throw.
                        TryClearTemplateForCrop();

                        if (TryClearScopeBox(tempView))
                            warnings.Add("Temp view scope box cleared so the requested region controls the export crop.");
                        if (TryRemoveNonRectangularCropShape(tempView))
                            warnings.Add("Temp view non-rectangular crop shape removed so the requested rectangular region can be applied.");

                        try { tempView.CropBoxActive = true; }
                        catch
                        {
                            TryClearTemplateForCrop();
                            try { tempView.CropBoxActive = true; }
                            catch { throw new ArgumentException("View does not support crop regions; export-view-region is not supported for this view type."); }
                        }

                        // Establish view coordinate system from the crop box.
                        BoundingBoxXYZ crop;
                        try { crop = tempView.CropBox; }
                        catch { throw new ArgumentException("View crop box is not available; export-view-region is not supported for this view type."); }

                        var viewT = crop.Transform;
                        var viewTInv = viewT.Inverse;

                        var (minX, minY, maxX, maxY) = GetRegionExtentsInViewCoords(doc, view, tempView, crop, viewTInv, p.region, warnings);

                        var newCrop = new BoundingBoxXYZ
                        {
                            Transform = viewT,
                            Min = new XYZ(minX, minY, crop.Min.Z),
                            Max = new XYZ(maxX, maxY, crop.Max.Z)
                        };

                        try
                        {
                            tempView.CropBox = newCrop;
                        }
                        catch
                        {
                            TryClearTemplateForCrop();
                            tempView.CropBox = newCrop;
                        }
                        try { tempView.CropBoxVisible = false; } catch { }
                        TryConfigureAnnotationCrop(tempView, 0.0, warnings);

                        doc.Regenerate();
                        tx.Commit();
                    }
                }
                catch (Exception ex)
                {
                    // Some views (or host environments) disallow duplication. Fall back to a temporary edit of the original view
                    // and then restore it, to keep the user's model state unchanged.
                    tempView = null;
                    tempViewId = ElementId.InvalidElementId;
                    warnings.Add($"Temp view duplication failed ({ex.Message}).");

                    // Prefer creating a dedicated temporary plan view (more robust than editing the user's view, and avoids template locks).
                    if (view is ViewPlan vp)
                    {
                        try
                        {
                            var created = CreateTemporaryPlanView(doc, vp);
                            tempViewId = created.Id;
                            tempView = created;
                            warnings.Add("Using a temporary plan view for region export (created from the same ViewFamilyType).");
                        }
                        catch (Exception ex2)
                        {
                            warnings.Add($"Failed to create a temporary plan view: {ex2.Message}");
                        }
                    }

                    if (tempView == null)
                        warnings.Add("Falling back to temporary crop edits on the original view.");
                }

                View exportView = tempView ?? view;

                string path;
                int widthPx;
                int heightPx;
                RasterAffineFrame? frame = null;

                if (tempView != null)
                {
                    // Ensure crop is active + set on the temp view.
                    using (var tx = new Transaction(doc, "Operator Export View Region (Configure Temp View)"))
                    {
                        tx.Start();
                        try
                        {
                            if (TryClearScopeBox(exportView))
                                warnings.Add("Temp view scope box cleared before final region crop.");
                            try { exportView.CropBoxActive = true; } catch { }
                            try { exportView.CropBoxVisible = false; } catch { }
                            TryConfigureAnnotationCrop(exportView, 0.0, warnings);
                            ApplyHiddenCategories(doc, exportView, p.hideCategories, warnings);
                        }
                        finally
                        {
                            doc.Regenerate();
                        }
                        tx.Commit();
                    }

                    // Apply region crop to temp view.
                    // The duplicated view owns copied detail elements with new ids. Resolve
                    // focusElementIds against the original view, then project their model
                    // bounds into the disposable export view's crop frame.
                    ApplyRegionCrop(doc, view, exportView, p.region, warnings);

                    // Ensure annotation/tag text reflects the latest model state before export.
                    try { doc.Regenerate(); } catch { }
                    try { uidoc.RefreshActiveView(); } catch { }

                    path = SelectionUtil.ExportViewImage(doc, exportView, imageSize, folder, stem);
                    (widthPx, heightPx) = SelectionUtil.ReadImageSize(path);
                    frame = SelectionUtil.BuildRasterAffineFrame(exportView, widthPx, heightPx);
                }
                else
                {
                    if (p.hideCategories != null && p.hideCategories.Count > 0)
                    {
                        throw new InvalidOperationException(
                            "export-view-region hideCategories requires a disposable temporary view; refusing to alter category visibility in the user's view.");
                    }
                    // Fallback: temporarily set the original view crop, export, then restore.
                    try
                    {
                        if (view.ViewTemplateId != ElementId.InvalidElementId)
                        {
                            throw new InvalidOperationException(
                                "View cannot be duplicated and has a view template applied; refusing to temporarily edit the user's view crop. " +
                                "Activate a non-templated plan view (or remove the template) and retry.");
                        }
                    }
                    catch
                    {
                        // If we can't read ViewTemplateId, proceed best-effort.
                    }

                    var state = CaptureViewCropState(view);
                    var restored = false;
                    try
                    {
                        ApplyRegionCrop(doc, view, view, p.region, warnings);
                        try { doc.Regenerate(); } catch { }
                        try { uidoc.RefreshActiveView(); } catch { }
                        path = SelectionUtil.ExportViewImage(doc, view, imageSize, folder, stem);
                        (widthPx, heightPx) = SelectionUtil.ReadImageSize(path);
                        frame = SelectionUtil.BuildRasterAffineFrame(view, widthPx, heightPx);
                    }
                    finally
                    {
                        restored = TryRestoreViewCropState(doc, view, state, warnings);
                    }

                    if (!restored)
                        warnings.Add("Warning: failed to fully restore the original view crop state after export.");
                }

                if (frame == null)
                    throw new InvalidOperationException("Failed to derive a raster-consistent frame mapping.");

                if (frame.AspectCorrectionApplied)
                {
                    warnings.Add(
                        $"export-view-region adjusted the frame X span to match the exported raster aspect (crop={frame.CropAspect:0.000000}, raster={frame.RasterAspect:0.000000}).");
                }

                var stored = new StoredViewFrame
                {
                    frameId = frameId,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id), // original view id (temp view is deleted)
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

                object? mapping = null;
                if (p.includeMapping)
                {
                    mapping = SelectionUtil.BuildRasterAffineMappingPayload(
                        frame,
                        "Derived from the exported raster frame of the temporary region view; original view is not modified.");
                }

                return Task.FromResult<object>(new
                {
                    frameId,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    viewType = view.ViewType.ToString(),
                    viewName = view.Name,
                    path,
                    widthPx,
                    heightPx,
                    mapping,
                    warnings = warnings.Count > 0 ? warnings : null
                });
            }
            finally
            {
                if (tempViewId != ElementId.InvalidElementId)
                {
                    try
                    {
                        using (var txDel = new Transaction(doc, "Operator Export View Region (Cleanup)"))
                        {
                            txDel.Start();
                            doc.Delete(tempViewId);
                            txDel.Commit();
                        }
                    }
                    catch
                    {
                        // best effort; avoid throwing after successful export
                    }
                }
            }
        }

        private static void ApplyHiddenCategories(
            Document doc,
            View view,
            List<string>? requestedCategories,
            List<string> warnings)
        {
            if (requestedCategories == null || requestedCategories.Count == 0) return;

            foreach (var raw in requestedCategories)
            {
                var token = (raw ?? string.Empty).Trim();
                if (token.Length == 0) continue;
                if (!Enum.TryParse(token, true, out BuiltInCategory builtInCategory))
                {
                    warnings.Add($"Unrecognized hideCategories token '{token}'. Use an exact BuiltInCategory value such as OST_Grids.");
                    continue;
                }

                var category = Category.GetCategory(doc, builtInCategory);
                if (category == null)
                {
                    warnings.Add($"hideCategories token '{token}' did not resolve to a document category.");
                    continue;
                }

                try
                {
                    if (view.CanCategoryBeHidden(category.Id))
                    {
                        view.SetCategoryHidden(category.Id, true);
                        continue;
                    }

                    // Datum categories such as grids may reject category-level
                    // visibility overrides even though their instances can be
                    // hidden safely on this disposable export view.
                    var hideableIds = new FilteredElementCollector(doc, view.Id)
                        .OfCategory(builtInCategory)
                        .WhereElementIsNotElementType()
                        .ToElementIds()
                        .Where(id =>
                        {
                            try { return doc.GetElement(id)?.CanBeHidden(view) == true; }
                            catch { return false; }
                        })
                        .ToList();

                    if (hideableIds.Count == 0)
                    {
                        warnings.Add($"Category '{token}' cannot be hidden in the temporary export view and has no hideable visible instances.");
                        continue;
                    }

                    view.HideElements(hideableIds);
                }
                catch (Exception ex)
                {
                    warnings.Add($"Failed to hide category '{token}' in the temporary export view: {ex.Message}");
                }
            }
        }

        private sealed class ViewCropState
        {
            public ElementId ViewTemplateId { get; set; } = ElementId.InvalidElementId;
            public bool CropBoxActive { get; set; }
            public bool CropBoxVisible { get; set; }
            public BoundingBoxXYZ? CropBox { get; set; }
        }

        private static ViewCropState CaptureViewCropState(View view)
        {
            var s = new ViewCropState();
            try { s.ViewTemplateId = view.ViewTemplateId; } catch { s.ViewTemplateId = ElementId.InvalidElementId; }
            try { s.CropBoxActive = view.CropBoxActive; } catch { s.CropBoxActive = false; }
            try { s.CropBoxVisible = view.CropBoxVisible; } catch { s.CropBoxVisible = false; }
            try { s.CropBox = view.CropBox; } catch { s.CropBox = null; }
            return s;
        }

        private static bool TryRestoreViewCropState(Document doc, View view, ViewCropState state, List<string> warnings)
        {
            try
            {
                using (var tx = new Transaction(doc, "Operator Export View Region (Restore View)"))
                {
                    tx.Start();
                    try
                    {
                        if (state.CropBox != null)
                        {
                            try { view.CropBox = state.CropBox; } catch { }
                        }
                        try { view.CropBoxVisible = state.CropBoxVisible; } catch { }
                        try { view.CropBoxActive = state.CropBoxActive; } catch { }
                        // Do NOT attempt to change the view template on the user's view.
                    }
                    finally
                    {
                        doc.Regenerate();
                    }
                    tx.Commit();
                }
                return true;
            }
            catch (Exception ex)
            {
                warnings.Add($"Failed to restore view crop state: {ex.Message}");
                return false;
            }
        }

        private static void ApplyRegionCrop(
            Document doc,
            View sourceView,
            View exportView,
            RegionSpec region,
            List<string> warnings)
        {
            using (var tx = new Transaction(doc, "Operator Export View Region (Temp Crop)"))
            {
                tx.Start();

                if (TryClearScopeBox(exportView))
                    warnings.Add("Scope box cleared so the requested region controls the export crop.");
                if (TryRemoveNonRectangularCropShape(exportView))
                    warnings.Add("Non-rectangular crop shape removed so the requested rectangular region can be applied.");

                try { exportView.CropBoxActive = true; }
                catch { throw new ArgumentException("View does not support crop regions; export-view-region is not supported for this view type."); }

                BoundingBoxXYZ crop;
                try { crop = exportView.CropBox; }
                catch { throw new ArgumentException("View crop box is not available; export-view-region is not supported for this view type."); }

                var viewT = crop.Transform;
                var viewTInv = viewT.Inverse;
                var (minX, minY, maxX, maxY) = GetRegionExtentsInViewCoords(doc, sourceView, exportView, crop, viewTInv, region, warnings);

                var newCrop = new BoundingBoxXYZ
                {
                    Transform = viewT,
                    Min = new XYZ(minX, minY, crop.Min.Z),
                    Max = new XYZ(maxX, maxY, crop.Max.Z)
                };

                exportView.CropBox = newCrop;
                try { exportView.CropBoxVisible = false; } catch { }
                TryConfigureAnnotationCrop(exportView, 0.0, warnings);
                doc.Regenerate();

                var applied = exportView.CropBox;
                var appliedWidth = Math.Abs(applied.Max.X - applied.Min.X);
                var appliedHeight = Math.Abs(applied.Max.Y - applied.Min.Y);
                var requestedWidth = Math.Abs(maxX - minX);
                var requestedHeight = Math.Abs(maxY - minY);
                if (Math.Abs(appliedWidth - requestedWidth) > 1e-4 ||
                    Math.Abs(appliedHeight - requestedHeight) > 1e-4)
                {
                    throw new InvalidOperationException(
                        $"Requested region crop was not retained (requested {requestedWidth:F6}x{requestedHeight:F6} ft, " +
                        $"read back {appliedWidth:F6}x{appliedHeight:F6} ft)."
                    );
                }
                tx.Commit();
            }
        }

        private static bool TryClearScopeBox(View view)
        {
            try
            {
                var parameter = view.get_Parameter(BuiltInParameter.VIEWER_VOLUME_OF_INTEREST_CROP);
                if (parameter == null || parameter.IsReadOnly || parameter.StorageType != StorageType.ElementId) return false;
                var current = parameter.AsElementId();
                if (current == null || current == ElementId.InvalidElementId) return false;
                parameter.Set(ElementId.InvalidElementId);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool TryRemoveNonRectangularCropShape(View view)
        {
            try
            {
                var manager = view.GetCropRegionShapeManager();
                if (manager == null || !manager.ShapeSet) return false;
                manager.RemoveCropRegionShape();
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void TryConfigureAnnotationCrop(View view, double marginFt, List<string> warnings)
        {
            try
            {
                var parameter = view.get_Parameter(BuiltInParameter.VIEWER_ANNOTATION_CROP_ACTIVE);
                if (parameter != null && !parameter.IsReadOnly && parameter.StorageType == StorageType.Integer)
                    parameter.Set(1);
            }
            catch (Exception ex)
            {
                warnings.Add($"Could not activate annotation crop on temporary view: {ex.Message}");
            }

            object? manager = null;
            try { manager = view.GetType().GetMethod("GetCropRegionShapeManager", Type.EmptyTypes)?.Invoke(view, null); }
            catch { manager = null; }
            if (manager == null) return;

            foreach (var propertyName in new[]
            {
                "LeftAnnotationCropOffset",
                "RightAnnotationCropOffset",
                "TopAnnotationCropOffset",
                "BottomAnnotationCropOffset"
            })
            {
                try
                {
                    var property = manager.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
                    if (property != null && property.CanWrite) property.SetValue(manager, marginFt);
                }
                catch
                {
                    // Best effort: not every supported view exposes writable annotation-crop edges.
                }
            }
        }

        private static View CreateTemporaryPlanView(Document doc, ViewPlan source)
        {
            if (doc == null) throw new ArgumentNullException(nameof(doc));
            if (source == null) throw new ArgumentNullException(nameof(source));

            Level? level = null;
            try { level = source.GenLevel; } catch { level = null; }
            if (level == null) throw new InvalidOperationException("Source ViewPlan does not have a GenLevel.");

            var vft = doc.GetElement(source.GetTypeId()) as ViewFamilyType;
            if (vft == null) throw new InvalidOperationException("Could not resolve ViewFamilyType for the source plan view.");

            using (var tx = new Transaction(doc, "Operator Export View Region (Create Temp Plan)"))
            {
                tx.Start();
                var created = ViewPlan.Create(doc, vft.Id, level.Id);
                if (created == null) throw new InvalidOperationException("ViewPlan.Create returned null.");

                try { created.ViewTemplateId = ElementId.InvalidElementId; } catch { }
                try { created.Name = $"Operator_TempRegion_{DateTime.UtcNow:yyyyMMdd_HHmmss}"; } catch { }
                try { created.CropBoxActive = true; } catch { }
                try { created.CropBoxVisible = false; } catch { }

                doc.Regenerate();
                tx.Commit();
                return created;
            }
        }

        private static string BuildFileStem(long viewId, string frameId, string? fileName)
        {
            var stem = $"Revit_{viewId}_{frameId}_region";
            if (string.IsNullOrWhiteSpace(fileName)) return stem;

            var fn = (fileName ?? "").Trim();
            fn = fn.Replace(Path.DirectorySeparatorChar, '_').Replace(Path.AltDirectorySeparatorChar, '_');
            if (fn.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) fn = fn.Substring(0, fn.Length - 4);
            if (fn.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)) fn = fn.Substring(0, fn.Length - 4);
            if (fn.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase)) fn = fn.Substring(0, fn.Length - 5);
            if (string.IsNullOrWhiteSpace(fn)) return stem;

            // Keep it deterministic and avoid super long paths.
            if (fn.Length > 80) fn = fn.Substring(0, 80);
            return fn;
        }

        private static (double minX, double minY, double maxX, double maxY) GetRegionExtentsInViewCoords(
            Document doc,
            View originalView,
            View tempView,
            BoundingBoxXYZ tempCrop,
            Transform viewTInv,
            RegionSpec region,
            List<string> warnings)
        {
            var mode = (region.mode ?? "").Trim();

            if (string.Equals(mode, "focusElements", StringComparison.OrdinalIgnoreCase))
            {
                var ids = region.focusElementIds ?? new List<long>();
                if (ids.Count == 0) throw new ArgumentException("region.focusElementIds must be a non-empty array for mode 'focusElements'.");

                var minX = double.PositiveInfinity;
                var minY = double.PositiveInfinity;
                var maxX = double.NegativeInfinity;
                var maxY = double.NegativeInfinity;

                var any = false;
                foreach (var id in ids.Distinct())
                {
                    var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (e == null)
                    {
                        warnings.Add($"focusElements: element {id} not found.");
                        continue;
                    }

                    BoundingBoxXYZ? bbox = null;
                    try { bbox = e.get_BoundingBox(tempView); } catch { bbox = null; }
                    if (bbox == null)
                    {
                        try { bbox = e.get_BoundingBox(originalView); } catch { bbox = null; }
                    }
                    if (bbox == null)
                    {
                        try { bbox = e.get_BoundingBox(null); } catch { bbox = null; }
                    }
                    if (bbox == null)
                    {
                        warnings.Add($"focusElements: element {id} has no bounding box.");
                        continue;
                    }

                    foreach (var ptModel in GetCornersModel(bbox))
                    {
                        var ptV = viewTInv.OfPoint(ptModel);
                        minX = Math.Min(minX, ptV.X);
                        minY = Math.Min(minY, ptV.Y);
                        maxX = Math.Max(maxX, ptV.X);
                        maxY = Math.Max(maxY, ptV.Y);
                        any = true;
                    }
                }

                if (!any) throw new ArgumentException("focusElements: could not compute a region (no valid bounding boxes).");

                var margin = Math.Max(0.0, region.marginFt);
                minX -= margin;
                minY -= margin;
                maxX += margin;
                maxY += margin;

                EnsureMinExtent(ref minX, ref minY, ref maxX, ref maxY, 0.5);
                return (minX, minY, maxX, maxY);
            }

            if (string.Equals(mode, "center", StringComparison.OrdinalIgnoreCase))
            {
                var halfW = Math.Max(0.0, region.halfWidth);
                var halfH = Math.Max(0.0, region.halfHeight);
                if (halfW <= 1e-9 || halfH <= 1e-9) throw new ArgumentException("region.halfWidth and region.halfHeight must be > 0 for mode 'center'.");

                XYZ origin;
                try { origin = originalView.Origin; }
                catch { origin = tempCrop.Transform.Origin; }

                var coordinateSpace = (region.coordinateSpace ?? "view").Trim();
                XYZ centerModel;
                if (coordinateSpace.Equals("model_xy", StringComparison.OrdinalIgnoreCase))
                {
                    centerModel = new XYZ(region.centerX, region.centerY, origin.Z);
                }
                else if (coordinateSpace.Equals("view", StringComparison.OrdinalIgnoreCase) || coordinateSpace.Length == 0)
                {
                    centerModel = origin
                                + originalView.RightDirection.Multiply(region.centerX)
                                + originalView.UpDirection.Multiply(region.centerY);
                }
                else
                {
                    throw new ArgumentException($"Unsupported region.coordinateSpace '{region.coordinateSpace}'. Supported: view, model_xy");
                }

                var centerV = viewTInv.OfPoint(centerModel);
                var minX = centerV.X - halfW;
                var maxX = centerV.X + halfW;
                var minY = centerV.Y - halfH;
                var maxY = centerV.Y + halfH;

                EnsureMinExtent(ref minX, ref minY, ref maxX, ref maxY, 0.5);
                return (minX, minY, maxX, maxY);
            }

            throw new ArgumentException($"Unsupported region.mode '{region.mode}'. Supported: focusElements, center");
        }

        private static IEnumerable<XYZ> GetCornersModel(BoundingBoxXYZ bbox)
        {
            var t = bbox.Transform;
            var min = bbox.Min;
            var max = bbox.Max;

            var xs = new[] { min.X, max.X };
            var ys = new[] { min.Y, max.Y };
            var zs = new[] { min.Z, max.Z };

            foreach (var x in xs)
            foreach (var y in ys)
            foreach (var z in zs)
                yield return t.OfPoint(new XYZ(x, y, z));
        }

        private static void EnsureMinExtent(ref double minX, ref double minY, ref double maxX, ref double maxY, double minSizeFt)
        {
            if (maxX - minX < minSizeFt)
            {
                var c = (minX + maxX) / 2.0;
                minX = c - minSizeFt / 2.0;
                maxX = c + minSizeFt / 2.0;
            }
            if (maxY - minY < minSizeFt)
            {
                var c = (minY + maxY) / 2.0;
                minY = c - minSizeFt / 2.0;
                maxY = c + minSizeFt / 2.0;
            }
        }
    }
}

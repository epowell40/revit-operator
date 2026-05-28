using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using System.Collections.Generic;

namespace RevitBridge.Logic.Handlers
{
    public class ExportViewFrameHandler : IRequestHandler
    {
        public class Params
        {
            public long? viewId { get; set; }
            public int imageSize { get; set; } = 2200;
            public string folder { get; set; } = "";
            public bool includeMapping { get; set; } = true;
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
            if (!SelectionUtil.IsSupported2dView(view))
                throw new ArgumentException($"View type '{view.ViewType}' is not supported for Phase 1 export-view-frame.");

            var warnings = new List<string>();
            var restoreCropBoxActive = false;
            EnsureCropBoxActiveForFrameExport(doc, view, warnings, out restoreCropBoxActive);
            try
            {
                var folder = SelectionUtil.EnsureDefaultSelectionCaptureFolder(p.folder);
                var frameId = Guid.NewGuid().ToString("N");
                var stem = $"Revit_{RevitBridge.Common.ElementIdCompat.GetValue(view.Id)}_{frameId}_frame";
                var path = SelectionUtil.ExportViewImage(doc, view, p.imageSize, folder, stem);
                var (widthPx, heightPx) = SelectionUtil.ReadImageSize(path);
                var frame = SelectionUtil.BuildRasterAffineFrame(view, widthPx, heightPx);

                if (frame.AspectCorrectionApplied)
                {
                    warnings.Add(
                        $"export-view-frame adjusted the frame X span to match the exported raster aspect (crop={frame.CropAspect:0.000000}, raster={frame.RasterAspect:0.000000}).");
                }

                var stored = new StoredViewFrame
                {
                    frameId = frameId,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
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
                        "Derived from the exported raster frame; crop-box corners are included as reference only.");
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
                if (restoreCropBoxActive)
                {
                    TryRestoreCropBoxActive(doc, view, warnings);
                }
            }
        }

        private static void EnsureCropBoxActiveForFrameExport(Document doc, View view, List<string> warnings, out bool restoreAfter)
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
                using (var tx = new Transaction(doc, "Operator Export View Frame (Activate Crop Box)"))
                {
                    tx.Start();
                    view.CropBoxActive = true;
                    doc.Regenerate();
                    tx.Commit();
                }
                restoreAfter = true;
                warnings.Add("export-view-frame temporarily activated CropBoxActive for deterministic mapping.");
            }
            catch (Exception ex)
            {
                throw new ArgumentException(
                    "Phase 1 requires an active crop box and auto-activation failed: " + ex.Message +
                    ". Activate crop in the target view or use /revit/export-view-region.",
                    ex
                );
            }
        }

        private static void TryRestoreCropBoxActive(Document doc, View view, List<string> warnings)
        {
            try
            {
                using (var tx = new Transaction(doc, "Operator Export View Frame (Restore Crop Box)"))
                {
                    tx.Start();
                    view.CropBoxActive = false;
                    doc.Regenerate();
                    tx.Commit();
                }
                warnings.Add("export-view-frame restored CropBoxActive to false after capture.");
            }
            catch (Exception ex)
            {
                warnings.Add("export-view-frame warning: failed to restore CropBoxActive: " + ex.Message);
            }
        }
    }
}


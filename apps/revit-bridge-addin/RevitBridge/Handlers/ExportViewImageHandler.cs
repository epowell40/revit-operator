using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public class ExportViewImageHandler : IRequestHandler
    {
        public class Params
        {
            public long? viewId { get; set; }
            public int imageSize { get; set; } = 2048;
            public string folder { get; set; } = "";
            public string? exportMode { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var exportMode = OperatorViewImageContract.ResolveMode(p.exportMode);
            var visibleRegion = exportMode == OperatorViewImageContract.VisibleRegion;
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new Exception("No active UI document.");
            var doc = uidoc.Document;
            
            View view = null;
            if (p.viewId.HasValue)
            {
                view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
            }
            else
            {
                view = doc.ActiveView;
            }

            if (view == null) throw new Exception("View not found.");

            var requestedViewId = ElementIdCompat.GetValue(view.Id);
            OperatorViewportObservation ObserveViewport()
            {
                var active = uidoc.ActiveView;
                var uiView = uidoc.GetOpenUIViews().FirstOrDefault(candidate => candidate.ViewId == view.Id);
                return OperatorViewImageContract.RequireViewport(requestedViewId,
                    active == null ? (long?)null : ElementIdCompat.GetValue(active.Id),
                    uiView == null ? (long?)null : ElementIdCompat.GetValue(uiView.ViewId),
                    uiView?.GetZoomCorners().Select(point => new[] { point.X, point.Y, point.Z }).ToArray());
            }
            var viewport = visibleRegion ? ObserveViewport() : null;

            string tempDir = WorkspacePaths.ResolveDirectoryUnderWorkspace(p.folder, "artifacts", "captures");
            
            string fileName = $"Revit_{RevitBridge.Common.ElementIdCompat.GetValue(view.Id)}_{DateTime.Now:yyyyMMddHHmmss}";
            if (visibleRegion) fileName += "_" + Guid.NewGuid().ToString("N");
            string filePath = Path.Combine(tempDir, fileName);

            ImageExportOptions options = new ImageExportOptions
            {
                ZoomType = ZoomFitType.FitToPage,
                PixelSize = p.imageSize,
                FilePath = filePath,
                FitDirection = FitDirectionType.Horizontal,
                ExportRange = visibleRegion ? ExportRange.VisibleRegionOfCurrentView : ExportRange.SetOfViews
            };
            if (!visibleRegion) options.SetViewsAndSheets(new List<ElementId> { view.Id });

            doc.ExportImage(options);
            if (viewport != null) OperatorViewImageContract.RequireUnchanged(viewport, ObserveViewport());

            var actualFile = ExportedImagePathResolver.Resolve(filePath);
            if (string.IsNullOrWhiteSpace(actualFile) || !File.Exists(actualFile))
            {
                throw new FileNotFoundException("Revit image export completed, but no exported image file was found.", filePath);
            }

            int? widthPx = null, heightPx = null;
            if (visibleRegion)
            {
                using (var image = System.Drawing.Image.FromFile(actualFile)) { widthPx = image.Width; heightPx = image.Height; }
            }

            return Task.FromResult<object>(new
            {
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                viewName = view.Name,
                exportMode,
                activeViewId = uidoc.ActiveView == null ? (long?)null : ElementIdCompat.GetValue(uidoc.ActiveView.Id),
                widthPx, heightPx,
                viewport = viewport == null ? null : new { source = "UIDocument.ActiveView/UIView.GetZoomCorners",
                    viewId = viewport.ViewId, viewType = view.ViewType.ToString(), zoomCornersXyz = viewport.ZoomCornersXyz,
                    coordinateUnits = "feet", displayPlaneOnly = true, placementMappingAvailable = false },
                path = actualFile,
                timestamp = DateTime.Now.ToString("o")
            });
        }
    }
}

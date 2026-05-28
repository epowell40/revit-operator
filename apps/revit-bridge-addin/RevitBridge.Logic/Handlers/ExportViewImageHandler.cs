using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class ExportViewImageHandler : IRequestHandler
    {
        public class Params
        {
            public long? viewId { get; set; }
            public int imageSize { get; set; } = 2048;
            public string folder { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
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

            // Ensure annotation/tag text reflects the latest model state before export.
            try { doc.Regenerate(); } catch { }
            try { uidoc.RefreshActiveView(); } catch { }

            string tempDir = WorkspacePaths.ResolveDirectoryUnderWorkspace(p.folder, "artifacts", "captures");

            string fileName = $"Revit_{RevitBridge.Common.ElementIdCompat.GetValue(view.Id)}_{DateTime.Now:yyyyMMddHHmmss}";
            string filePath = Path.Combine(tempDir, fileName);

            ImageExportOptions options = new ImageExportOptions
            {
                ZoomType = ZoomFitType.FitToPage,
                PixelSize = p.imageSize,
                FilePath = filePath,
                FitDirection = FitDirectionType.Horizontal,
                ExportRange = ExportRange.SetOfViews
            };
            options.SetViewsAndSheets(new List<ElementId> { view.Id });

            doc.ExportImage(options);

            // Revit appends .png or other extensions
            string actualFile = filePath + ".png";
            if (!File.Exists(actualFile))
            {
                actualFile = filePath + ".jpg";
            }

            return Task.FromResult<object>(new
            {
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                viewName = view.Name,
                path = actualFile,
                timestamp = DateTime.Now.ToString("o")
            });
        }
    }
}


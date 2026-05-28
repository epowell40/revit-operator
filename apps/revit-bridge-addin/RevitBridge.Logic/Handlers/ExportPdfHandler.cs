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
    public class ExportPdfHandler : IRequestHandler
    {
        public class Params
        {
            public List<long> viewIds { get; set; }
            public string fileName { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            string tempDir = WorkspacePaths.EnsureDir("artifacts", "prints");
            
            string fName = string.IsNullOrEmpty(p.fileName) ? $"Print_{DateTime.Now:yyyyMMddHHmmss}" : p.fileName;
            fName = (fName ?? "").Trim();
            fName = fName.Replace(Path.DirectorySeparatorChar, '_').Replace(Path.AltDirectorySeparatorChar, '_');
            fName = Path.GetFileName(fName);
            if (string.IsNullOrWhiteSpace(fName)) fName = $"Print_{DateTime.Now:yyyyMMddHHmmss}";
            if (!fName.EndsWith(".pdf")) fName += ".pdf";
            string fullPath = Path.Combine(tempDir, fName);

            using (Transaction trans = new Transaction(doc, "Export PDF"))
            {
                trans.Start();
                
                // Revit 2022+ PDF Export
                PDFExportOptions options = new PDFExportOptions();
                options.FileName = fName; // Just name, it uses directory later or combined? 
                // Actually in 2022+ typically use Export(folder, name, options) method on Document? No. 
                // doc.Export(folder, name, viewIds, options)
                
                options.Combine = true;
                
                IList<ElementId> vIds = new List<ElementId>();
                foreach(long id in p.viewIds) vIds.Add(RevitBridge.Common.ElementIdCompat.Create(id));

                doc.Export(tempDir, vIds, options);

                trans.Commit(); // Export might not strictly need transaction but good practice if settings change
            }

            return Task.FromResult<object>(new 
            { 
                status = "Success", 
                path = fullPath 
            });
        }
    }
}


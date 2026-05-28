using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class OpenModelHandler : IRequestHandler
    {
        public class Params
        {
            public string filePath { get; set; }
            public bool audit { get; set; } = false;
            public bool detach { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new Exception("Invalid request body.");
            if (string.IsNullOrWhiteSpace(p.filePath)) throw new Exception("filePath is required.");

            // Phase 0 hardening: all file IO must stay inside the per-user workspace.
            var filePath = WorkspacePaths.ResolveExistingFileUnderWorkspace(p.filePath);

            // Opening a document usually requires no active transaction, 
            // but must be done on UI thread (which we are).
            
            ModelPath modelPath = ModelPathUtils.ConvertUserVisiblePathToModelPath(filePath);
            OpenOptions opts = new OpenOptions();
            opts.Audit = p.audit;
            
            if (p.detach)
            {
                opts.DetachFromCentralOption = DetachFromCentralOption.DetachAndPreserveWorksets;
            }

            try 
            {
                UIDocument uidoc = app.OpenAndActivateDocument(modelPath, opts, false);
                return Task.FromResult<object>(new 
                { 
                    status = "Success", 
                    title = uidoc.Document.Title,
                    path = uidoc.Document.PathName
                });
            }
            catch (Exception ex)
            {
                // If it fails (e.g., already open), we might try to just activate it?
                foreach(Document d in app.Application.Documents)
                {
                    if (d.PathName.Equals(filePath, StringComparison.OrdinalIgnoreCase))
                    {
                        // Already open, try to activate (limited API for activation without open)
                        // But OpenAndActivate usually handles switching if already open? 
                        // Sometimes it throws if already active.
                        return Task.FromResult<object>(new { status = "Already Open", title = d.Title });
                    }
                }
                throw ex;
            }
        }
    }
}


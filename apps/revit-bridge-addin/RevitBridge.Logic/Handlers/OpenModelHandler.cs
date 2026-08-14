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
            public bool discardExistingOpenDocument { get; set; } = false;
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

            var existing = FindOpenDocument(app, filePath);
            if (existing != null)
            {
                var active = app.ActiveUIDocument?.Document;
                if (active != null && active.Equals(existing))
                    return Task.FromResult<object>(new { status = "Already Active", title = existing.Title, path = existing.PathName });

                if (!p.discardExistingOpenDocument)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Already Open Inactive",
                        title = existing.Title,
                        path = existing.PathName,
                        activeTitle = active?.Title,
                        requiresExplicitDiscardAndReopen = true
                    });
                }

                return Task.FromResult(ReopenInactiveDocument(app, existing, modelPath, opts, filePath));
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
                var racedOpenDocument = FindOpenDocument(app, filePath);
                if (racedOpenDocument != null)
                {
                    var active = app.ActiveUIDocument?.Document;
                    if (active != null && active.Equals(racedOpenDocument))
                    {
                        return Task.FromResult<object>(new { status = "Already Active", title = racedOpenDocument.Title, path = racedOpenDocument.PathName });
                    }

                    if (p.discardExistingOpenDocument)
                        return Task.FromResult(ReopenInactiveDocument(app, racedOpenDocument, modelPath, opts, filePath));

                    throw new InvalidOperationException(
                        $"The requested model is open but inactive. Retry with discardExistingOpenDocument=true only when discarding unsaved changes is explicitly authorized: {filePath}",
                        ex);
                }
                throw;
            }
        }

        private static object ReopenInactiveDocument(
            UIApplication app,
            Document existing,
            ModelPath modelPath,
            OpenOptions opts,
            string filePath)
        {
            var discardedUnsavedChanges = existing.IsModified;
            if (!existing.Close(false))
                throw new InvalidOperationException($"Revit did not close the inactive document before reopening it: {filePath}");

            UIDocument reopened = app.OpenAndActivateDocument(modelPath, opts, false);
            return new
            {
                status = "Reopened and Activated",
                title = reopened.Document.Title,
                path = reopened.Document.PathName,
                discardedUnsavedChanges
            };
        }

        private static Document? FindOpenDocument(UIApplication app, string filePath)
        {
            foreach (Document document in app.Application.Documents)
            {
                // Linked documents cannot be activated, saved, or closed as
                // top-level UI documents. Ignore them when resolving an
                // already-open project that may be discarded and reopened.
                if (document.IsLinked) continue;
                if (string.Equals(document.PathName, filePath, StringComparison.OrdinalIgnoreCase))
                    return document;
            }

            return null;
        }
    }
}


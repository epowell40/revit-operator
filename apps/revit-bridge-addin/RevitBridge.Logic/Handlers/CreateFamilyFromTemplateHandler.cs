using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class CreateFamilyFromTemplateHandler : IRequestHandler
    {
        public class Params
        {
            public string templatePath { get; set; } = "";
            public string savePath { get; set; } = "";
            public bool overwriteExistingFile { get; set; } = false;
            public bool loadIntoProject { get; set; } = false;
            public bool overwriteParameterValuesOnLoad { get; set; } = false;
        }

        private class FamilyLoadOptions : IFamilyLoadOptions
        {
            private readonly bool _overwriteParameterValues;

            public FamilyLoadOptions(bool overwriteParameterValues)
            {
                _overwriteParameterValues = overwriteParameterValues;
            }

            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues)
            {
                overwriteParameterValues = _overwriteParameterValues;
                return true;
            }

            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            {
                source = FamilySource.Family;
                overwriteParameterValues = _overwriteParameterValues;
                return true;
            }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new Exception("Invalid request body.");
            if (string.IsNullOrWhiteSpace(p.templatePath)) throw new Exception("templatePath is required.");
            if (string.IsNullOrWhiteSpace(p.savePath)) throw new Exception("savePath is required.");

            // Phase 0 hardening: all file IO must stay inside the per-user workspace.
            var templatePath = WorkspacePaths.ResolveExistingFileUnderWorkspace(p.templatePath);
            var savePath = WorkspacePaths.ResolveFileUnderWorkspace(p.savePath);

            string? dir = Path.GetDirectoryName(savePath);
            if (!string.IsNullOrWhiteSpace(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);

            if (File.Exists(savePath) && !p.overwriteExistingFile)
                throw new Exception($"Family file already exists (set overwriteExistingFile=true to overwrite): {savePath}");

            Document famDoc = null;
            try
            {
                famDoc = app.Application.NewFamilyDocument(templatePath);
                if (famDoc == null) throw new Exception("Failed to create family document from template.");

                var saveOpts = new SaveAsOptions
                {
                    OverwriteExistingFile = p.overwriteExistingFile,
                    Compact = true
                };
                famDoc.SaveAs(savePath, saveOpts);
            }
            finally
            {
                if (famDoc != null)
                {
                    try { famDoc.Close(false); } catch { /* ignore */ }
                }
            }

            object load = null;
            if (p.loadIntoProject)
            {
                var projDoc = app.ActiveUIDocument.Document;
                if (projDoc.IsFamilyDocument) throw new Exception("Active document is a family document. Open a project document (.rvt) to load families.");

                using (var t = new Transaction(projDoc, "Load Family"))
                {
                    t.Start();
                    try
                    {
                        bool loaded = projDoc.LoadFamily(savePath, new FamilyLoadOptions(p.overwriteParameterValuesOnLoad), out Family family);
                        if (family == null) throw new Exception("Revit did not return a Family after loading.");

                        var symbols = family.GetFamilySymbolIds()
                            .Select(id => projDoc.GetElement(id))
                            .OfType<FamilySymbol>()
                            .Select(s => new { id = RevitBridge.Common.ElementIdCompat.GetValue(s.Id), name = s.Name })
                            .ToList();

                        load = new
                        {
                            status = loaded ? "Loaded" : "AlreadyLoaded",
                            loaded,
                            familyId = RevitBridge.Common.ElementIdCompat.GetValue(family.Id),
                            familyName = family.Name,
                            symbols
                        };

                        t.Commit();
                    }
                    catch
                    {
                        t.RollBack();
                        throw;
                    }
                }
            }

            return Task.FromResult<object>(new
            {
                status = "Created",
                filePath = savePath,
                load
            });
        }
    }
}

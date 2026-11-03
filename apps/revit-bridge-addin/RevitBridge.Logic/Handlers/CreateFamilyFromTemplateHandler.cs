using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.FamilyEvolution;

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
            public PrimitiveFamilyDefinition? geometry { get; set; }
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
            var projDoc = app.ActiveUIDocument?.Document;
            string templatePath, savePath;
            // This block performs reads/validation only. Once directory creation
            // or NewFamilyDocument begins, failures must retain unknown effects.
            try
            {
                if (string.IsNullOrWhiteSpace(p.templatePath)) throw new Exception("templatePath is required.");
                if (string.IsNullOrWhiteSpace(p.savePath)) throw new Exception("savePath is required.");
                p.geometry?.Validate();
                if (p.loadIntoProject && (projDoc == null || projDoc.IsFamilyDocument))
                    throw new Exception("Open a project document (.rvt) to load families.");
                templatePath = p.templatePath.StartsWith("installed:", StringComparison.Ordinal)
                    ? InstalledFamilyTemplate.Resolve(app.Application.FamilyTemplatePath, p.templatePath.Substring("installed:".Length))
                    : WorkspacePaths.ResolveFileUnderWorkspaceReadOnly(p.templatePath);
                if (!File.Exists(templatePath)) throw new FileNotFoundException("Template file not found: " + templatePath);
                savePath = WorkspacePaths.ResolveFileUnderWorkspaceReadOnly(p.savePath);
                if (!string.Equals(Path.GetExtension(savePath), ".rfa", StringComparison.OrdinalIgnoreCase))
                    throw new Exception("savePath must name an .rfa file.");
                if (p.geometry != null && p.loadIntoProject && new FilteredElementCollector(projDoc!)
                    .OfClass(typeof(Family)).Cast<Family>().Any(f => string.Equals(f.Name, Path.GetFileNameWithoutExtension(savePath), StringComparison.OrdinalIgnoreCase)))
                    throw new Exception("A family with this name is already loaded. Choose a new savePath/name to preserve existing families.");
                if (File.Exists(savePath) && (!p.overwriteExistingFile || p.geometry != null))
                    throw new Exception(p.geometry != null ? "Generic family output already exists; choose a new savePath: " + savePath
                        : "Family file already exists (set overwriteExistingFile=true to overwrite): " + savePath);
            }
            catch (Exception error) { return Task.FromResult(OperatorFamilyCreationReceipt.Rejected(error.Message)); }

            string? dir = Path.GetDirectoryName(savePath);
            if (!string.IsNullOrWhiteSpace(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);

            Document famDoc = null;
            object geometry = null;
            bool savedPathMatches = false, closed = false;
            try
            {
                famDoc = app.Application.NewFamilyDocument(templatePath);
                if (famDoc == null) throw new Exception("Failed to create family document from template.");
                if (p.geometry != null) geometry = PrimitiveFamilyBuilder.Build(famDoc, p.geometry);

                var saveOpts = new SaveAsOptions
                {
                    OverwriteExistingFile = p.geometry == null && p.overwriteExistingFile,
                    Compact = true
                };
                famDoc.SaveAs(savePath, saveOpts);
                savedPathMatches = string.Equals(Path.GetFullPath(famDoc.PathName), savePath, StringComparison.OrdinalIgnoreCase);
            }
            finally
            {
                if (famDoc != null)
                {
                    closed = famDoc.Close(false);
                }
            }
            if (!closed) throw new Exception("Created family document did not close; retain the saved file and reconcile the open document.");
            var savedFile = OperatorFamilySaveReceipt.Saved(Guid.NewGuid().ToString("N"), savePath, savedPathMatches);

            object load = null;
            long? loadedFamilyId = null;
            bool loadCommitted = false;
            if (p.loadIntoProject)
            {
                using (var t = new Transaction(projDoc!, "Load Family"))
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

                        if (t.Commit() != TransactionStatus.Committed)
                            throw new Exception("Family load did not commit; the saved RFA remains at " + savePath);
                        loadedFamilyId = ElementIdCompat.GetValue(family.Id);
                        loadCommitted = true;
                    }
                    catch
                    {
                        if (t.GetStatus() == TransactionStatus.Started) t.RollBack();
                        throw;
                    }
                }
            }

            return Task.FromResult<object>(new
            {
                ok = true,
                status = "Created",
                filePath = savePath,
                geometry,
                load,
                family_creation_receipt = OperatorFamilyCreationReceipt.Created(savedFile, p.loadIntoProject, loadedFamilyId, loadCommitted)
            });
        }
    }
}

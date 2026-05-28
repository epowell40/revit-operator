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
    public class LoadFamilyHandler : IRequestHandler
    {
        public class Params
        {
            public string filePath { get; set; } = "";
            public bool overwriteParameterValues { get; set; } = false;
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
            if (string.IsNullOrWhiteSpace(p.filePath)) throw new Exception("filePath is required.");

            // Phase 0 hardening: all file IO must stay inside the per-user workspace.
            var filePath = WorkspacePaths.ResolveExistingFileUnderWorkspace(p.filePath);

            var doc = app.ActiveUIDocument.Document;
            if (doc.IsFamilyDocument) throw new Exception("Active document is a family document. Open a project document (.rvt) to load families.");

            using (var t = new Transaction(doc, "Load Family"))
            {
                t.Start();
                try
                {
                    bool loaded = doc.LoadFamily(filePath, new FamilyLoadOptions(p.overwriteParameterValues), out Family family);
                    if (family == null) throw new Exception("Revit did not return a Family after loading.");

                    var symbols = family.GetFamilySymbolIds()
                        .Select(id => doc.GetElement(id))
                        .OfType<FamilySymbol>()
                        .Select(s => new { id = RevitBridge.Common.ElementIdCompat.GetValue(s.Id), name = s.Name })
                        .ToList();

                    t.Commit();

                    return Task.FromResult<object>(new
                    {
                        status = loaded ? "Loaded" : "AlreadyLoaded",
                        loaded,
                        familyId = RevitBridge.Common.ElementIdCompat.GetValue(family.Id),
                        familyName = family.Name,
                        symbols
                    });
                }
                catch
                {
                    t.RollBack();
                    throw;
                }
            }
        }
    }
}

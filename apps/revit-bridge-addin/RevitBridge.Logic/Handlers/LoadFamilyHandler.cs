using System;
using System.Collections.Generic;
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
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope => HandleCore(app, jsonData, enterNativeScope)));

        private object HandleCore(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new Exception("Invalid request body.");
            if (string.IsNullOrWhiteSpace(p.filePath)) throw new Exception("filePath is required.");

            // Phase 0 hardening: all file IO must stay inside the per-user workspace.
            var filePath = WorkspacePaths.ResolveExistingFileUnderWorkspace(p.filePath);

            var doc = app.ActiveUIDocument.Document;
            if (doc.IsFamilyDocument) throw new Exception("Active document is a family document. Open a project document (.rvt) to load families.");

            var beforeIds = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
                .SelectMany(family => family.GetFamilySymbolIds().Select(ElementIdCompat.GetValue)
                    .Concat(new[] { ElementIdCompat.GetValue(family.Id) })).ToHashSet();
            long familyId = 0;
            bool loaded = false;
            enterNativeScope();
            var result = NativeSingleTransaction.Execute(app, doc, "Load Family", nativeCreated =>
            {
                loaded = doc.LoadFamily(filePath, new FamilyLoadOptions(p.overwriteParameterValues), out Family family);
                if (family == null) throw new Exception("Revit did not return a Family after loading.");
                familyId = ElementIdCompat.GetValue(family.Id);
                foreach (var id in family.GetFamilySymbolIds().Select(ElementIdCompat.GetValue).Concat(new[] { familyId }))
                    if (!beforeIds.Contains(id)) nativeCreated.Add(id);
                return new Dictionary<string, object?>
                {
                    ["loaded"] = loaded, ["familyId"] = familyId, ["familyName"] = family.Name
                };
            });
            OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                var family = doc.GetElement(ElementIdCompat.Create(familyId)) as Family
                    ?? throw new InvalidOperationException("Loaded family did not survive native commit.");
                var symbols = family.GetFamilySymbolIds().Select(id => doc.GetElement(id)).OfType<FamilySymbol>()
                    .Select(symbol => new { id = ElementIdCompat.GetValue(symbol.Id), name = symbol.Name }).ToList();
                return new Dictionary<string, object?> { ["familyName"] = family.Name, ["symbols"] = symbols };
            });
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, loaded ? "Loaded" : "AlreadyLoaded");
            return result;
        }
    }
}

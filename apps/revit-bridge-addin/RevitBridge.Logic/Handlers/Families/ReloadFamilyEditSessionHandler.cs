using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class ReloadFamilyEditSessionHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string familyDocumentId { get; set; } = "";
            public bool overwriteParameterValues { get; set; } = true;
            public bool closeSession { get; set; } = true;
        }

        private sealed class AlwaysOverwriteLoadOptions : IFamilyLoadOptions
        {
            private readonly bool _overwrite;
            public AlwaysOverwriteLoadOptions(bool overwrite) { _overwrite = overwrite; }
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues)
            {
                overwriteParameterValues = _overwrite;
                return true;
            }
            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            {
                source = FamilySource.Family;
                overwriteParameterValues = _overwrite;
                return true;
            }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");

            if (!FamilyEditSessionStore.TryGet(p.familyDocumentId, out var session, out var err))
                throw new InvalidOperationException(err ?? "Family edit session not found.");

            var proj = session.ProjectDoc;
            var famDoc = session.FamilyDoc;
            if (!proj.Equals(uidoc.Document) || !proj.IsValidObject || !famDoc.IsValidObject)
                throw new InvalidOperationException("The family session does not belong to the active project.");

            Family? loaded = null;
            var ok = false;
            object? reloadReceipt = null;
            try
            {
                loaded = famDoc.LoadFamily(proj, new AlwaysOverwriteLoadOptions(p.overwriteParameterValues));
                ok = loaded != null && loaded.IsValidObject && proj.Equals(loaded.Document)
                    && proj.GetElement(loaded.UniqueId) is Family observed && observed.Id == loaded.Id;
                if (ok) reloadReceipt = OperatorFamilyReloadReceipt.Loaded(session.SessionId,
                    ElementIdCompat.GetValue(loaded!.Id), loaded.UniqueId, true);
            }
            catch (Exception ex)
            {
                return Task.FromResult<object>(new { ok = false, error = ex.Message, familyDocumentId = session.SessionId, familyName = session.FamilyName });
            }

            try { proj.Regenerate(); } catch { }
            try { uidoc.RefreshActiveView(); } catch { }

            if (p.closeSession && ok)
            {
                try { FamilyEditSessionStore.TryClose(session.SessionId, out var _); } catch { }
            }

            var symbols = new System.Collections.Generic.List<object>();
            try
            {
                if (loaded != null)
                {
                    foreach (var sid in loaded.GetFamilySymbolIds())
                    {
                        var sym = proj.GetElement(sid) as FamilySymbol;
                        if (sym == null) continue;
                        symbols.Add(new { id = RevitBridge.Common.ElementIdCompat.GetValue(sym.Id), name = sym.Name });
                    }
                }
            }
            catch { }

            return Task.FromResult<object>(new
            {
                ok = ok,
                family_reload_receipt = reloadReceipt,
                status = ok ? "Reloaded" : "Failed",
                familyDocumentId = session.SessionId,
                familyName = loaded?.Name ?? session.FamilyName,
                originalFamilyId = session.FamilyId,
                loadedFamilyId = RevitBridge.Common.ElementIdCompat.GetValue(loaded?.Id),
                familyId = RevitBridge.Common.ElementIdCompat.GetValue(loaded?.Id),
                symbols
            });
        }
    }
}

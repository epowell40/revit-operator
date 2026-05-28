using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class EditFamilyFromInstanceHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long elementId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.elementId == 0) throw new InvalidOperationException("edit-family-from-instance.elementId is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Active document is a family document. Open a project document (.rvt).");

            var el = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.elementId));
            if (el == null) throw new InvalidOperationException($"Element {p.elementId} not found.");
            if (!(el is FamilyInstance fi)) throw new InvalidOperationException("Element is not a FamilyInstance.");

            var symbol = fi.Symbol;
            if (symbol == null) throw new InvalidOperationException("FamilyInstance has no type (Symbol).");
            var fam = symbol.Family;
            if (fam == null) throw new InvalidOperationException("FamilyInstance type has no Family.");

            // Only allow titleblock instances for now (explicit scope for safety).
            try
            {
                var catId = RevitBridge.Common.ElementIdCompat.GetValue(fi.Category?.Id);
                if (catId != (int)BuiltInCategory.OST_TitleBlocks)
                    throw new InvalidOperationException("Only titleblock instances are supported for edit-family-from-instance.");
            }
            catch
            {
                // best effort; if category read fails, continue
            }

            Document? famDoc = null;
            try
            {
                famDoc = doc.EditFamily(fam);
                if (famDoc == null) throw new InvalidOperationException("Failed to open family document for editing.");
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException("Failed to open family for editing: " + ex.Message, ex);
            }

            var session = FamilyEditSessionStore.Create(doc, famDoc, fam, titleblockTypeId: RevitBridge.Common.ElementIdCompat.GetValue(symbol.Id));
            return Task.FromResult<object>(new
            {
                ok = true,
                familyDocumentId = session.SessionId,
                familyName = session.FamilyName,
                familyId = session.FamilyId,
                titleblockTypeId = session.TitleblockTypeId,
                instanceElementId = RevitBridge.Common.ElementIdCompat.GetValue(fi.Id)
            });
        }
    }
}


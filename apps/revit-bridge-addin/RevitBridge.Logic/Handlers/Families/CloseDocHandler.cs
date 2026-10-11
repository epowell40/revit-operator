using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;
namespace RevitBridge.Logic.Handlers
{
    public sealed class CloseDocHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? docId { get; set; }
            public string? familyDocumentId { get; set; }
            public bool saveChanges { get; set; } = false;
        }
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var sid = (p.docId ?? p.familyDocumentId ?? "").Trim();
            if (!FamilyEditSessionStore.TryGet(sid, out var session, out var err))
                throw new InvalidOperationException(err ?? "Family edit session not found.");
            if (!session.ProjectDoc.IsValidObject || !session.ProjectDoc.Equals(app.ActiveUIDocument?.Document))
                throw new InvalidOperationException("The family session does not belong to the active project.");
            var famDoc = session.FamilyDoc;
            var path = famDoc.PathName ?? "";
            object? saveReceipt = null;
            if (p.saveChanges)
            {
                if (string.IsNullOrWhiteSpace(path))
                    throw new InvalidOperationException("Save the family to an explicit file before closing with saveChanges.");
                // A failed save must retain the open session and its edits.
                famDoc.Save();
                saveReceipt = OperatorFamilySaveReceipt.Saved(sid, path, string.Equals(famDoc.PathName, path, StringComparison.OrdinalIgnoreCase));
            }
            if (!FamilyEditSessionStore.TryClose(sid, out err))
                throw new InvalidOperationException(err ?? "Family close failed; session retained.");
            return Task.FromResult<object>(new { ok = true, closed = true, saved = p.saveChanges,
                filePath = string.IsNullOrWhiteSpace(path) ? null : path, docId = sid, familyDocumentId = sid,
                family_save_receipt = saveReceipt,
                family_close_receipt = OperatorFamilyCloseReceipt.Closed(sid, p.saveChanges, !famDoc.IsValidObject, true) });
        }
    }
}

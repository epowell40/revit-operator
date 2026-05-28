using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class OpenFamilyDocHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? filePath { get; set; }
            public long? familyId { get; set; }

            // Convenience: same as edit-family-from-instance elementId
            public long? titleblockInstanceId { get; set; }
            public long? elementId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var projectDoc = uidoc.Document;

            var tbId = p.titleblockInstanceId ?? p.elementId;
            if (tbId.HasValue && tbId.Value != 0)
            {
                // Delegate to the existing handler (creates a session).
                var req = new EditFamilyFromInstanceHandler.Params { elementId = tbId.Value };
                var raw = new EditFamilyFromInstanceHandler().Handle(app, JsonSerializer.Serialize(req)).GetAwaiter().GetResult();
                return Task.FromResult(raw);
            }

            if (!string.IsNullOrWhiteSpace(p.filePath))
            {
                var fp = (p.filePath ?? "").Trim();
                if (!File.Exists(fp)) throw new InvalidOperationException($"Family file not found: {fp}");
                var ext = Path.GetExtension(fp) ?? "";
                if (!string.Equals(ext, ".rfa", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("open-family-doc currently supports .rfa files only.");

                var famDoc = app.Application.OpenDocumentFile(fp);
                if (famDoc == null) throw new InvalidOperationException("Failed to open family document.");

                var session = FamilyEditSessionStore.CreateFromExternalFile(projectDoc, famDoc);
                return Task.FromResult<object>(new
                {
                    ok = true,
                    docId = session.SessionId,
                    familyDocId = session.SessionId,
                    familyDocumentId = session.SessionId,
                    title = famDoc.Title,
                    familyName = session.FamilyName,
                    sourceFilePath = fp
                });
            }

            if (p.familyId.HasValue && p.familyId.Value != 0)
            {
                var fam = projectDoc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.familyId.Value)) as Family;
                if (fam == null) throw new InvalidOperationException($"Family {p.familyId.Value} not found in the active document.");
                var famDoc = projectDoc.EditFamily(fam);
                var session = FamilyEditSessionStore.Create(projectDoc, famDoc, fam, titleblockTypeId: 0);
                return Task.FromResult<object>(new
                {
                    ok = true,
                    docId = session.SessionId,
                    familyDocId = session.SessionId,
                    familyDocumentId = session.SessionId,
                    title = famDoc.Title,
                    familyName = session.FamilyName
                });
            }

            throw new InvalidOperationException("open-family-doc requires one of: {filePath} OR {familyId} OR {titleblockInstanceId/elementId}.");
        }
    }
}


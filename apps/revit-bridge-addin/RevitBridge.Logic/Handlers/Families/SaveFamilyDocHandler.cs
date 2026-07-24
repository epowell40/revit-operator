using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class SaveFamilyDocHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? docId { get; set; }
            public string? familyDocumentId { get; set; }
            public string? filePath { get; set; }
            public bool overwrite { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var sid = (p.docId ?? p.familyDocumentId ?? "").Trim();
            if (!FamilyEditSessionStore.TryGet(sid, out var session, out var err))
                throw new InvalidOperationException(err ?? "Family edit session not found.");

            var famDoc = session.FamilyDoc;
            var requestedPath = (p.filePath ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(requestedPath))
            {
                var saveAsPath = WorkspacePaths.ResolveFileUnderWorkspace(requestedPath);
                if (!string.Equals(Path.GetExtension(saveAsPath), ".rfa", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("save-family-doc.filePath must end in .rfa.");

                var directory = Path.GetDirectoryName(saveAsPath);
                if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
                if (File.Exists(saveAsPath) && !p.overwrite)
                    throw new InvalidOperationException($"Family file already exists and overwrite=false: {saveAsPath}");

                try
                {
                    famDoc.SaveAs(saveAsPath, new SaveAsOptions
                    {
                        Compact = true,
                        OverwriteExistingFile = p.overwrite
                    });
                    return Task.FromResult<object>(new
                    {
                        ok = true,
                        saved = true,
                        saveMode = "save_as",
                        filePath = saveAsPath,
                        docId = session.SessionId,
                        familyDocumentId = session.SessionId,
                        title = famDoc.Title
                    });
                }
                catch (Exception ex)
                {
                    return Task.FromResult<object>(new
                    {
                        ok = false,
                        saved = false,
                        saveMode = "save_as",
                        filePath = saveAsPath,
                        error = ex.Message,
                        docId = session.SessionId,
                        familyDocumentId = session.SessionId,
                        title = famDoc.Title
                    });
                }
            }

            var path = "";
            try { path = famDoc.PathName ?? ""; } catch { path = ""; }

            if (string.IsNullOrWhiteSpace(path))
            {
                return Task.FromResult<object>(new
                {
                    ok = true,
                    saved = false,
                    reason = "unknown_path",
                    docId = session.SessionId,
                    familyDocumentId = session.SessionId,
                    title = famDoc.Title
                });
            }

            try
            {
                famDoc.Save();
                return Task.FromResult<object>(new
                {
                    ok = true,
                    saved = true,
                    saveMode = "save",
                    filePath = path,
                    docId = session.SessionId,
                    familyDocumentId = session.SessionId,
                    title = famDoc.Title
                });
            }
            catch (Exception ex)
            {
                return Task.FromResult<object>(new
                {
                    ok = false,
                    saved = false,
                    saveMode = "save",
                    filePath = path,
                    error = ex.Message,
                    docId = session.SessionId,
                    familyDocumentId = session.SessionId,
                    title = famDoc.Title
                });
            }
        }
    }
}


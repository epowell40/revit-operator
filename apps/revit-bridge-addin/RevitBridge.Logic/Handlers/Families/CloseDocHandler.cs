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

            var famDoc = session.FamilyDoc;
            var path = "";
            try { path = famDoc.PathName ?? ""; } catch { path = ""; }

            var saved = false;
            if (p.saveChanges)
            {
                try
                {
                    if (!string.IsNullOrWhiteSpace(path))
                    {
                        famDoc.Save();
                        saved = true;
                    }
                }
                catch
                {
                    // ignore save errors; still close
                }
            }

            try { famDoc.Close(false); } catch { }
            try { FamilyEditSessionStore.TryRemove(session.SessionId, out var _); } catch { }

            return Task.FromResult<object>(new
            {
                ok = true,
                closed = true,
                saved,
                filePath = string.IsNullOrWhiteSpace(path) ? null : path,
                docId = sid
            });
        }
    }
}


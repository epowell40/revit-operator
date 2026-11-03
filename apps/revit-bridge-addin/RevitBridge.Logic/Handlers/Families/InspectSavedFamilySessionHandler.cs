using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    // Read branch of inspect-exported-files, not a new public route. The tracked
    // child must still belong to the current parent project. No document opens,
    // saves, reloads, transactions or lifecycle changes occur in this read.
    public sealed class InspectSavedFamilySessionHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string familyDocumentId { get; set; } = "";
            public List<string>? paths { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new ArgumentException("A family inspection request is required.");
            if (!Guid.TryParseExact(p.familyDocumentId, "N", out _) || p.paths == null || p.paths.Count != 1)
                throw new ArgumentException("Provide the exact tracked family session and one saved RFA path.");
            var tracked = FamilyLabelStyleAccess.RequireSession(app, p.familyDocumentId);
            var doc = tracked.FamilyDoc;
            var full = SavedDocumentInspectionPolicy.Resolve(p.paths[0], doc.PathName, doc.IsFamilyDocument);
            WorkspacePaths.ResolveExistingFileUnderWorkspace(full);
            var file = OperatorNativeSaveAsExecution.InspectSavedFile(full);
            return Task.FromResult<object>(new { schema = "revit-operator.exported-file-inspection.v1", ok = true,
                itemsComplete = true, requestedPaths = new[] { full }, files = new[] { file },
                saved_document = new { path = doc.PathName, family_session_id = tracked.SessionId,
                    session_id = OperatorNativeDocumentSessionAuthority.GetSessionId(doc),
                    parent_session_id = OperatorNativeDocumentSessionAuthority.GetSessionId(tracked.ProjectDoc),
                    is_modified = doc.IsModified, is_modifiable = doc.IsModifiable, is_family_document = doc.IsFamilyDocument } });
        }
    }
}

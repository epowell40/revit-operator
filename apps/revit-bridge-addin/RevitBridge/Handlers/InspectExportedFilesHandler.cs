using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class InspectExportedFilesHandler : IRequestHandler
    {
        public sealed class Params { public List<string>? paths { get; set; } }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            if (p.paths == null || p.paths.Count == 0 || p.paths.Count > 2000)
                throw new ArgumentException("Provide exact exported PDF/XLSX paths or the single active saved RVT/RFA path.");
            if (p.paths.Any(value => string.Equals(Path.GetExtension(value), ".rvt", StringComparison.OrdinalIgnoreCase)
                || string.Equals(Path.GetExtension(value), ".rfa", StringComparison.OrdinalIgnoreCase)))
            {
                if (p.paths.Count != 1) throw new ArgumentException("Inspect the active saved model separately from other files.");
                var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
                var full = SavedDocumentInspectionPolicy.Resolve(p.paths[0], doc.PathName, doc.IsFamilyDocument);
                var session = OperatorNativeDocumentSessionAuthority.GetSessionId(doc);
                string? projectUniqueId = null;
                try { projectUniqueId = doc.ProjectInformation?.UniqueId; } catch { }
                var fingerprint = OperatorRevitBatchBinding.ComputeProjectFingerprint(doc.Title, doc.PathName, projectUniqueId);
                var file = OperatorNativeSaveAsExecution.InspectSavedFile(full);
                // This synchronous native callback observes one current document and one stable disk snapshot.
                // A file digest does not inspect model content or prove engineering/visual suitability.
                return Task.FromResult<object>(new { schema = "revit-operator.exported-file-inspection.v1", ok = true,
                    itemsComplete = true, requestedPaths = new[] { full }, files = new[] { file },
                    saved_document = new { path = doc.PathName, session_id = session, project_fingerprint = fingerprint,
                        is_modified = doc.IsModified, is_modifiable = doc.IsModifiable, is_family_document = doc.IsFamilyDocument } });
            }
            var paths = p.paths.Select(value =>
            {
                var extension = Path.GetExtension(value);
                if (string.IsNullOrWhiteSpace(value) || value.Length > 2000 || !(string.Equals(extension, ".pdf", StringComparison.OrdinalIgnoreCase) || string.Equals(extension, ".xlsx", StringComparison.OrdinalIgnoreCase)))
                    throw new ArgumentException("Inspection accepts exact PDF or XLSX file paths only.");
                var full = Path.GetFullPath(Path.IsPathRooted(value) ? value : Path.Combine(WorkspacePaths.GetWorkspaceRoot(), value));
                // Reuse the exporter's allowed-root policy without creating directories or files.
                if (string.Equals(extension, ".xlsx", StringComparison.OrdinalIgnoreCase)) WorkspacePaths.ResolveFileUnderWorkspace(full);
                else ExportPdfHandler.ResolvePdfOutputFolder(Path.GetDirectoryName(full));
                return full;
            }).ToArray();
            var files = OperatorNativeArtifactCapture.Inspect(paths);
            return Task.FromResult<object>(new { schema = "revit-operator.exported-file-inspection.v1", ok = true,
                itemsComplete = true, requestedPaths = paths, files });
        }
    }
}

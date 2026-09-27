using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class SaveAsModelHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? filePath { get; set; }
            public bool? overwrite { get; set; }
            public bool? compact { get; set; }
            public int? maximumBackups { get; set; }
            public bool? saveAsCentral { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var preview = false;
            var enteredSaveExecution = false;
            try
            {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            preview = p.dryRun ?? false;

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var requestedPath = (p.filePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(requestedPath))
                throw new InvalidOperationException("save-as.filePath is required.");

            var resolved = ResolvePath(doc, requestedPath);
            var overwrite = p.overwrite ?? false;
            var compact = p.compact ?? false;
            var saveAsCentral = p.saveAsCentral ?? false;
            var maxBackups = p.maximumBackups.GetValueOrDefault(3);
            if (maxBackups < 1) maxBackups = 1;
            if (maxBackups > 20) maxBackups = 20;

            var parent = Path.GetDirectoryName(resolved);
            if (string.IsNullOrWhiteSpace(parent))
                throw new InvalidOperationException($"Unable to resolve parent directory for: {resolved}");

            var plan = new
            {
                filePath = resolved,
                overwrite,
                compact,
                maximumBackups = maxBackups,
                saveAsCentral = doc.IsWorkshared && saveAsCentral,
                isWorkshared = doc.IsWorkshared
            };

            using var options = new SaveAsOptions
            {
                OverwriteExistingFile = overwrite,
                Compact = compact,
                MaximumBackups = maxBackups
            };

            if (doc.IsWorkshared)
            {
                using var ws = new WorksharingSaveAsOptions
                {
                    SaveAsCentral = saveAsCentral
                };
                options.SetWorksharingOptions(ws);
            }

            enteredSaveExecution = true;
            var saved = OperatorNativeSaveAsExecution.Execute(resolved, preview, overwrite,
                () => ReadActiveDocument(app, doc), () => doc.SaveAs(resolved, options));

            return Task.FromResult<object>(new
            {
                status = saved.Status,
                ok = saved.Ok,
                error = saved.Error,
                dryRun = preview,
                plan,
                artifact_receipt = saved.Receipt,
                path = resolved,
                overwrite,
                compact,
                maximumBackups = maxBackups,
                saveAsCentral = doc.IsWorkshared && saveAsCentral
            });
            }
            catch (Exception ex) when (!enteredSaveExecution)
            {
                return Task.FromResult<object>(new { status = "Blocked", ok = false, error = ex.Message, dryRun = preview,
                    artifact_receipt = OperatorNativeArtifactReceipt.BlockedSaveAs(preview) });
            }
        }

        private static OperatorNativeSaveDocumentIdentity ReadActiveDocument(UIApplication app, Document expected)
        {
            var active = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            string? projectUniqueId = null;
            try { projectUniqueId = active.ProjectInformation?.UniqueId; } catch { }
            return new OperatorNativeSaveDocumentIdentity(OperatorNativeDocumentSessionAuthority.GetSessionId(active),
                OperatorRevitBatchBinding.ComputeProjectFingerprint(active.Title, active.PathName, projectUniqueId), active.PathName,
                ReferenceEquals(active, expected) || active.Equals(expected));
        }

        private static string ResolvePath(Document doc, string requestedPath)
        {
            var candidate = requestedPath;
            if (!Path.IsPathRooted(candidate))
            {
                var docDir = "";
                try
                {
                    if (!string.IsNullOrWhiteSpace(doc.PathName))
                    {
                        docDir = Path.GetDirectoryName(doc.PathName) ?? "";
                    }
                }
                catch
                {
                    docDir = "";
                }

                if (string.IsNullOrWhiteSpace(docDir))
                {
                    // Resolve only: the preview must not create the default workspace directory.
                    docDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "Workspace");
                }

                candidate = Path.Combine(docDir, candidate);
            }

            var full = Path.GetFullPath(candidate);
            var ext = Path.GetExtension(full) ?? "";
            if (string.IsNullOrWhiteSpace(ext))
            {
                full += ".rvt";
            }

            return full;
        }
    }
}

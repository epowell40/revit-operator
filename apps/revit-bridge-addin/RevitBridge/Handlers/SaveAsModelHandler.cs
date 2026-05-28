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
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

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

            if (p.dryRun ?? false)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    plan
                });
            }

            Directory.CreateDirectory(parent);
            if (File.Exists(resolved) && !overwrite)
            {
                throw new InvalidOperationException($"Target file already exists: {resolved}. Set overwrite=true to replace.");
            }

            var options = new SaveAsOptions
            {
                OverwriteExistingFile = overwrite,
                Compact = compact,
                MaximumBackups = maxBackups
            };

            if (doc.IsWorkshared)
            {
                var ws = new WorksharingSaveAsOptions
                {
                    SaveAsCentral = saveAsCentral
                };
                options.SetWorksharingOptions(ws);
            }

            doc.SaveAs(resolved, options);

            return Task.FromResult<object>(new
            {
                status = "Success",
                path = resolved,
                overwrite,
                compact,
                maximumBackups = maxBackups,
                saveAsCentral = doc.IsWorkshared && saveAsCentral
            });
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
                    docDir = WorkspacePaths.GetWorkspaceRoot();
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

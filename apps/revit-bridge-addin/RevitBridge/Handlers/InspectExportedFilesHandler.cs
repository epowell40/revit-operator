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
                throw new ArgumentException("Provide 1 to 2000 exact exported PDF or XLSX paths.");
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

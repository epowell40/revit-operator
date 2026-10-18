using System;
using System.IO;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class InspectExcelSourceHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = XlsxSourceInspectionRequest.Parse(jsonData);
            var path = WorkspacePaths.ResolveExistingFileUnderWorkspace(request.sourcePath.Trim());
            if (!string.Equals(Path.GetExtension(path), ".xlsx", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Excel source inspection requires an .xlsx file under the workspace.");
            // Limit the read itself, not just FileInfo: a concurrently growing source
            // cannot allocate an unbounded buffer before the package limit is checked.
            using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var bytes = new MemoryStream())
            {
                var buffer = new byte[8192];int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (bytes.Length + read > XlsxSourcePackage.MaxPackageBytes)
                        throw new InvalidOperationException("Excel source exceeds 64MiB; no source clipped.");
                    bytes.Write(buffer, 0, read);
                }
                return Task.FromResult(XlsxSourceInspection.Read(bytes.ToArray(), jsonData));
            }
        }
    }
}

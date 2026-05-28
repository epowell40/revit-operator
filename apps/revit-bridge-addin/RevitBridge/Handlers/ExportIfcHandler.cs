using System;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ExportIfcHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? fileName { get; set; }
            public string? outputFolder { get; set; }
            public long? viewId { get; set; } // optional filter view
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var dryRun = p.dryRun ?? false;
            var folder = WorkspacePaths.ResolveDirectoryUnderWorkspace(p.outputFolder, "artifacts", "ifc");

            var name = (p.fileName ?? $"Export_{DateTime.Now:yyyyMMddHHmmss}.ifc").Trim();
            if (string.IsNullOrWhiteSpace(name)) name = $"Export_{DateTime.Now:yyyyMMddHHmmss}.ifc";
            if (!name.EndsWith(".ifc", StringComparison.OrdinalIgnoreCase)) name += ".ifc";
            name = Path.GetFileName(name);

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    outputFolder = folder,
                    fileName = name,
                    viewId = p.viewId
                });
            }

            var opts = new IFCExportOptions();
            TrySetFilterViewId(opts, p.viewId);

            var ok = doc.Export(folder, name, opts);
            return Task.FromResult<object>(new
            {
                status = ok ? "Success" : "Failed",
                dryRun = false,
                outputFolder = folder,
                fileName = name,
                path = Path.Combine(folder, name),
                viewId = p.viewId
            });
        }

        private static void TrySetFilterViewId(IFCExportOptions opts, long? viewId)
        {
            if (opts == null) return;
            if (!viewId.HasValue || viewId.Value <= 0) return;
            try
            {
                var prop = opts.GetType().GetProperty("FilterViewId", BindingFlags.Instance | BindingFlags.Public);
                if (prop == null || !prop.CanWrite) return;
                if (prop.PropertyType == typeof(ElementId))
                {
                    prop.SetValue(opts, RevitBridge.Common.ElementIdCompat.Create(viewId.Value));
                }
            }
            catch
            {
                // ignore (not available in some versions)
            }
        }
    }
}


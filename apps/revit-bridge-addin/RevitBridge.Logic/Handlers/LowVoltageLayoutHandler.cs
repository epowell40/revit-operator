using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.LowVoltage.Core;

namespace RevitBridge.Logic.Handlers
{
    public class LowVoltageLayoutHandler : IRequestHandler
    {
        public class Request
        {
            public string? Discipline { get; set; }
            public long? ViewId { get; set; }
            public bool PreviewOnly { get; set; } = true;
            public bool WriteSnapshots { get; set; } = false;
            public string? SnapshotDirectory { get; set; }
            public string? NormalizationProfilePath { get; set; }
            public string? DisciplineProfilePath { get; set; }
            public string? TaskContext { get; set; }
            public string? RunId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var req = JsonSerializer.Deserialize<Request>(jsonData ?? "{}", new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new Request();
            var doc = app.ActiveUIDocument.Document;
            var view = req.ViewId.HasValue ? doc.GetElement(new ElementId((int)req.ViewId.Value)) as View : doc.ActiveView;
            if (view == null) return Task.FromResult<object>(new { error = "No active view." });

            var execution = LowVoltageLayoutRunner.Run(doc, view, new LowVoltageLayoutRequest
            {
                Discipline = req.Discipline ?? "fire_alarm",
                PreviewOnly = req.PreviewOnly,
                WriteSnapshots = req.WriteSnapshots,
                SnapshotDirectory = req.SnapshotDirectory,
                NormalizationProfilePath = req.NormalizationProfilePath,
                DisciplineProfilePath = req.DisciplineProfilePath,
                TaskContext = req.TaskContext,
                RunId = req.RunId
            });

            return Task.FromResult<object>(new
            {
                discipline = req.Discipline,
                viewId = ElementIdCompat.GetValue(view.Id),
                graph = execution.Graph,
                result = execution.Result,
                diagnostics = execution.Diagnostics,
                createdElementIds = execution.CreatedElementIds
            });
        }
    }
}

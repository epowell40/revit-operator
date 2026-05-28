using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Logic.Handlers
{
    public sealed class RegenerateHandler : RevitBridge.Common.IRequestHandler
    {
        public sealed class Params
        {
            public bool refreshActiveView { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            try { doc.Regenerate(); } catch { }
            if (p.refreshActiveView)
            {
                try { uidoc.RefreshActiveView(); } catch { }
            }

            return Task.FromResult<object>(new { ok = true });
        }
    }
}


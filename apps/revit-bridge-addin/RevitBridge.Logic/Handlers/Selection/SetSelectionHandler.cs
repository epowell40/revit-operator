using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class SetSelectionHandler : IRequestHandler
    {
        public class Params
        {
            public List<long> elementIds { get; set; } = new List<long>();
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new Exception("No active UI document.");

            var ids = p.elementIds?.Select(id => RevitBridge.Common.ElementIdCompat.Create(id)).ToList() ?? new List<ElementId>();
            uidoc.Selection.SetElementIds(ids);

            return Task.FromResult<object>(new
            {
                ok = true,
                selectedCount = ids.Count
            });
        }
    }
}


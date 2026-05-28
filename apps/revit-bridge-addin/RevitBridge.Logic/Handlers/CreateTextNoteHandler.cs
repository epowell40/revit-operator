using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class CreateTextNoteHandler : IRequestHandler
    {
        public class Params
        {
            public long viewId { get; set; }
            public double x { get; set; }
            public double y { get; set; }
            public string text { get; set; }
            public long? typeId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            using (var t = new Transaction(doc, "Create Text Note"))
            {
                t.Start();

                var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId)) as View;
                if (view == null) throw new Exception($"View {p.viewId} not found");

                // Default to first TextNoteType if not provided
                ElementId textTypeId = p.typeId.HasValue 
                    ? RevitBridge.Common.ElementIdCompat.Create(p.typeId.Value) 
                    : new FilteredElementCollector(doc)
                        .OfClass(typeof(TextNoteType))
                        .FirstElementId();

                if (textTypeId == null) throw new Exception("No TextNoteType found in project.");

                // Create the text note
                // XYZ origin depends on view type. For sheets/plans, Z is usually 0 or matches level elevation.
                // We'll trust the user provided X/Y relative to the view's coordinate system.
                XYZ origin = new XYZ(p.x, p.y, 0); 

                // Adjust creation for View vs Sheet if necessary, but TextNote.Create takes a viewId
                TextNote.Create(doc, view.Id, origin, RevitTextCasePolicy.NormalizeDraftingText(p.text), textTypeId);

                t.Commit();
            }

            return Task.FromResult<object>(new { status = "success" });
        }
    }
}


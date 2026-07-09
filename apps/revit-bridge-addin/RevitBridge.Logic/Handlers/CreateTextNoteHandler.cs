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
            if (p == null) throw new ArgumentException("create-text body is required.");
            var doc = app.ActiveUIDocument.Document;
            long textNoteId;
            long resolvedViewId;
            long resolvedTypeId;
            string resolvedTypeName;
            string normalizedText = RevitTextCasePolicy.NormalizeDraftingText(p.text ?? "");

            using (var t = new Transaction(doc, "Create Text Note"))
            {
                t.Start();

                var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId)) as View;
                if (view == null) throw new Exception($"View {p.viewId} not found");
                resolvedViewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id);

                // Default to first TextNoteType if not provided
                var textType = p.typeId.HasValue
                    ? doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.typeId.Value)) as TextNoteType
                    : new FilteredElementCollector(doc)
                        .OfClass(typeof(TextNoteType))
                        .Cast<TextNoteType>()
                        .FirstOrDefault();

                if (textType == null) throw new Exception("No TextNoteType found in project.");
                resolvedTypeId = RevitBridge.Common.ElementIdCompat.GetValue(textType.Id);
                resolvedTypeName = textType.Name;

                // Create the text note
                // XYZ origin depends on view type. For sheets/plans, Z is usually 0 or matches level elevation.
                // We'll trust the user provided X/Y relative to the view's coordinate system.
                XYZ origin = new XYZ(p.x, p.y, 0); 

                // Adjust creation for View vs Sheet if necessary, but TextNote.Create takes a viewId
                var created = TextNote.Create(doc, view.Id, origin, normalizedText, textType.Id);
                textNoteId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id);

                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                action = "create",
                id = textNoteId,
                textNoteId,
                elementId = textNoteId,
                createdElementId = textNoteId,
                viewId = resolvedViewId,
                x = p.x,
                y = p.y,
                text = normalizedText,
                textType = new
                {
                    id = resolvedTypeId,
                    name = resolvedTypeName
                }
            });
        }
    }
}


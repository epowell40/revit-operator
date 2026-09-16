using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class DuplicateViewHandler : IRequestHandler
    {
        public class DuplicateRequest
        {
            public long viewId { get; set; }
            public string newName { get; set; } = "";
            public bool withDetailing { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = JsonSerializer.Deserialize<DuplicateRequest>(jsonData)
                ?? throw new ArgumentException("Duplicate view request is required.");
            var doc = app.ActiveUIDocument.Document;
            
            ElementId viewEId = ElementIdCompat.Create(request.viewId);
            var view = doc.GetElement(viewEId) as View;

            if (view == null) return Task.FromResult<object>(new
            {
                success = false, error = $"View {request.viewId} not found",
                transaction = OperatorNativeTransactionReceipt.NotStarted()
            });

            return Task.FromResult<object>(NativeSingleTransaction.Execute(app, doc, "Duplicate View", createdElements =>
            {
                var option = request.withDetailing ? ViewDuplicateOption.WithDetailing : ViewDuplicateOption.Duplicate;
                var newId = view.Duplicate(option);
                var copy = doc.GetElement(newId) as View
                    ?? throw new InvalidOperationException("Duplicate did not return a view.");
                // A conflicting name rolls the copy back instead of silently
                // changing the requested deliverable name.
                if (!string.IsNullOrEmpty(request.newName)) copy.Name = request.newName;
                doc.Regenerate();
                createdElements.Add(ElementIdCompat.GetValue(newId));
                // These are native-owned elements of the newly duplicated view,
                // including copied annotations. Never derive them from request IDs.
                foreach (var ownedId in new FilteredElementCollector(doc)
                    .WherePasses(new ElementOwnerViewFilter(newId)).ToElementIds())
                    createdElements.Add(ElementIdCompat.GetValue(ownedId));
                return new Dictionary<string, object?>
                {
                    ["viewId"] = ElementIdCompat.GetValue(newId),
                    ["name"] = copy.Name,
                    ["sourceViewId"] = request.viewId,
                    ["withDetailing"] = request.withDetailing
                };
            }));
        }
    }
}


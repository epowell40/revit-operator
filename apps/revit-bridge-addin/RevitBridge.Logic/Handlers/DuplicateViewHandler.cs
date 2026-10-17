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

            var sourceViewType = view.ViewType.ToString();
            var sourceDefinitionBefore = view is ViewSchedule sourceSchedule
                ? ScheduleDefinitionIdentitySnapshot.CaptureDefinition(sourceSchedule) : null;
            long createdViewId = 0;
            var response = NativeSingleTransaction.Execute(app, doc, "Duplicate View", createdElements =>
            {
                var option = request.withDetailing ? ViewDuplicateOption.WithDetailing : ViewDuplicateOption.Duplicate;
                var newId = view.Duplicate(option);
                var copy = doc.GetElement(newId) as View
                    ?? throw new InvalidOperationException("Duplicate did not return a view.");
                createdViewId = ElementIdCompat.GetValue(newId);
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
            });
            response["sourceViewType"] = sourceViewType;
            if (sourceDefinitionBefore != null)
            {
                response["sourceDefinitionBefore"] = sourceDefinitionBefore;
                OperatorNativeTransactionExecution.ReadCommitted(response, () =>
                {
                    var copy = doc.GetElement(ElementIdCompat.Create(createdViewId)) as ViewSchedule
                        ?? throw new InvalidOperationException("Duplicated schedule unavailable after commit.");
                    return new Dictionary<string, object?>
                    {
                        ["created"] = true,
                        ["definitionIdentity"] = ScheduleDefinitionIdentitySnapshot.Read(copy)
                    };
                });
                response["status"] = OperatorNativeTransactionExecution.OutcomeStatus(response, "Success");
            }
            return Task.FromResult<object>(response);
        }
    }
}


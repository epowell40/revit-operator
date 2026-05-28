using System;
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
            public string newName { get; set; }
            public bool withDetailing { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = JsonSerializer.Deserialize<DuplicateRequest>(jsonData);
            var doc = app.ActiveUIDocument.Document;
            
            // Handle ElementId based on Revit version if needed, but assuming simple long works for now or specific constructor
            // ElementId(long) is valid in older APIs, ElementId(int) in some. In 2024+ it's long.
            // Using implicit conversion or constructor.
            ElementId viewEId = RevitBridge.Common.ElementIdCompat.Create(request.viewId);
            var view = doc.GetElement(viewEId) as View;

            if (view == null) return Task.FromResult<object>(new { error = $"View {request.viewId} not found" });

            using (Transaction tx = new Transaction(doc, "Duplicate View"))
            {
                tx.Start();
                try
                {
                    ViewDuplicateOption option = request.withDetailing ? ViewDuplicateOption.WithDetailing : ViewDuplicateOption.Duplicate;
                    ElementId newViewId = view.Duplicate(option);
                    View newView = doc.GetElement(newViewId) as View;

                    if (!string.IsNullOrEmpty(request.newName))
                    {
                        try
                        {
                            newView.Name = request.newName;
                        }
                        catch
                        {
                            // Name might be taken, append ID or random suffix
                            newView.Name = $"{request.newName}_{newViewId}";
                        }
                    }

                    tx.Commit();
                    // Return .Value for older Revit, .Value is int usually, or just .ToString() if unsure of API version. 
                    // Assuming .Value is available (Revit 2023 and below used integer IDs).
                    // If 2024+, it is long. 
                    // Safe approach: return the numeric value.
                    // Assuming this project uses an API where ElementId has generic integer/long value access.
                    // Given existing code used `RevitBridge.Common.ElementIdCompat.GetValue(dim.Id)`, I will use that.
                    
                    // Note: In newer Revit versions (2024+), .Value is a long. In older, .IntegerValue is int.
                    // Existing code used `.Value`, so I will stick to that.
                    
                    return Task.FromResult<object>(new { success = true, viewId = RevitBridge.Common.ElementIdCompat.GetValue(newViewId), name = newView.Name });
                }
                catch (Exception ex)
                {
                    tx.RollBack();
                    return Task.FromResult<object>(new { error = ex.Message });
                }
            }
        }
    }
}


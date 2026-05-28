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
    public class DeleteElementsHandler : IRequestHandler
    {
        public class Params
        {
            public List<long> ids { get; set; }
            public bool apply { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;
            var elementIds = p.ids.Select(id => RevitBridge.Common.ElementIdCompat.Create(id)).ToList();

            using (Transaction trans = new Transaction(doc, "Delete Elements"))
            {
                trans.Start();
                
                ICollection<ElementId> deletedIds = null;
                try 
                {
                    deletedIds = doc.Delete(elementIds);
                }
                catch
                {
                    // If deletion fails, we can't report what would be deleted.
                    trans.RollBack();
                    throw;
                }

                if (p.apply)
                {
                    trans.Commit();
                    return Task.FromResult<object>(new { status = "Deleted", count = deletedIds.Count, ids = deletedIds.Select(id => RevitBridge.Common.ElementIdCompat.GetValue(id)).ToList() });
                }
                else
                {
                    trans.RollBack();
                    return Task.FromResult<object>(new { status = "Dry Run", count = deletedIds.Count, ids = deletedIds.Select(id => RevitBridge.Common.ElementIdCompat.GetValue(id)).ToList() });
                }
            }
        }
    }
}


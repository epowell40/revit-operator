using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class CreateSheetHandler : IRequestHandler
    {
        public class Params
        {
            public string name { get; set; }
            public string number { get; set; }
            public long titleBlockId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            using (Transaction trans = new Transaction(doc, "Create Sheet"))
            {
                trans.Start();

                ElementId tbId = RevitBridge.Common.ElementIdCompat.Create(p.titleBlockId);
                if (p.titleBlockId == -1) // Auto-find first titleblock
                {
                    tbId = new FilteredElementCollector(doc)
                        .OfCategory(BuiltInCategory.OST_TitleBlocks)
                        .WhereElementIsElementType()
                        .FirstElementId();
                }

                if (tbId == null || tbId == ElementId.InvalidElementId)
                    throw new Exception("No TitleBlock found.");

                ViewSheet sheet = ViewSheet.Create(doc, tbId);
                if (!string.IsNullOrEmpty(p.name)) sheet.Name = RevitTextCasePolicy.NormalizeSheetName(p.name);
                if (!string.IsNullOrEmpty(p.number)) sheet.SheetNumber = p.number;

                trans.Commit();

                return Task.FromResult<object>(new 
                { 
                    id = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id), 
                    name = sheet.Name, 
                    number = sheet.SheetNumber 
                });
            }
        }
    }
}


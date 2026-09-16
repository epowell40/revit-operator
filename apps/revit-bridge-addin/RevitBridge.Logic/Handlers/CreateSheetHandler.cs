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

            ElementId? outputId = null;
            var result = NativeSingleTransaction.Execute(app, doc, "Create Sheet", created =>
            {
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

                doc.Regenerate();
                outputId = sheet.Id;
                created.Add(ElementIdCompat.GetValue(sheet.Id));
                foreach (var id in new FilteredElementCollector(doc).WherePasses(new ElementOwnerViewFilter(sheet.Id)).ToElementIds())
                    created.Add(ElementIdCompat.GetValue(id));
                return new Dictionary<string, object?>();
            });
            return Task.FromResult<object>(OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                var sheet = outputId == null ? null : doc.GetElement(outputId) as ViewSheet;
                if (sheet == null) throw new InvalidOperationException("Committed sheet was not found during readback.");
                return new Dictionary<string, object?> { ["id"] = ElementIdCompat.GetValue(sheet.Id), ["name"] = sheet.Name, ["number"] = sheet.SheetNumber };
            }));
        }
    }
}


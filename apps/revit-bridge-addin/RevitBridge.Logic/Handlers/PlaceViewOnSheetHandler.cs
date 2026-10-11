using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class PlaceViewOnSheetHandler : IRequestHandler
    {
        public class Params
        {
            public long sheetId { get; set; }
            public long viewId { get; set; }
            public double x { get; set; } = 0;
            public double y { get; set; } = 0;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            var result = NativeSingleTransaction.Execute(app, doc, "Place View on Sheet", created =>
            {

                ElementId sheetId = RevitBridge.Common.ElementIdCompat.Create(p.sheetId);
                ElementId viewId = RevitBridge.Common.ElementIdCompat.Create(p.viewId);

                if (Viewport.CanAddViewToSheet(doc, sheetId, viewId))
                {
                    Viewport vp = Viewport.Create(doc, sheetId, viewId, new XYZ(p.x, p.y, 0));
                    created.Add(ElementIdCompat.GetValue(vp.Id));
                    return new Dictionary<string, object?> { ["id"] = ElementIdCompat.GetValue(vp.Id), ["status"] = "Placed" };
                }
                else
                {
                    throw new InvalidOperationException("Cannot place view on sheet (already placed?)");
                }
            });
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Placed");
            return Task.FromResult<object>(result);
        }
    }
}


using System;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using System.Text.Json;

namespace RevitBridge.Logic.Handlers
{
    public class SyncModelHandler : IRequestHandler
    {
        public class Params
        {
            public string comment { get; set; } = "Synced by Revit Operator";
            public bool compact { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            if (!doc.IsWorkshared)
            {
                return Task.FromResult<object>(new { status = "Skipped", message = "Model is not workshared." });
            }

            TransactWithCentralOptions twcOpts = new TransactWithCentralOptions();
            SynchronizeWithCentralOptions swcOpts = new SynchronizeWithCentralOptions();

            // Set Relinquish Options
            RelinquishOptions rOpts = new RelinquishOptions(true); 
            rOpts.CheckedOutElements = true;
            rOpts.StandardWorksets = true;
            rOpts.FamilyWorksets = true;
            rOpts.ViewWorksets = true;
            rOpts.UserWorksets = true;
            
            swcOpts.SetRelinquishOptions(rOpts);
            swcOpts.Compact = p.compact; // Correct property name
            swcOpts.Comment = p.comment;
            swcOpts.SaveLocalAfter = true; // Correct property name

            try 
            {
                doc.SynchronizeWithCentral(twcOpts, swcOpts);
                return Task.FromResult<object>(new { status = "Success", message = "Model synchronized and relinquished." });
            }
            catch (Exception ex)
            {
                return Task.FromResult<object>(new { status = "Error", message = ex.Message });
            }
        }
    }
}

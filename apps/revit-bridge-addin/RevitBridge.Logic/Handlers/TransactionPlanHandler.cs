using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class TransactionPlanHandler : IRequestHandler
    {
        public class Params
        {
            public List<JsonElement> actions { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active document.");

            var warnings = new List<string>();
            var impact = new TransactionActionRunner.Impact();
            IReadOnlyList<TransactionActionRunner.ActionOutcome> actionOutcomes = Array.Empty<TransactionActionRunner.ActionOutcome>();

            using (var trans = new Transaction(doc, "Transaction Plan (Dry Run)"))
            {
                trans.Start();
                try
                {
                    actionOutcomes = TransactionActionRunner.ExecuteActions(doc, p?.actions, impact, warnings);
                }
                catch (Exception ex)
                {
                    warnings.Add(ex.Message);
                }
                finally
                {
                    trans.RollBack();
                }
            }

            return Task.FromResult<object>(new
            {
                impact = impact.ToWireObject(),
                actions = new List<TransactionActionRunner.ActionOutcome>(actionOutcomes).ConvertAll(outcome => outcome.ToWireObject()),
                warnings = warnings
            });
        }
    }
}

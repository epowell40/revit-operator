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

            var result = NativeSingleTransaction.Execute(app, doc, "Transaction Plan (Dry Run)", _ =>
            {
                actionOutcomes = TransactionActionRunner.ExecuteActions(doc, p?.actions, impact, warnings);
                return new Dictionary<string, object?>
                {
                    ["success"] = actionOutcomes.Count > 0 && actionOutcomes.All(outcome => outcome.Success),
                    ["impact"] = impact.ToWireObject(),
                    ["actions"] = actionOutcomes.Select(outcome => outcome.ToWireObject()).ToArray(),
                    ["warnings"] = warnings
                };
            }, disposition: NativeTransactionDisposition.Rollback);
            result["dryRun"] = true;
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Unexpected Commit");
            return Task.FromResult<object>(result);
        }
    }
}

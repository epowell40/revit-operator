using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class SyncModelHandler : IRequestHandler
    {
        public class Params
        {
            public string action { get; set; } = "sync";
            public string comment { get; set; } = "Synced by Revit Operator";
            public bool compact { get; set; }
            public bool relinquish { get; set; } = true;
            public bool dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData) => Task.FromResult(
            NativeMutationPreflightBoundary.Execute(enter => {
                var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
                if (p.action != "sync" && p.action != "reload_latest") throw new ArgumentException("action must be sync or reload_latest.");
                var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("Open a local workshared project first.");
                if (!doc.IsWorkshared || doc.IsFamilyDocument || doc.IsLinked || doc.IsReadOnly || doc.IsModifiable)
                    throw new InvalidOperationException("This operation requires an editable workshared project with no open transaction.");
                if ((p.comment ?? "").Length > 1000) throw new ArgumentException("Sync comment must be at most 1000 characters.");
                var centralPath = ModelPathUtils.ConvertModelPathToUserVisiblePath(doc.GetWorksharingCentralModelPath());
                if (p.dryRun) return new { status = "Dry Run", dryRun = true, action = p.action, centralPath,
                    transaction = OperatorNativeTransactionReceipt.NotStarted() };
                enter();
                return RevitBridge.Logic.Handlers.NativeLifecycleExecution.Execute(app, doc, "/revit/sync", p.action, () => {
                    if (p.action == "reload_latest")
                    {
                        using (var options = new ReloadLatestOptions()) doc.ReloadLatest(options);
                    }
                    else
                    {
                        using (var central = new TransactWithCentralOptions())
                        using (var options = new SynchronizeWithCentralOptions())
                        using (var relinquish = new RelinquishOptions(p.relinquish))
                        {
                            options.SetRelinquishOptions(relinquish);
                            options.Comment = p.comment ?? ""; options.Compact = p.compact;
                            options.SaveLocalBefore = true; options.SaveLocalAfter = true;
                            doc.SynchronizeWithCentral(central, options);
                        }
                    }
                }, () => new Dictionary<string, object?> {
                    ["status"] = "Success", ["action"] = p.action, ["centralPath"] = centralPath,
                    ["documentPath"] = doc.PathName, ["hasAllChangesFromCentral"] = doc.HasAllChangesFromCentral(),
                    ["isModified"] = doc.IsModified, ["relinquishRequested"] = p.action == "sync" && p.relinquish,
                    ["message"] = p.action == "sync" ? "Synchronization returned successfully." : "Reload Latest returned successfully."
                });
            }));
    }
}

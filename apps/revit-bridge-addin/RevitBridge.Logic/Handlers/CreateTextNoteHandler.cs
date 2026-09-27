using System;
using System.Linq;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class CreateTextNoteHandler : IRequestHandler
    {
        public class Params
        {
            public long viewId { get; set; }
            public double x { get; set; }
            public double y { get; set; }
            public string text { get; set; }
            public long? typeId { get; set; }
            public bool dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope =>
                HandleCore(app, jsonData, enterNativeScope).GetAwaiter().GetResult()));

        private Task<object> HandleCore(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData)
                ?? throw new ArgumentException("create-text body is required.");
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            var view = doc.GetElement(ElementIdCompat.Create(p.viewId)) as View
                ?? throw new InvalidOperationException($"View {p.viewId} not found.");
            var textType = p.typeId.HasValue
                ? doc.GetElement(ElementIdCompat.Create(p.typeId.Value)) as TextNoteType
                : new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().FirstOrDefault();
            if (textType == null) throw new InvalidOperationException("No TextNoteType found in project.");
            var text = RevitTextCasePolicy.NormalizeDraftingText(p.text ?? "");
            if (p.dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run", action = "create", dryRun = true,
                    previewExecuted = false, applied = false,
                    transaction = OperatorNativeTransactionReceipt.NotStarted(),
                    plan = new { viewId = ElementIdCompat.GetValue(view.Id), x = p.x, y = p.y, text,
                        textType = new { id = ElementIdCompat.GetValue(textType.Id), name = textType.Name } }
                });
            }
            long textNoteId = 0;
            enterNativeScope();
            var result = NativeSingleTransaction.Execute(app, doc, "Create Text Note", nativeCreated =>
            {
                var created = TextNote.Create(doc, view.Id, new XYZ(p.x, p.y, 0), text, textType.Id);
                textNoteId = ElementIdCompat.GetValue(created.Id);
                nativeCreated.Add(textNoteId);
                return new Dictionary<string, object?>
                {
                    ["action"] = "create", ["id"] = textNoteId, ["textNoteId"] = textNoteId,
                    ["elementId"] = textNoteId, ["createdElementId"] = textNoteId,
                    ["viewId"] = ElementIdCompat.GetValue(view.Id), ["text"] = text,
                    ["textType"] = new { id = ElementIdCompat.GetValue(textType.Id), name = textType.Name }
                };
            });
            OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                var persisted = doc.GetElement(ElementIdCompat.Create(textNoteId)) as TextNote
                    ?? throw new InvalidOperationException($"TextNote {textNoteId} disappeared after commit.");
                if (persisted.OwnerViewId != view.Id) throw new InvalidOperationException("TextNote has a different owner view after commit.");
                return new Dictionary<string, object?> { ["text"] = persisted.Text };
            });
            // Persisted values are evidence; this handler does not certify all requested semantics.
            result.Remove("verified");
            result.Remove("ok");
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Success");
            return Task.FromResult<object>(result);
        }
    }
}

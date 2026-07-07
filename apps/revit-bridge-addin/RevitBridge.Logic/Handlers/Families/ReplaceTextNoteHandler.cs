using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class ReplaceTextNoteHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? docId { get; set; }
            public string? familyDocumentId { get; set; }
            public long elementId { get; set; }
            public long? textNoteId { get; set; }
            public string newText { get; set; } = "";

            public bool? apply { get; set; }
            public bool? dryRun { get; set; }
            public string? confirm { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var sid = (p.docId ?? p.familyDocumentId ?? "").Trim();

            var id = p.textNoteId.HasValue && p.textNoteId.Value != 0 ? p.textNoteId.Value : p.elementId;
            if (id == 0) throw new InvalidOperationException("replace-text-note.elementId is required.");

            var req = new SetTextNoteTextHandler.Params
            {
                familyDocumentId = string.IsNullOrWhiteSpace(sid) ? null : sid,
                textNoteId = id,
                newText = p.newText ?? "",
                apply = p.apply,
                dryRun = p.dryRun,
                confirm = p.confirm
            };
            var raw = new SetTextNoteTextHandler().Handle(app, JsonSerializer.Serialize(req)).GetAwaiter().GetResult();
            return Task.FromResult(raw);
        }
    }
}


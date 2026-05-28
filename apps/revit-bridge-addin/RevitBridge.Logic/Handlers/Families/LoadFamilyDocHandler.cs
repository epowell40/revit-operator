using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class LoadFamilyDocHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? docId { get; set; }
            public string? familyDocumentId { get; set; }
            public bool overwriteParameterValuesOnLoad { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var sid = (p.docId ?? p.familyDocumentId ?? "").Trim();
            if (string.IsNullOrWhiteSpace(sid)) throw new InvalidOperationException("load-family-doc.docId is required.");

            var req = new ReloadFamilyEditSessionHandler.Params
            {
                familyDocumentId = sid,
                overwriteParameterValues = p.overwriteParameterValuesOnLoad,
                closeSession = false
            };
            var raw = new ReloadFamilyEditSessionHandler().Handle(app, JsonSerializer.Serialize(req)).GetAwaiter().GetResult();
            return Task.FromResult(raw);
        }
    }
}


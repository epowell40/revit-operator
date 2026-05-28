using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class DuplicateElementTypeHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long sourceTypeId { get; set; }
            public string newTypeName { get; set; } = "";
            public bool dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.sourceTypeId <= 0) throw new ArgumentException("sourceTypeId is required.");
            var newName = (p.newTypeName ?? "").Trim();
            if (newName.Length == 0) throw new ArgumentException("newTypeName is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var src = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.sourceTypeId)) as ElementType;
            if (src == null) throw new InvalidOperationException($"Element {p.sourceTypeId} not found or is not an ElementType.");

            if (p.dryRun)
            {
                return Task.FromResult<object>(new
                {
                    ok = true,
                    dryRun = true,
                    sourceTypeId = RevitBridge.Common.ElementIdCompat.GetValue(src.Id),
                    sourceTypeName = src.Name,
                    newTypeName = newName,
                    note = "Dry-run does not guarantee name uniqueness; apply will fail if Revit disallows the name."
                });
            }

            ElementType? created = null;
            using (var t = new Transaction(doc, "Duplicate Element Type"))
            {
                t.Start();
                created = src.Duplicate(newName) as ElementType;
                if (created == null) throw new InvalidOperationException("Duplicate did not return an ElementType.");
                t.Commit();
            }

            try { doc.Regenerate(); } catch { }
            try { uidoc.RefreshActiveView(); } catch { }

            return Task.FromResult<object>(new
            {
                ok = true,
                dryRun = false,
                sourceTypeId = RevitBridge.Common.ElementIdCompat.GetValue(src.Id),
                sourceTypeName = src.Name,
                newTypeId = RevitBridge.Common.ElementIdCompat.GetValue(created!.Id),
                newTypeName = created!.Name
            });
        }
    }
}

using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class GetFamilyFilePathHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long familyId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.familyId == 0) throw new InvalidOperationException("get-family-file-path.familyId is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var fam = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.familyId)) as Family;
            if (fam == null) throw new InvalidOperationException($"Family {p.familyId} not found in the active document.");

            if (fam.IsInPlace)
            {
                return Task.FromResult<object>(new
                {
                    ok = true,
                    familyId = p.familyId,
                    pathKnown = false,
                    filePath = (string?)null,
                    reason = "in_place_family"
                });
            }

            Document? famDoc = null;
            try
            {
                famDoc = doc.EditFamily(fam);
                var path = famDoc?.PathName ?? "";
                var title = famDoc?.Title ?? "";
                try { famDoc?.Close(false); } catch { }

                if (!string.IsNullOrWhiteSpace(path))
                {
                    return Task.FromResult<object>(new
                    {
                        ok = true,
                        familyId = p.familyId,
                        pathKnown = true,
                        filePath = path,
                        title
                    });
                }

                return Task.FromResult<object>(new
                {
                    ok = true,
                    familyId = p.familyId,
                    pathKnown = false,
                    filePath = (string?)null,
                    reason = "unknown_path",
                    title
                });
            }
            catch (Exception ex)
            {
                try { famDoc?.Close(false); } catch { }
                return Task.FromResult<object>(new
                {
                    ok = false,
                    familyId = p.familyId,
                    pathKnown = false,
                    filePath = (string?)null,
                    reason = "edit_family_failed",
                    error = ex.Message
                });
            }
        }
    }
}


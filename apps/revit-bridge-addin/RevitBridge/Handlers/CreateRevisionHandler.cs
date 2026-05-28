using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class CreateRevisionHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? description { get; set; }
            public string? revisionDate { get; set; }
            public bool? issued { get; set; }
            public string? issuedBy { get; set; }
            public string? issuedTo { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var dryRun = p.dryRun ?? false;
            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    revision = new
                    {
                        description = string.IsNullOrWhiteSpace(p.description) ? null : p.description.Trim(),
                        revisionDate = string.IsNullOrWhiteSpace(p.revisionDate) ? null : p.revisionDate.Trim(),
                        issued = p.issued,
                        issuedBy = string.IsNullOrWhiteSpace(p.issuedBy) ? null : p.issuedBy.Trim(),
                        issuedTo = string.IsNullOrWhiteSpace(p.issuedTo) ? null : p.issuedTo.Trim()
                    }
                });
            }

            Revision revision;
            using (var tx = new Transaction(doc, "Create Revision"))
            {
                tx.Start();
                revision = Revision.Create(doc);
                RevisionsHandler.TrySetProperty(revision, "Description", (p.description ?? "").Trim());
                RevisionsHandler.TrySetProperty(revision, "RevisionDate", (p.revisionDate ?? "").Trim());
                if (p.issued.HasValue) RevisionsHandler.TrySetProperty(revision, "Issued", p.issued.Value);
                RevisionsHandler.TrySetProperty(revision, "IssuedBy", (p.issuedBy ?? "").Trim());
                RevisionsHandler.TrySetProperty(revision, "IssuedTo", (p.issuedTo ?? "").Trim());
                tx.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                revision = new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(revision.Id),
                    sequence = RevisionsHandler.ReadInt(revision, "SequenceNumber"),
                    number = RevisionsHandler.ReadString(revision, "RevisionNumber"),
                    description = RevisionsHandler.ReadString(revision, "Description"),
                    revisionDate = RevisionsHandler.ReadString(revision, "RevisionDate"),
                    issued = RevisionsHandler.ReadBool(revision, "Issued"),
                    issuedBy = RevisionsHandler.ReadString(revision, "IssuedBy"),
                    issuedTo = RevisionsHandler.ReadString(revision, "IssuedTo")
                }
            });
        }
    }
}

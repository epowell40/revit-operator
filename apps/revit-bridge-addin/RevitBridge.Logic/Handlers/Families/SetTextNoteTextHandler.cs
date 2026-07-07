using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class SetTextNoteTextHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? familyDocumentId { get; set; }
            public long textNoteId { get; set; }
            public string newText { get; set; } = "";

            public bool? apply { get; set; }
            public bool? dryRun { get; set; }
            public string? confirm { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.textNoteId == 0) throw new InvalidOperationException("set-text-note-text.textNoteId is required.");
            var nextText = NormalizeUserText(p.newText ?? "");

            Document targetDoc;
            string scope;
            string? familyDocumentId = null;
            string? familyName = null;
            if (!string.IsNullOrWhiteSpace(p.familyDocumentId))
            {
                if (!FamilyEditSessionStore.TryGet(p.familyDocumentId, out var session, out var err))
                    throw new InvalidOperationException(err ?? "Family edit session not found.");
                targetDoc = session.FamilyDoc;
                scope = "family_session";
                familyDocumentId = session.SessionId;
                familyName = session.FamilyName;
            }
            else
            {
                var uidoc = app?.ActiveUIDocument;
                targetDoc = uidoc?.Document ?? throw new InvalidOperationException("No active project document.");
                scope = "active_project";
            }

            var isDryRun = (p.dryRun ?? false) || (p.apply.HasValue && p.apply.Value == false);
            var apply = !isDryRun;

            var tn = targetDoc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.textNoteId)) as TextNote;
            if (tn == null) throw new InvalidOperationException($"TextNote {p.textNoteId} not found.");

            var before = tn.Text ?? "";
            var changed = !string.Equals(before, nextText, StringComparison.Ordinal);

            var requiredConfirm = (string?)null;
            var confirmReceived = BulkConfirmUtil.Normalize(p.confirm);
            if (apply && changed)
            {
                requiredConfirm = "APPLY 1 TEXT NOTE CHANGE";
                if (!BulkConfirmUtil.EqualsNormalized(p.confirm, requiredConfirm))
                {
                    throw new OperatorToolUserErrorException(
                        message: "TextNote edit requires typed confirmation.",
                        code: "bulk_confirm_required",
                        requiredConfirm: requiredConfirm,
                        confirmReceived: confirmReceived,
                        maxChangesPerCall: null,
                        hint: "Retry with confirm set to the requiredConfirm string (markdown like **...** is ok). If OPERATOR_BULK_CONFIRM_SIMPLE=1, you can also use confirm:\"yes\".");
                }
            }

            if (apply && changed)
            {
                using (var tx = new Transaction(targetDoc, "Operator Set TextNote Text"))
                {
                    tx.Start();
                    tn.Text = nextText;
                    tx.Commit();
                }
            }

            return Task.FromResult<object>(new
            {
                ok = true,
                status = apply ? "Applied" : "Dry Run",
                dryRun = !apply,
                scope,
                familyDocumentId,
                familyName,
                textNoteId = p.textNoteId,
                elementId = p.textNoteId,
                ownerViewId = SafeOwnerViewId(tn),
                before,
                after = apply ? nextText : before,
                text = apply ? nextText : before,
                normalizedText = NormalizeUserText(apply ? nextText : before),
                changed,
                requiredConfirm,
                confirmReceived
            });
        }

        private static string NormalizeUserText(string s)
        {
            // Allow callers to pass literal "\n" / "\r\n" and have it become an actual line break.
            // (JSON strings already support "\n", but some callers escape it twice.)
            var t = s ?? "";
            if (t.IndexOf("\\n", StringComparison.Ordinal) >= 0 || t.IndexOf("\\r", StringComparison.Ordinal) >= 0)
            {
                t = t.Replace("\\r\\n", "\n").Replace("\\n", "\n").Replace("\\r", "\n");
            }
            return t.Replace("\r\n", "\n").Replace('\r', '\n');
        }

        private static long? SafeOwnerViewId(TextNote textNote)
        {
            try
            {
                var ownerViewId = textNote.OwnerViewId;
                if (ownerViewId == null || ownerViewId == ElementId.InvalidElementId) return null;
                var value = RevitBridge.Common.ElementIdCompat.GetValue(ownerViewId);
                return value > 0 ? value : (long?)null;
            }
            catch
            {
                return null;
            }
        }
    }
}

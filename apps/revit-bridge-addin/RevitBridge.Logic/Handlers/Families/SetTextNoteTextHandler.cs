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
            public string? expectedOldText { get; set; }

            public bool? apply { get; set; }
            public bool? dryRun { get; set; }
            public string? confirm { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.textNoteId == 0) throw new InvalidOperationException("set-text-note-text.textNoteId is required.");
            var nextText = TextNoteTextCanonicalizer.Normalize(p.newText ?? "");

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
            var expectedOldText = p.expectedOldText == null ? null : TextNoteTextCanonicalizer.Normalize(p.expectedOldText);

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

            var transactionReceipt = OperatorNativeTransactionReceipt.NotStarted(new[] { p.textNoteId });

            if ((apply && changed) || expectedOldText != null)
            {
                using (var tx = new Transaction(targetDoc, "Operator Set TextNote Text"))
                {
                    tx.Start();
                    before = tn.Text ?? "";
                    changed = !string.Equals(before, nextText, StringComparison.Ordinal);
                    // Revit can surface semantically identical TextNote line endings as CR,
                    // CRLF, or LF depending on how the note was created/read. Bind the
                    // stale-state guard to the same canonical text form used for requests,
                    // while retaining the raw `before` value in the receipt.
                    if (expectedOldText != null && !string.Equals(TextNoteTextCanonicalizer.Normalize(before), expectedOldText, StringComparison.Ordinal))
                    {
                        var rollbackStatus = tx.RollBack();
                        transactionReceipt = rollbackStatus == TransactionStatus.RolledBack
                            ? OperatorNativeTransactionReceipt.RolledBack(new[] { p.textNoteId })
                            : OperatorNativeTransactionReceipt.Unknown(rollbackStatus.ToString(), new[] { p.textNoteId });
                        return Task.FromResult<object>(new
                        {
                            ok = false,
                            status = "Precondition Failed",
                            errorCode = "expected_old_text_mismatch",
                            error = "Text note changed after it was read; no text was replaced.",
                            dryRun = !apply,
                            scope,
                            familyDocumentId,
                            familyName,
                            textNoteId = p.textNoteId,
                            elementId = p.textNoteId,
                            ownerViewId = SafeOwnerViewId(tn),
                            expectedOldText,
                            actualText = before,
                            proposedText = nextText,
                            changed = false,
                            transaction = transactionReceipt,
                            requiredConfirm,
                            confirmReceived
                        });
                    }
                    if (apply && changed)
                    {
                        tn.Text = nextText;
                        var commitStatus = tx.Commit();
                        transactionReceipt = commitStatus == TransactionStatus.Committed
                            ? OperatorNativeTransactionReceipt.Committed(new[] { p.textNoteId })
                            : OperatorNativeTransactionReceipt.Unknown(commitStatus.ToString(), new[] { p.textNoteId });
                    }
                    else
                    {
                        var rollbackStatus = tx.RollBack();
                        transactionReceipt = rollbackStatus == TransactionStatus.RolledBack
                            ? OperatorNativeTransactionReceipt.RolledBack(new[] { p.textNoteId })
                            : OperatorNativeTransactionReceipt.Unknown(rollbackStatus.ToString(), new[] { p.textNoteId });
                    }
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
                // `after` and `text` describe persistent model truth. A dry-run
                // rolls back, so the evaluated proposal is retained separately
                // and can be bound to the admitted request by the V2 adapter.
                proposedText = nextText,
                after = apply ? nextText : before,
                text = apply ? nextText : before,
                normalizedText = TextNoteTextCanonicalizer.Normalize(apply ? nextText : before),
                changed,
                transaction = transactionReceipt,
                requiredConfirm,
                confirmReceived
            });
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

using System;
using System.Text.Json;
namespace RevitBridge.Common
{
    public static class OperatorFamilyCloseReceipt
    {
        public const string Schema = "revit-operator.family-session-close.v1";
        // A rejected lookup proves only that this request never saved/closed a
        // document. It does not reconcile an earlier session's history.
        public static object SessionUnavailable(string sessionId, bool saveRequested)
        {
            if (!Guid.TryParseExact(sessionId, "N", out _)) throw new ArgumentException("A valid family document session id is required.");
            return new { ok = false, closed = false, saved = false,
                code = "family_session_unavailable", familyDocumentId = sessionId,
                error = "The family edit session is no longer registered. This request did not save or close a document; inspect the loaded family before further work.",
                family_close_receipt = new { schema = Schema, status = "lookup_rejected", session_id = sessionId,
                    session_lookup_succeeded = false, native_save_started = false, native_close_started = false, save_requested = saveRequested } };
        }
        public static object Closed(string sessionId, bool saveRequested, bool closed, bool unregistered)
        {
            if (!Guid.TryParseExact(sessionId, "N", out _) || !closed || !unregistered)
                throw new InvalidOperationException("Family close was not verified.");
            return new { schema = Schema, status = "closed", session_id = sessionId,
                native_close_returned = true, document_closed = true, session_unregistered = true, save_requested = saveRequested };
        }
        public static bool TrySettlement(JsonElement root, string effect, string method, string path, out OperatorAttemptSettlement? settlement)
        {
            settlement = null;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("family_close_receipt", out var r)) return false;
            try
            {
                if (r.GetProperty("status").GetString() == "lookup_rejected")
                {
                    if (effect != "apply" || method != "POST" || path != "/revit/close-doc"
                        || root.GetProperty("ok").ValueKind != JsonValueKind.False
                        || root.GetProperty("closed").ValueKind != JsonValueKind.False || root.GetProperty("saved").ValueKind != JsonValueKind.False
                        || root.GetProperty("code").GetString() != "family_session_unavailable"
                        || r.GetProperty("schema").GetString() != Schema
                        || !Guid.TryParseExact(r.GetProperty("session_id").GetString(), "N", out _)
                        || r.GetProperty("session_id").GetString() != root.GetProperty("familyDocumentId").GetString()
                        || r.GetProperty("session_lookup_succeeded").ValueKind != JsonValueKind.False
                        || r.GetProperty("native_save_started").ValueKind != JsonValueKind.False
                        || r.GetProperty("native_close_started").ValueKind != JsonValueKind.False
                        || (r.GetProperty("save_requested").ValueKind != JsonValueKind.False && r.GetProperty("save_requested").ValueKind != JsonValueKind.True)) return true;
                    settlement = OperatorAttemptSettlement.None(effect, method, path, "family_session_unavailable", "native_receipt", true);
                    return true;
                }
                if (effect != "apply" || method != "POST" || path != "/revit/close-doc"
                    || root.GetProperty("ok").ValueKind != JsonValueKind.True || root.GetProperty("closed").ValueKind != JsonValueKind.True
                    || r.GetProperty("schema").GetString() != Schema || r.GetProperty("status").GetString() != "closed"
                    || !Guid.TryParseExact(r.GetProperty("session_id").GetString(), "N", out _)
                    || r.GetProperty("session_id").GetString() != root.GetProperty("familyDocumentId").GetString()
                    || r.GetProperty("native_close_returned").ValueKind != JsonValueKind.True
                    || r.GetProperty("document_closed").ValueKind != JsonValueKind.True
                    || r.GetProperty("session_unregistered").ValueKind != JsonValueKind.True) return true;
                if (r.GetProperty("save_requested").ValueKind == JsonValueKind.True)
                {
                    // Compose the existing stable saved-file proof with independently verified close.
                    OperatorFamilySaveReceipt.TrySettlement(root, effect, method, "/revit/save-family-doc", out var saved);
                    if (saved == null) return true;
                    settlement = OperatorAttemptSettlement.Applied(method, path, "native_family_saved_and_closed", "native_receipt", saved.AffectedTargetIdentities, saved.ReceiptRefs);
                }
                else if (r.GetProperty("save_requested").ValueKind == JsonValueKind.False && root.GetProperty("saved").ValueKind == JsonValueKind.False)
                    settlement = OperatorAttemptSettlement.None(effect, method, path, "native_family_closed_without_file_or_project_write", "native_receipt", true);
            }
            catch (Exception) { }
            return true;
        }
    }
}

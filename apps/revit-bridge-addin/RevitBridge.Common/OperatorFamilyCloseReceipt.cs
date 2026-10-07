using System;
using System.Text.Json;
namespace RevitBridge.Common
{
    public static class OperatorFamilyCloseReceipt
    {
        public const string Schema = "revit-operator.family-session-close.v1";
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

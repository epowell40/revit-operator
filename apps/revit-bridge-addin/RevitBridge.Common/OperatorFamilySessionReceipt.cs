using System;
using System.Text.Json;

namespace RevitBridge.Common
{
    // Opening an edit session is preparation: it neither edits the project nor
    // saves a family file. Keep that lifecycle outcome distinct from a commit.
    public static class OperatorFamilySessionReceipt
    {
        public const string Schema = "revit-operator.family-session-open.v1";

        public static object Opened(string sessionId, string sourceKind, string sourceId,
            bool documentValid, bool sessionRegistered)
        {
            if (!Guid.TryParseExact(sessionId, "N", out _) || string.IsNullOrWhiteSpace(sourceId)
                || (sourceKind != "instance" && sourceKind != "family" && sourceKind != "file")
                || !documentValid || !sessionRegistered)
                throw new InvalidOperationException("Family edit session could not be verified.");
            return new { schema = Schema, status = "opened", session_id = sessionId,
                source_kind = sourceKind, source_id = sourceId, document_valid = true,
                session_registered = true, model_write_performed = false, file_write_performed = false };
        }

        public static bool TrySettlement(JsonElement root, string effect, string method, string path,
            out OperatorAttemptSettlement? settlement)
        {
            settlement = null;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("family_session_receipt", out var r)) return false;
            try
            {
                if (effect != "apply" || method != "POST" || (path != "/revit/open-family-doc" && path != "/revit/edit-family-from-instance")
                    || root.GetProperty("ok").ValueKind != JsonValueKind.True
                    || r.GetProperty("schema").GetString() != Schema || r.GetProperty("status").GetString() != "opened"
                    || !Guid.TryParseExact(r.GetProperty("session_id").GetString(), "N", out _)
                    || r.GetProperty("session_id").GetString() != root.GetProperty("familyDocumentId").GetString()
                    || r.GetProperty("document_valid").ValueKind != JsonValueKind.True
                    || r.GetProperty("session_registered").ValueKind != JsonValueKind.True
                    || r.GetProperty("model_write_performed").ValueKind != JsonValueKind.False
                    || r.GetProperty("file_write_performed").ValueKind != JsonValueKind.False) return true;
                var kind = r.GetProperty("source_kind").GetString();
                var source = r.GetProperty("source_id").GetString();
                if (string.IsNullOrWhiteSpace(source) || (kind != "instance" && kind != "family" && kind != "file")
                    || (path == "/revit/edit-family-from-instance" && kind != "instance")) return true;
                settlement = OperatorAttemptSettlement.None(effect, method, path,
                    "native_family_session_opened_without_model_or_file_write", "native_receipt", requestDispatched: true);
                settlement.ReceiptRefs = new[] { "family_session:" + r.GetProperty("session_id").GetString() };
                return true;
            }
            catch (Exception) { return true; }
        }
    }
}

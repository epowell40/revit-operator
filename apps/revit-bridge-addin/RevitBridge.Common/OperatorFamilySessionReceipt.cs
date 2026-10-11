using System;
using System.Text.Json;

namespace RevitBridge.Common
{
    // Opening an edit session is preparation: it neither edits the project nor
    // saves a family file. Keep that lifecycle outcome distinct from a commit.
    public static class OperatorFamilySessionReceipt
    {
        public const string Schema = "revit-operator.family-session-open.v1";

        public static object CapacityRefusal(int retainedCount, int limit)
        {
            if (limit <= 0 || retainedCount < limit) throw new ArgumentOutOfRangeException(nameof(retainedCount));
            return new { ok = false, code = "family_session_capacity_reached",
                error = "Close an existing family edit session before opening another; retained edits were not discarded.",
                hint = "Use close-doc with an existing docId and saveChanges:false only when its edits may be discarded, then retry opening the family.",
                family_session_receipt = new { schema = Schema, status = "capacity_rejected",
                    retained_count = retainedCount, limit, native_open_started = false,
                    retained_sessions_unchanged = true, model_write_performed = false, file_write_performed = false } };
        }

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
                if (r.GetProperty("status").GetString() == "capacity_rejected")
                {
                    if (effect != "apply" || method != "POST" || (path != "/revit/open-family-doc" && path != "/revit/edit-family-from-instance")
                        || root.GetProperty("ok").ValueKind != JsonValueKind.False
                        || root.GetProperty("code").GetString() != "family_session_capacity_reached"
                        || r.GetProperty("schema").GetString() != Schema
                        || r.GetProperty("limit").GetInt32() <= 0
                        || r.GetProperty("retained_count").GetInt32() < r.GetProperty("limit").GetInt32()
                        || r.GetProperty("native_open_started").ValueKind != JsonValueKind.False
                        || r.GetProperty("retained_sessions_unchanged").ValueKind != JsonValueKind.True
                        || r.GetProperty("model_write_performed").ValueKind != JsonValueKind.False
                        || r.GetProperty("file_write_performed").ValueKind != JsonValueKind.False) return true;
                    settlement = OperatorAttemptSettlement.None(effect, method, path,
                        "family_session_capacity_reached", "native_receipt", requestDispatched: true);
                    return true;
                }
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

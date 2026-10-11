using System;
using System.Text.Json;

namespace RevitBridge.Common
{
    // LoadFamily owns its internal transaction. Never report a caller transaction
    // as committed: retain the returned family and its project readback instead.
    public static class OperatorFamilyReloadReceipt
    {
        public const string Schema = "revit-operator.family-reload.v1";
        public static object Loaded(string sessionId, long familyId, string uniqueId, bool sameProject)
        {
            if (!Guid.TryParseExact(sessionId, "N", out _) || familyId <= 0 || string.IsNullOrWhiteSpace(uniqueId) || !sameProject)
                throw new InvalidOperationException("Loaded family identity was not verified.");
            return new { schema = Schema, status = "loaded", session_id = sessionId,
                family_id = familyId, family_unique_id = uniqueId, native_load_returned = true, project_readback_verified = true };
        }
        public static bool TrySettlement(JsonElement root, string effect, string method, string path, out OperatorAttemptSettlement? settlement)
        {
            settlement = null;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("family_reload_receipt", out var r)) return false;
            try
            {
                if (effect != "apply" || method != "POST" || (path != "/revit/load-family-doc" && path != "/revit/reload-family-edit-session")
                    || root.GetProperty("ok").ValueKind != JsonValueKind.True
                    || r.GetProperty("schema").GetString() != Schema || r.GetProperty("status").GetString() != "loaded"
                    || !Guid.TryParseExact(r.GetProperty("session_id").GetString(), "N", out _)
                    || r.GetProperty("session_id").GetString() != root.GetProperty("familyDocumentId").GetString()
                    || r.GetProperty("native_load_returned").ValueKind != JsonValueKind.True
                    || r.GetProperty("project_readback_verified").ValueKind != JsonValueKind.True) return true;
                var id = r.GetProperty("family_id").GetInt64();
                var uniqueId = r.GetProperty("family_unique_id").GetString();
                if (id <= 0 || id != root.GetProperty("loadedFamilyId").GetInt64() || string.IsNullOrWhiteSpace(uniqueId)) return true;
                settlement = OperatorAttemptSettlement.Applied(method, path, "native_family_load_returned_and_project_identity_verified", "native_receipt",
                    new[] { "element:" + id }, new[] { "family_session:" + r.GetProperty("session_id").GetString(), "family_unique_id:" + uniqueId });
            }
            catch (Exception) { }
            return true;
        }
    }
}

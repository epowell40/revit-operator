using System;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    // Only this native authoring handler produces these facts. File/save/load
    // success is never inferred from an assistant claim or an output filename.
    public static class OperatorFamilyCreationReceipt
    {
        public const string Schema = "revit-operator.family-creation.v1";
        public static object Rejected(string error) => new
        {
            ok = false, status = "Rejected", error,
            family_creation_receipt = new { schema = Schema, status = "not_started",
                reason = "preflight_failed", native_family_document_created = false,
                file_write_performed = false, project_load_invoked = false }
        };

        public static object Created(object savedFile, bool loadRequested, long? familyId, bool loadCommitted) => new
        {
            schema = Schema, status = "created", file = savedFile,
            native_family_document_closed = true, load_requested = loadRequested,
            project_load_committed = loadCommitted, loaded_family_id = familyId
        };

        public static bool TrySettlement(JsonElement root, string effect, string method, string path,
            out OperatorAttemptSettlement? settlement)
        {
            settlement = null;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("family_creation_receipt", out var r)) return false;
            try
            {
                if (effect != "apply" || method != "POST" || path != "/revit/create-family-from-template"
                    || r.GetProperty("schema").GetString() != Schema) return true;
                if (r.GetProperty("status").GetString() == "not_started")
                {
                    if (root.GetProperty("ok").ValueKind == JsonValueKind.False && root.GetProperty("status").GetString() == "Rejected"
                        && r.GetProperty("reason").GetString() == "preflight_failed"
                        && r.GetProperty("native_family_document_created").ValueKind == JsonValueKind.False
                        && r.GetProperty("file_write_performed").ValueKind == JsonValueKind.False
                        && r.GetProperty("project_load_invoked").ValueKind == JsonValueKind.False)
                        settlement = OperatorAttemptSettlement.None(effect, method, path,
                            "native_family_creation_preflight_rejected", "native_receipt", requestDispatched: true);
                    return true;
                }
                var file = r.GetProperty("file");
                var target = file.GetProperty("path").GetString() ?? "";
                var hash = file.GetProperty("sha256").GetString() ?? "";
                if (r.GetProperty("status").GetString() != "created" || root.GetProperty("ok").ValueKind != JsonValueKind.True
                    || root.GetProperty("status").GetString() != "Created" || target != root.GetProperty("filePath").GetString()
                    || !Path.IsPathRooted(target) || !string.Equals(Path.GetExtension(target), ".rfa", StringComparison.OrdinalIgnoreCase)
                    || file.GetProperty("schema").GetString() != OperatorFamilySaveReceipt.Schema
                    || file.GetProperty("status").GetString() != "saved"
                    || !Guid.TryParseExact(file.GetProperty("session_id").GetString(), "N", out _)
                    || file.GetProperty("native_save_returned").ValueKind != JsonValueKind.True
                    || file.GetProperty("document_path_verified").ValueKind != JsonValueKind.True
                    || file.GetProperty("stable_read").ValueKind != JsonValueKind.True
                    || file.GetProperty("size_bytes").GetInt64() <= 0 || hash.Length != 64
                    || hash.Any(c => !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f'))
                    || r.GetProperty("native_family_document_closed").ValueKind != JsonValueKind.True) return true;
                var requested = r.GetProperty("load_requested").GetBoolean();
                var committed = r.GetProperty("project_load_committed").GetBoolean();
                var id = r.GetProperty("loaded_family_id");
                if (requested ? !committed || id.GetInt64() <= 0 || root.GetProperty("load").GetProperty("familyId").GetInt64() != id.GetInt64()
                    : committed || id.ValueKind != JsonValueKind.Null || root.GetProperty("load").ValueKind != JsonValueKind.Null) return true;
                var targets = requested ? new[] { "artifact_path:" + target, "element:" + id.GetInt64() } : new[] { "artifact_path:" + target };
                settlement = OperatorAttemptSettlement.Applied(method, path,
                    "native_family_saved_closed_and_requested_load_committed", "native_receipt", targets,
                    new[] { "sha256:" + hash, "family_creation:" + file.GetProperty("session_id").GetString() });
            }
            catch (Exception) { }
            return true;
        }
    }
}

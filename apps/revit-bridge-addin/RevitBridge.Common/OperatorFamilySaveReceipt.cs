using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class OperatorFamilySaveReceipt
    {
        public const string Schema = "revit-operator.family-save.v1";
        // This guard runs before directory creation or any native Save/SaveAs call.
        public static bool TryRejectExistingTarget(string sessionId, string path, bool overwrite, out object? result)
        {
            result = null;
            if (overwrite || !File.Exists(path)) return false;
            if (!Guid.TryParseExact(sessionId, "N", out _) || !Path.IsPathRooted(path)
                || !string.Equals(Path.GetExtension(path), ".rfa", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Family save target identity is invalid.");
            result = new { ok = false, saved = false, familyDocumentId = sessionId, docId = sessionId,
                filePath = path, error = "Family file already exists and overwrite=false: " + path,
                family_save_receipt = new { schema = Schema, status = "rejected", session_id = sessionId, path,
                    reason = "existing_target_overwrite_disabled", existing_target = true, overwrite = false,
                    native_save_invoked = false, file_write_performed = false, model_write_performed = false } };
            return true;
        }
        // Called only after Save/SaveAs returned. File bytes are read with Revit's
        // open handle shared; changing bytes or an absent file remain unverified.
        public static object Saved(string sessionId, string path, bool documentPathMatches)
        {
            if (!Guid.TryParseExact(sessionId, "N", out _) || !Path.IsPathRooted(path)
                || !string.Equals(Path.GetExtension(path), ".rfa", StringComparison.OrdinalIgnoreCase) || !documentPathMatches)
                throw new InvalidOperationException("Saved family identity was not verified.");
            var before = new FileInfo(path); var size = before.Length; var written = before.LastWriteTimeUtc;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var sha = SHA256.Create();
            var hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            var after = new FileInfo(path);
            if (size <= 0 || !after.Exists || size != after.Length || stream.Length != size || written != after.LastWriteTimeUtc)
                throw new InvalidOperationException("Saved family file changed during readback.");
            return new { schema = Schema, status = "saved", session_id = sessionId, path,
                native_save_returned = true, document_path_verified = true, stable_read = true, size_bytes = size, sha256 = hash };
        }
        public static bool TrySettlement(JsonElement root, string effect, string method, string path, out OperatorAttemptSettlement? settlement)
        {
            settlement = null;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("family_save_receipt", out var r)) return false;
            try
            {
                if (r.TryGetProperty("status", out var status) && status.GetString() == "rejected")
                {
                    var target = r.GetProperty("path").GetString() ?? "";
                    if (effect == "apply" && method == "POST" && path == "/revit/save-family-doc"
                        && root.GetProperty("ok").ValueKind == JsonValueKind.False && root.GetProperty("saved").ValueKind == JsonValueKind.False
                        && r.GetProperty("schema").GetString() == Schema
                        && Guid.TryParseExact(r.GetProperty("session_id").GetString(), "N", out _)
                        && r.GetProperty("session_id").GetString() == root.GetProperty("familyDocumentId").GetString()
                        && Path.IsPathRooted(target) && string.Equals(Path.GetExtension(target), ".rfa", StringComparison.OrdinalIgnoreCase)
                        && target == root.GetProperty("filePath").GetString()
                        && r.GetProperty("reason").GetString() == "existing_target_overwrite_disabled"
                        && r.GetProperty("existing_target").ValueKind == JsonValueKind.True
                        && r.GetProperty("overwrite").ValueKind == JsonValueKind.False
                        && r.GetProperty("native_save_invoked").ValueKind == JsonValueKind.False
                        && r.GetProperty("file_write_performed").ValueKind == JsonValueKind.False
                        && r.GetProperty("model_write_performed").ValueKind == JsonValueKind.False)
                        settlement = OperatorAttemptSettlement.None(effect, method, path,
                            "native_family_save_rejected_before_save", "native_receipt", requestDispatched: true);
                    return true;
                }
                if (effect != "apply" || method != "POST" || path != "/revit/save-family-doc"
                    || root.GetProperty("ok").ValueKind != JsonValueKind.True || root.GetProperty("saved").ValueKind != JsonValueKind.True
                    || r.GetProperty("schema").GetString() != Schema || r.GetProperty("status").GetString() != "saved"
                    || !Guid.TryParseExact(r.GetProperty("session_id").GetString(), "N", out _)
                    || r.GetProperty("session_id").GetString() != root.GetProperty("familyDocumentId").GetString()
                    || r.GetProperty("native_save_returned").ValueKind != JsonValueKind.True
                    || r.GetProperty("document_path_verified").ValueKind != JsonValueKind.True
                    || r.GetProperty("stable_read").ValueKind != JsonValueKind.True || r.GetProperty("size_bytes").GetInt64() <= 0) return true;
                var file = r.GetProperty("path").GetString() ?? ""; var hash = r.GetProperty("sha256").GetString() ?? "";
                if (!Path.IsPathRooted(file) || !string.Equals(Path.GetExtension(file), ".rfa", StringComparison.OrdinalIgnoreCase)
                    || file != root.GetProperty("filePath").GetString() || hash.Length != 64
                    || hash.Any(c => !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f'))) return true;
                settlement = OperatorAttemptSettlement.Applied(method, path, "native_family_save_returned_and_file_verified", "native_receipt",
                    new[] { "artifact_path:" + file }, new[] { "sha256:" + hash, "family_session:" + r.GetProperty("session_id").GetString() });
            }
            catch (Exception) { }
            return true;
        }
    }
}

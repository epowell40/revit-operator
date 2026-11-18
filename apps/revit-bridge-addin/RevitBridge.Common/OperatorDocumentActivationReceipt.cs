using System;
using System.IO;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class OperatorDocumentActivationReceipt
    {
        private const string Schema = "revit-operator.document-activation.v1";
        private const string Scope = "open_existing_file_without_edits";

        // Only emit after the native handler confirms that the exact returned
        // document is active and unmodified. The caller retains normal write admission.
        public static object? Confirmed(string requestedPath, string activePath, string sessionId)
        {
            if (!SameFile(requestedPath, activePath) || !Guid.TryParseExact(sessionId, "N", out var session) || session == Guid.Empty)
                return null;

            return new
            {
                schema = Schema,
                requested_path = requestedPath,
                active_path = activePath,
                active_document_session_id = sessionId,
                active_document_unmodified = true,
                scope = Scope
            };
        }

        public static bool TrySettlement(JsonElement root, string effect, string method, string path,
            out OperatorAttemptSettlement? settlement)
        {
            settlement = null;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("document_activation_receipt", out var receipt)
                || receipt.ValueKind == JsonValueKind.Null) return false;

            if (effect != "apply" || method != "POST" || path != "/revit/open-model" || receipt.ValueKind != JsonValueKind.Object
                || ReadString(root, "status") != "Success" || ReadString(receipt, "schema") != Schema || ReadString(receipt, "scope") != Scope
                || !receipt.TryGetProperty("active_document_unmodified", out var unmodified) || unmodified.ValueKind != JsonValueKind.True
                || !Guid.TryParseExact(ReadString(receipt, "active_document_session_id"), "N", out var session) || session == Guid.Empty
                || !SameFile(ReadString(receipt, "requested_path"), ReadString(receipt, "active_path"))
                || !SameFile(ReadString(receipt, "active_path"), ReadString(root, "path"))) return true;

            settlement = OperatorAttemptSettlement.None(effect, method, path,
                "native_document_activation_confirmed", "native_receipt", requestDispatched: true);
            settlement.ReceiptRefs = new[] { "active_document:" + session.ToString("N") };
            return true;
        }

        private static string? ReadString(JsonElement value, string property)
            => value.TryGetProperty(property, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;

        private static bool SameFile(string? requested, string? observed)
        {
            if (string.IsNullOrWhiteSpace(requested) || string.IsNullOrWhiteSpace(observed)) return false;
            try
            {
                return Path.GetPathRoot(requested)?.Length >= 3 && Path.GetPathRoot(observed)?.Length >= 3
                    && string.Equals(Path.GetFullPath(requested!), Path.GetFullPath(observed!), StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception error) when (error is ArgumentException || error is NotSupportedException || error is IOException)
            {
                return false;
            }
        }
    }
}

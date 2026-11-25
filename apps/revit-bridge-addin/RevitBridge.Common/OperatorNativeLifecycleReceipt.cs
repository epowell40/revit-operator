using System;
using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Common
{
    // These Revit operations own their internal transactions. A returned API call
    // is evidence of execution, not proof of drawing correctness or task completion.
    public static class OperatorNativeLifecycleReceipt
    {
        public const string Schema = "revit-operator.native-lifecycle.v1";
        public static bool Supports(string path, string action) =>
            path == "/revit/sync" && (action == "sync" || action == "reload_latest") ||
            path == "/revit/link-revit" && (action == "load" || action == "reload" || action == "unload");

        public static Dictionary<string, object?> Execute(string path, string action, string session,
            Action invoke, Func<Dictionary<string, object?>> readback)
        {
            if (!Supports(path, action) || !Guid.TryParseExact(session, "N", out var id) || id == Guid.Empty)
                throw new ArgumentException("Unsupported lifecycle operation or missing native document identity.");
            bool returned = false;
            try
            {
                invoke(); returned = true;
                var result = readback();
                result["lifecycle_receipt"] = Receipt(path, action, session, true);
                return result;
            }
            catch (Exception ex)
            {
                // Never retry or roll back an externally visible lifecycle call.
                return new Dictionary<string, object?> {
                    ["status"] = "Error", ["success"] = false, ["error"] = ex.Message,
                    ["nativeCallReturned"] = returned,
                    ["lifecycle_receipt"] = Receipt(path, action, session, returned),
                    ["recovery"] = "Inspect the current model/link state before another mutation; this call was not retried or undone."
                };
            }
        }

        private static object Receipt(string path, string action, string session, bool returned) => new {
            schema = Schema, path, action, document_session_id = session,
            native_call_attempted = true, native_call_returned = returned,
            transaction_ownership = "revit_api", status = returned ? "returned" : "unknown"
        };

        public static bool TrySettlement(JsonElement root, string effect, string method, string path,
            out OperatorAttemptSettlement? settlement)
        {
            settlement = null;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("lifecycle_receipt", out var r)) return false;
            string? Text(string key) => r.ValueKind == JsonValueKind.Object && r.TryGetProperty(key, out var v)
                && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            bool Yes(string key) => r.ValueKind == JsonValueKind.Object && r.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;
            if (method != "POST" || effect != "apply" || Text("schema") != Schema || Text("path") != path
                || !Supports(path, Text("action") ?? "") || Text("transaction_ownership") != "revit_api"
                || !Guid.TryParseExact(Text("document_session_id"), "N", out var session) || session == Guid.Empty
                || !Yes("native_call_attempted") || !Yes("native_call_returned") || Text("status") != "returned") return true;
            settlement = OperatorAttemptSettlement.Applied(method, path, "native_lifecycle_returned", "native_receipt");
            return true;
        }
    }
}

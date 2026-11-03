using System;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    // A narrow transport for the existing native executor, not a shell/job API.
    public static class OperatorNativeProgramCourierRequest
    {
        public const string ReadPath = "/revit/dynamic-runtime/run-native-read-v1";
        public const string ApplyPath = "/revit/dynamic-runtime/run-native-apply-v1";
        public static bool IsRoute(string method, string path) => method == "POST" && (path == ReadPath || path == ApplyPath);
        public static JsonElement Validate(string path, string body)
        {
            using var parsed = JsonDocument.Parse(body);
            var value = parsed.RootElement;
            var fields = new[] { "source", "targetRevitYear", "expectedDocumentFingerprint", "nativeProgram", "workerDeadlineMs" };
            if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() != fields.Length
                || fields.Any(name => !value.TryGetProperty(name, out _))
                || value.EnumerateObject().Any(p => !fields.Contains(p.Name))) throw new ArgumentException("Invalid native courier fields.");
            var source = value.GetProperty("source").GetString();
            var fingerprint = value.GetProperty("expectedDocumentFingerprint").GetString();
            var program = value.GetProperty("nativeProgram");
            var programFields = new[] { "entryType", "mode", "effectScope", "allowedExistingUniqueIds", "allowCreate", "maxAffectedElements", "deadlineMs" };
            if (source == null || source.Length < 1 || source.Length > 128000 || source.Contains('\0')
                || !new[] { "2023", "2024", "2025", "2026", "2027" }.Contains(value.GetProperty("targetRevitYear").GetString())
                || fingerprint == null || fingerprint.Length != 71 || !fingerprint.StartsWith("sha256:", StringComparison.Ordinal)
                || fingerprint.Skip(7).Any(c => !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f'))
                || value.GetProperty("workerDeadlineMs").GetInt32() < 1000 || value.GetProperty("workerDeadlineMs").GetInt32() > 30000
                || program.ValueKind != JsonValueKind.Object || program.EnumerateObject().Any(p => !programFields.Contains(p.Name))
                || program.EnumerateObject().GroupBy(p => p.Name).Any(g => g.Count() != 1)
                || program.GetProperty("mode").GetString() != (path == ReadPath ? "read" : path == ApplyPath ? "write" : "invalid"))
                throw new ArgumentException("Invalid native courier source, document, year or mode.");
            return value.Clone();
        }
    }
}

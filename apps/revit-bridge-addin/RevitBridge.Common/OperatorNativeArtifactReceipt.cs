using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitBridge.Common
{
    /// <summary>Native file-export truth. This is not a Revit transaction receipt.</summary>
    public sealed class OperatorNativeArtifactReceipt
    {
        public const string Version = "revit-operator.native-artifact-receipt.v1";
        [JsonPropertyName("schema")] public string Schema => Version;
        [JsonPropertyName("method")] public string Method => "POST";
        [JsonPropertyName("path")] public string Path { get; }
        [JsonPropertyName("print_settings_restored"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public bool? PrintSettingsRestored { get; }
        [JsonPropertyName("print_settings_untouched"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public bool? PrintSettingsUntouched { get; private set; }
        [JsonPropertyName("not_started_reason"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? NotStartedReason { get; private set; }
        [JsonPropertyName("phase")] public string Phase { get; }
        [JsonPropertyName("status")] public string Status { get; }
        [JsonPropertyName("expected_output_paths")] public IReadOnlyList<string> ExpectedOutputPaths { get; }
        [JsonPropertyName("expected_export_calls")] public int ExpectedExportCalls { get; }
        [JsonPropertyName("export_calls")] public IReadOnlyList<bool> ExportCalls { get; }
        [JsonPropertyName("outputs")] public IReadOnlyList<OperatorNativeArtifactFile> Outputs { get; }

        internal OperatorNativeArtifactReceipt(string phase, string status, string[] paths, int expectedCalls,
            bool[] calls, OperatorNativeArtifactFile[] outputs, string path = "/revit/export-pdf", bool? printSettingsRestored = null)
        {
            if (path != "/revit/export-pdf" && path != "/revit/print" && path != "/revit/export-elements-xlsx") throw new ArgumentException("Unsupported native file-export route.");
            Path = path; PrintSettingsRestored = printSettingsRestored;
            Phase = phase; Status = status; ExpectedOutputPaths = paths;
            ExpectedExportCalls = expectedCalls; ExportCalls = calls; Outputs = outputs;
        }

        public static OperatorNativeArtifactReceipt Preview(IEnumerable<string> paths, int expectedCalls, string path = "/revit/export-pdf")
            => new OperatorNativeArtifactReceipt("preview", "not_started", Normalize(paths, expectedCalls), expectedCalls,
                Array.Empty<bool>(), Array.Empty<OperatorNativeArtifactFile>(), path);

        public static OperatorNativeArtifactReceipt BlockedPrint(bool preview, string reason)
        {
            if (!IsPrintPreflightReason(reason)) throw new ArgumentException("Unsupported print preflight reason.");
            return new OperatorNativeArtifactReceipt(preview ? "preview" : "apply", "not_started", Array.Empty<string>(), 0,
                Array.Empty<bool>(), Array.Empty<OperatorNativeArtifactFile>(), "/revit/print")
                { PrintSettingsUntouched = true, NotStartedReason = reason };
        }

        private static bool IsPrintPreflightReason(string? reason) => reason == "interactive_printer_destination"
            || reason == "printer_capability_unavailable" || reason == "printer_unavailable" || reason == "no_printer_configured";

        internal static string[] Normalize(IEnumerable<string> paths, int expectedCalls)
        {
            var result = paths.Select(System.IO.Path.GetFullPath).ToArray();
            if (result.Length == 0 || result.Length > 2000 || expectedCalls < 1 || expectedCalls > result.Length
                || result.Distinct(StringComparer.OrdinalIgnoreCase).Count() != result.Length)
                throw new ArgumentException("Export requires unique output paths and a bounded positive native-call count.");
            return result;
        }

        public static bool TrySettlement(JsonElement root, string effect, string method, string path,
            out OperatorAttemptSettlement? settlement)
        {
            settlement = null;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("artifact_receipt", out var value)) return false;
            try
            {
                if (method != "POST" || (path != "/revit/export-pdf" && path != "/revit/print" && path != "/revit/export-elements-xlsx")
                    || value.GetProperty("schema").GetString() != Version
                    || value.GetProperty("method").GetString() != method || value.GetProperty("path").GetString() != path)
                    return true;
                var expected = value.GetProperty("expected_output_paths").EnumerateArray().Select(x => x.GetString() ?? "").ToArray();
                var expectedCalls = value.GetProperty("expected_export_calls").GetInt32();
                if (path == "/revit/print" && (effect == "apply" || effect == "preview")
                    && value.GetProperty("phase").GetString() == effect && value.GetProperty("status").GetString() == "not_started"
                    && expected.Length == 0 && expectedCalls == 0
                    && value.GetProperty("export_calls").GetArrayLength() == 0 && value.GetProperty("outputs").GetArrayLength() == 0
                    && value.TryGetProperty("print_settings_untouched", out var untouched) && untouched.ValueKind == JsonValueKind.True
                    && value.TryGetProperty("not_started_reason", out var reason) && reason.ValueKind == JsonValueKind.String
                    && IsPrintPreflightReason(reason.GetString()))
                {
                    settlement = OperatorAttemptSettlement.None(effect, method, path, "native_artifact_export_not_started", "native_receipt", requestDispatched: true);
                    return true;
                }
                if (expected.Length == 0 || expected.Length > 2000 || expectedCalls < 1 || expectedCalls > expected.Length
                    || expected.Any(x => !System.IO.Path.IsPathRooted(x))
                    || expected.Distinct(StringComparer.OrdinalIgnoreCase).Count() != expected.Length) return true;
                var calls = value.GetProperty("export_calls").EnumerateArray().Select(x => x.GetBoolean()).ToArray();
                var outputs = value.GetProperty("outputs").EnumerateArray().ToArray();
                var phase = value.GetProperty("phase").GetString();
                var status = value.GetProperty("status").GetString();
                if (effect == "preview" && phase == "preview" && status == "not_started" && calls.Length == 0 && outputs.Length == 0)
                {
                    settlement = OperatorAttemptSettlement.None(effect, method, path, "native_artifact_export_not_started", "native_receipt", requestDispatched: true);
                    return true;
                }
                if (effect != "apply" || phase != "apply" || status != "complete" || calls.Length != expectedCalls
                    || calls.Any(x => !x) || outputs.Length != expected.Length) return true;
                if (path == "/revit/print" && (!value.TryGetProperty("print_settings_restored", out var restored)
                    || restored.ValueKind != JsonValueKind.True)) return true;
                var refs = new List<string>();
                for (var i = 0; i < outputs.Length; i++)
                {
                    var file = outputs[i];
                    var hash = file.GetProperty("sha256").GetString() ?? "";
                    if (file.GetProperty("path").GetString() != expected[i] || file.GetProperty("size_bytes").GetInt64() <= 0
                        || !file.GetProperty("fresh_output").GetBoolean() || hash.Length != 64
                        || hash.Any(c => !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f'))) return true;
                    refs.Add("sha256:" + hash);
                }
                settlement = OperatorAttemptSettlement.Applied(method, path, "native_artifact_export_completed", "native_receipt",
                    expected.Select(x => "artifact_path:" + x).OrderBy(x => x, StringComparer.Ordinal).ToArray(), refs);
            }
            catch (Exception ex) when (ex is InvalidOperationException || ex is KeyNotFoundException || ex is FormatException || ex is OverflowException || ex is ArgumentException)
            {
                // Malformed or incomplete native evidence remains unknown; never infer completion from presentation status.
            }
            return true;
        }
    }

    public sealed class OperatorNativeArtifactFile
    {
        [JsonPropertyName("path")] public string Path { get; internal set; } = "";
        [JsonPropertyName("size_bytes")] public long SizeBytes { get; internal set; }
        [JsonPropertyName("sha256")] public string Sha256 { get; internal set; } = "";
        [JsonPropertyName("fresh_output")] public bool FreshOutput { get; internal set; }
        [JsonPropertyName("exists")] public bool Exists { get; internal set; }
        [JsonPropertyName("readable")] public bool Readable { get; internal set; }
    }

    /// <summary>Capture output state before calling the native exporter, then verify this invocation's files.</summary>
    public sealed class OperatorNativeArtifactCapture
    {
        private sealed class Snapshot
        {
            public bool Known; public bool Exists; public long Size; public DateTime Written; public string Hash = "";
        }
        private readonly string[] paths;
        private readonly Snapshot[] before;
        private readonly int expectedCalls;
        private readonly string routePath;
        private readonly List<bool> calls = new List<bool>();

        public OperatorNativeArtifactCapture(IEnumerable<string> outputPaths, int expectedExportCalls, string path = "/revit/export-pdf")
        {
            if (path != "/revit/export-pdf" && path != "/revit/print" && path != "/revit/export-elements-xlsx") throw new ArgumentException("Unsupported native file-export route.");
            routePath = path;
            paths = OperatorNativeArtifactReceipt.Normalize(outputPaths, expectedExportCalls);
            expectedCalls = expectedExportCalls;
            before = paths.Select(Read).ToArray();
        }

        public void RecordNativeExport(bool succeeded) => calls.Add(succeeded);

        public OperatorNativeArtifactReceipt Complete(bool? printSettingsRestored = null)
        {
            var outputs = paths.Select((path, i) =>
            {
                var after = Read(path); var prior = before[i];
                return new OperatorNativeArtifactFile { Path = path, SizeBytes = after.Size, Sha256 = after.Hash,
                    Exists = after.Exists, Readable = after.Known && after.Exists,
                    FreshOutput = prior.Known && after.Known && after.Exists && after.Size > 0
                        && (!prior.Exists || prior.Hash != after.Hash || prior.Written != after.Written) };
            }).ToArray();
            var complete = calls.Count == expectedCalls && calls.All(x => x) && outputs.All(x => x.FreshOutput)
                && (routePath != "/revit/print" || printSettingsRestored == true);
            return new OperatorNativeArtifactReceipt("apply", complete ? "complete" : "unverified", paths, expectedCalls, calls.ToArray(), outputs, routePath, printSettingsRestored);
        }

        public static IReadOnlyList<OperatorNativeArtifactFile> Inspect(IEnumerable<string> paths)
            => OperatorNativeArtifactReceipt.Normalize(paths, 1).Select(path =>
            {
                var file = Read(path);
                return new OperatorNativeArtifactFile { Path = path, Exists = file.Exists, Readable = file.Known && file.Exists,
                    SizeBytes = file.Size, Sha256 = file.Hash, FreshOutput = false };
            }).ToArray();

        private static Snapshot Read(string path)
        {
            try
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                using var sha = SHA256.Create();
                return new Snapshot { Known = true, Exists = true, Size = stream.Length, Written = File.GetLastWriteTimeUtc(path),
                    Hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant() };
            }
            catch (FileNotFoundException) { return new Snapshot { Known = true }; }
            catch (DirectoryNotFoundException) { return new Snapshot { Known = true }; }
            catch (IOException) { return new Snapshot(); }
            catch (UnauthorizedAccessException) { return new Snapshot(); }
        }
    }
}

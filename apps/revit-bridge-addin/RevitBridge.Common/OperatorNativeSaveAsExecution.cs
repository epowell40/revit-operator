using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitBridge.Common
{
    public sealed class OperatorNativeSaveDocumentIdentity
    {
        [JsonPropertyName("session_id")] public string SessionId { get; }
        [JsonPropertyName("project_fingerprint")] public string ProjectFingerprint { get; }
        [JsonPropertyName("path")] public string Path { get; }
        [JsonIgnore] public bool IsExpectedDocument { get; }
        public OperatorNativeSaveDocumentIdentity(string sessionId, string projectFingerprint, string path, bool isExpectedDocument = true)
        { SessionId = sessionId; ProjectFingerprint = projectFingerprint; Path = path; IsExpectedDocument = isExpectedDocument; }
    }

    /// <summary>Observed document identity, not permission to rebind an assignment after Save As.</summary>
    public sealed class OperatorNativeSavedDocument
    {
        [JsonPropertyName("native_save_returned")] public bool NativeSaveReturned { get; }
        [JsonPropertyName("before")] public OperatorNativeSaveDocumentIdentity Before { get; }
        [JsonPropertyName("after")] public OperatorNativeSaveDocumentIdentity? After { get; }
        [JsonPropertyName("same_document")] public bool SameDocument => Before.IsExpectedDocument && After?.IsExpectedDocument == true;
        [JsonPropertyName("document_session_changed")] public bool DocumentSessionChanged => After != null && Before.SessionId != After.SessionId;
        [JsonPropertyName("document_path_changed")] public bool DocumentPathChanged => After != null && !SamePath(Before.Path, After.Path);
        [JsonPropertyName("project_binding_changed")] public bool ProjectBindingChanged => After != null && Before.ProjectFingerprint != After.ProjectFingerprint;
        internal OperatorNativeSavedDocument(bool returned, OperatorNativeSaveDocumentIdentity before, OperatorNativeSaveDocumentIdentity? after)
        { NativeSaveReturned = returned; Before = before; After = after; }
        internal static bool SamePath(string left, string right) => string.Equals(left.Replace('\\', '/'), right.Replace('\\', '/'), StringComparison.OrdinalIgnoreCase);
        internal static bool ValidIdentity(OperatorNativeSaveDocumentIdentity value) => ValidSession(value.SessionId)
            && Hash(value.ProjectFingerprint) && value.Path != null && (value.Path.Length == 0 || Absolute(value.Path));
        private static bool ValidSession(string value) => !string.IsNullOrWhiteSpace(value) && value.Length <= 200 && !value.Any(char.IsControl);
        private static bool Hash(string value) => value != null && value.Length == 64 && value.All(c => c >= '0' && c <= '9' || c >= 'a' && c <= 'f');
        private static bool Absolute(string value) => value.Length <= 2000 && !value.Any(char.IsControl) && System.IO.Path.IsPathRooted(value);
        internal static bool IsComplete(JsonElement value, string expectedPath)
        {
            var before = value.GetProperty("before"); var after = value.GetProperty("after");
            var b = new OperatorNativeSaveDocumentIdentity(before.GetProperty("session_id").GetString()!, before.GetProperty("project_fingerprint").GetString()!, before.GetProperty("path").GetString()!);
            var a = new OperatorNativeSaveDocumentIdentity(after.GetProperty("session_id").GetString()!, after.GetProperty("project_fingerprint").GetString()!, after.GetProperty("path").GetString()!);
            return value.GetProperty("native_save_returned").ValueKind == JsonValueKind.True && ValidIdentity(b) && ValidIdentity(a)
                && value.GetProperty("same_document").ValueKind == JsonValueKind.True && SamePath(a.Path, expectedPath)
                && value.GetProperty("document_session_changed").GetBoolean() == (b.SessionId != a.SessionId)
                && value.GetProperty("document_path_changed").GetBoolean() == !SamePath(b.Path, a.Path)
                && value.GetProperty("project_binding_changed").GetBoolean() == (b.ProjectFingerprint != a.ProjectFingerprint);
        }
    }

    public sealed class OperatorNativeSaveAsResult
    {
        public string Status { get; internal set; } = "SaveFailed";
        public bool Ok { get; internal set; }
        public string? Error { get; internal set; }
        public OperatorNativeArtifactReceipt Receipt { get; internal set; } = null!;
    }

    /// <summary>Save As owns file/document effects outside a Revit transaction. Never manufacture a commit or rollback.</summary>
    public static class OperatorNativeSaveAsExecution
    {
        public static OperatorNativeSaveAsResult Execute(string path, bool preview, bool overwrite,
            Func<OperatorNativeSaveDocumentIdentity> readActiveDocument, Action saveAs)
        {
            var ioStarted = false; var returned = false;
            OperatorNativeSaveDocumentIdentity? beforeDocument = null;
            SaveFileSnapshot? beforeFile = null;
            try
            {
                path = System.IO.Path.GetFullPath(path);
                if (preview) return new OperatorNativeSaveAsResult { Status = "Dry Run", Ok = true,
                    Receipt = OperatorNativeArtifactReceipt.Preview(new[] { path }, 1, "/revit/save-as") };
                beforeDocument = readActiveDocument();
                if (!OperatorNativeSavedDocument.ValidIdentity(beforeDocument) || !beforeDocument.IsExpectedDocument) throw new InvalidOperationException("The active document identity is unavailable.");
                if (File.Exists(path) && !overwrite) throw new InvalidOperationException("Target file already exists. Set overwrite=true to replace.");
                beforeFile = SaveFileSnapshot.Read(path);
                // Directory creation itself may have an effect. Every later failure remains unknown.
                ioStarted = true;
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
                saveAs();
                returned = true;
                return Finish(path, beforeDocument, beforeFile, returned, readActiveDocument, null);
            }
            catch (Exception ex)
            {
                if (!ioStarted) return new OperatorNativeSaveAsResult { Status = "Blocked", Error = ex.Message,
                    Receipt = OperatorNativeArtifactReceipt.BlockedSaveAs(preview) };
                return Finish(path, beforeDocument!, beforeFile!, returned, readActiveDocument, ex.Message);
            }
        }

        private static OperatorNativeSaveAsResult Finish(string path, OperatorNativeSaveDocumentIdentity beforeDocument,
            SaveFileSnapshot beforeFile, bool returned, Func<OperatorNativeSaveDocumentIdentity> readActiveDocument, string? error)
        {
            OperatorNativeSaveDocumentIdentity? afterDocument = null;
            try { afterDocument = readActiveDocument(); } catch (Exception ex) { error = error ?? ex.Message; }
            var after = SaveFileSnapshot.Read(path);
            var file = new OperatorNativeArtifactFile { Path = path, Exists = after.Exists, Readable = after.Known && after.Exists,
                SizeBytes = after.Length, Sha256 = after.Hash, StableRead = after.Known && after.Exists,
                FreshOutput = beforeFile.Known && after.Known && after.Exists && after.Length > 0
                    && (!beforeFile.Exists || beforeFile.Hash != after.Hash || beforeFile.Written != after.Written) };
            var document = new OperatorNativeSavedDocument(returned, beforeDocument, afterDocument);
            var complete = error == null && returned && file.FreshOutput && file.StableRead == true
                && afterDocument != null && OperatorNativeSavedDocument.ValidIdentity(afterDocument)
                && document.SameDocument && OperatorNativeSavedDocument.SamePath(afterDocument.Path, path);
            return new OperatorNativeSaveAsResult { Status = complete ? "Success" : "SaveFailed", Ok = complete,
                Error = complete ? null : error ?? "Save As returned, but the fresh file and active document identity could not both be verified.",
                Receipt = new OperatorNativeArtifactReceipt("apply", complete ? "complete" : "unverified", new[] { path }, 1,
                    returned ? new[] { true } : Array.Empty<bool>(), new[] { file }, "/revit/save-as") { SaveDocument = document } };
        }

        internal sealed class SaveFileSnapshot
        {
            internal bool Known; internal bool Exists; internal long Length; internal DateTime Written; internal string Hash = "";
            internal static SaveFileSnapshot Read(string path, Action? duringRead = null)
            {
                try
                {
                    // Revit retains its saved RVT handle. Permit sharing only here, and reject a changing snapshot.
                    using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    var before = new FileInfo(path); var length = before.Length; var written = before.LastWriteTimeUtc;
                    if (stream.Length != length) return new SaveFileSnapshot();
                    duringRead?.Invoke(); // internal seam for an executable concurrent-write boundary test
                    using var sha = SHA256.Create();
                    var hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                    var after = new FileInfo(path);
                    if (!after.Exists || after.Length != length || stream.Length != length || after.LastWriteTimeUtc != written)
                        return new SaveFileSnapshot();
                    return new SaveFileSnapshot { Known = true, Exists = true, Length = length, Written = written, Hash = hash };
                }
                catch (FileNotFoundException) { return new SaveFileSnapshot { Known = true }; }
                catch (DirectoryNotFoundException) { return new SaveFileSnapshot { Known = true }; }
                catch (IOException) { return new SaveFileSnapshot(); }
                catch (UnauthorizedAccessException) { return new SaveFileSnapshot(); }
            }
        }
    }
}

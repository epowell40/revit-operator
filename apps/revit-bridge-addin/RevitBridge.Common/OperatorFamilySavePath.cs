using System;
using System.IO;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Read-only Save As path validation, before queue admission and again at execution.</summary>
    public static class OperatorFamilySavePath
    {
        public static string? Resolve(string workspaceRoot, string? requestedPath)
        {
            // Omission retains the existing Save behavior; only an explicit path requests Save As.
            if (string.IsNullOrWhiteSpace(requestedPath)) return null;
            var path = requestedPath!.Trim();
            var root = Path.GetFullPath(workspaceRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var pathRoot = Path.GetPathRoot(path);
            if (Path.IsPathRooted(path) && (string.IsNullOrEmpty(pathRoot) || pathRoot.Length < 3))
                throw new ArgumentException("save-family-doc.filePath must be workspace-relative or fully absolute; drive-relative paths are not supported.");
            var resolved = Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(root, path));
            if (!resolved.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("No family was saved. save-family-doc.filePath must be under the Operator workspace. Use a distinct new relative path such as artifacts/families/Equipment_Tag_Underlined.rfa with overwrite:false; do not use a Documents or Exports path outside the workspace.");
            if (!string.Equals(Path.GetExtension(resolved), ".rfa", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("save-family-doc.filePath must end in .rfa. Use a distinct new workspace RFA for scoped family changes.");
            var relative = resolved.Substring(root.Length + 1);
            foreach (var segment in relative.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
                if (segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                    throw new ArgumentException("save-family-doc.filePath contains invalid filename characters.");
            return resolved;
        }

        public static bool TryValidateRequest(string workspaceRoot, JsonElement body, out string? error)
        {
            error = null;
            try
            {
                if (body.ValueKind != JsonValueKind.Object) throw new ArgumentException("save-family-doc body must be an object.");
                string? path = null;
                if (body.TryGetProperty("filePath", out var value) && value.ValueKind != JsonValueKind.Null)
                {
                    if (value.ValueKind != JsonValueKind.String) throw new ArgumentException("save-family-doc.filePath must be a string.");
                    path = value.GetString();
                    if (path != null && path.Length > 1024) throw new ArgumentException("save-family-doc.filePath is too long.");
                }
                Resolve(workspaceRoot, path);
                return true;
            }
            catch (Exception ex) when (ex is ArgumentException || ex is NotSupportedException || ex is IOException || ex is UnauthorizedAccessException)
            {
                error = ex.Message;
                return false;
            }
        }
    }
}

using System;
using System.IO;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Read-only workbook destination validation shared by admission and execution.</summary>
    public static class OperatorWorkbookExportPath
    {
        public static string Resolve(string workspaceRoot, string? outputFolder, string? requestedName)
        {
            var name = string.IsNullOrWhiteSpace(requestedName) ? "elements_" + Guid.NewGuid().ToString("N") + ".xlsx" : requestedName!.Trim();
            if (!name.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase)) name += ".xlsx";
            if (name != Path.GetFileName(name) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name.Length > 180)
                throw new ArgumentException("fileName must be a simple workbook name without directories or invalid characters.");
            var root = Path.GetFullPath(workspaceRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var folder = string.IsNullOrWhiteSpace(outputFolder) ? Path.Combine("artifacts", "xlsx") : outputFolder!.Trim();
            var full = Path.GetFullPath(Path.Combine(Path.IsPathRooted(folder) ? folder : Path.Combine(root, folder), name));
            if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("No workbook was written. outputFolder must be under the Operator workspace. Omit outputFolder to use artifacts/xlsx, or supply a relative folder beneath the workspace.");
            if (File.Exists(full) || Directory.Exists(full))
                throw new IOException("The workbook destination already exists. Choose a new file name; existing files are never overwritten.");
            return full;
        }

        public static bool TryValidateRequest(string workspaceRoot, JsonElement body, out string? error)
        {
            error = null;
            try
            {
                Resolve(workspaceRoot, OptionalString(body, "outputFolder"), OptionalString(body, "fileName"));
                return true;
            }
            catch (Exception ex) when (ex is ArgumentException || ex is UnauthorizedAccessException || ex is IOException || ex is NotSupportedException)
            {
                error = ex.Message;
                return false;
            }
        }

        private static string? OptionalString(JsonElement body, string name)
        {
            if (!body.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return null;
            if (value.ValueKind != JsonValueKind.String) throw new ArgumentException(name + " must be a string.");
            return value.GetString();
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Exclusive loaded-source or workspace-file selection for the existing read-only inspector.</summary>
    public static class FamilyInspectionSource
    {
        public static bool Validate(JsonElement body, out string error)
        {
            error = "inspect-family-content requires exactly one positive elementId or nonempty workspace .rfa filePath.";
            if (body.ValueKind != JsonValueKind.Object) return false;
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in body.EnumerateObject())
                if (!keys.Add(property.Name) || !new[] { "elementId", "filePath", "contains", "maxElements", "includeParameters", "includeOtherElements" }.Contains(property.Name)) return false;
            var hasId = body.TryGetProperty("elementId", out var id);
            var hasFile = body.TryGetProperty("filePath", out var file);
            if (hasId == hasFile) return false;
            if (hasId && (id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var value) || value <= 0)) return false;
            if (hasFile && (file.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(file.GetString())
                || file.GetString()!.Length > 520 || file.GetString()!.Any(char.IsControl)
                || !file.GetString()!.Trim().EndsWith(".rfa", StringComparison.OrdinalIgnoreCase))) return false;
            error = "";
            return true;
        }

        public static object Schema() => new Dictionary<string, object>
        {
            ["type"] = "object", ["additionalProperties"] = false,
            ["properties"] = new Dictionary<string, object>
            {
                ["elementId"] = new { type = "integer", minimum = 1 },
                ["filePath"] = new { type = "string", minLength = 1, maxLength = 520 },
                ["contains"] = new { type = "string", maxLength = 200 },
                ["maxElements"] = new { type = "integer" },
                ["includeParameters"] = new { type = "boolean" },
                ["includeOtherElements"] = new { type = "boolean" }
            },
            ["oneOf"] = new object[] { new { required = new[] { "elementId" } }, new { required = new[] { "filePath" } } }
        };

        public static string ResolveExisting(string workspaceRoot, string requestedPath)
        {
            if (string.IsNullOrWhiteSpace(requestedPath) || requestedPath.Length > 520)
                throw new ArgumentException("A bounded workspace RFA path is required.");
            var root = Path.GetFullPath(workspaceRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var input = requestedPath.Trim();
            if (input.StartsWith(@"\\", StringComparison.Ordinal) || input.IndexOf(':') >= 0
                && !(input.Length >= 3 && char.IsLetter(input[0]) && input[1] == ':' && (input[2] == '\\' || input[2] == '/')))
                throw new ArgumentException("Inspection requires a local workspace path, not a network, device or drive-relative path.");
            var full = WorkspacePaths.ResolveFileUnderWorkspaceReadOnly(input, root);
            if (!string.Equals(Path.GetExtension(full), ".rfa", StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("Family inspection source must be an RFA under the Operator workspace.");
            if (!File.Exists(full)) throw new FileNotFoundException("Family inspection source not found.", full);
            for (string? current = full; current != null; current = Path.GetDirectoryName(current))
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new UnauthorizedAccessException("Family inspection source cannot traverse a reparse point.");
                if (string.Equals(current.TrimEnd(Path.DirectorySeparatorChar), root, StringComparison.OrdinalIgnoreCase)) break;
            }
            if (new FileInfo(full).Length > 64L * 1024 * 1024) throw new ArgumentException("Family inspection source exceeds 64 MiB.");
            return full;
        }
    }
}

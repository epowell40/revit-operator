using System;
using System.IO;

namespace RevitBridge.Common
{
    public static class WorkspacePaths
    {
        public static string GetWorkspaceRoot()
        {
            var baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var root = Path.Combine(baseDir, "RevitOperator", "Workspace");
            Directory.CreateDirectory(root);
            return root;
        }

        public static string EnsureDir(params string[] relativeSegments)
        {
            var root = GetWorkspaceRoot();
            var full = Path.Combine(root, Path.Combine(relativeSegments ?? Array.Empty<string>()));
            full = Path.GetFullPath(full);
            EnsureUnderWorkspace(full);
            Directory.CreateDirectory(full);
            return full;
        }

        public static string ResolveDirectoryUnderWorkspace(string? userProvidedDir, params string[] defaultRelativeSegments)
        {
            var root = GetWorkspaceRoot();
            var candidate = string.IsNullOrWhiteSpace(userProvidedDir) ? Path.Combine(root, Path.Combine(defaultRelativeSegments)) : userProvidedDir.Trim();
            if (!Path.IsPathRooted(candidate))
                candidate = Path.Combine(root, candidate);

            candidate = Path.GetFullPath(candidate);
            EnsureUnderWorkspace(candidate);
            Directory.CreateDirectory(candidate);
            return candidate;
        }

        public static string ResolveFileUnderWorkspace(string userProvidedFilePath)
        {
            if (string.IsNullOrWhiteSpace(userProvidedFilePath))
                throw new ArgumentException("File path is required.");

            var root = GetWorkspaceRoot();
            var candidate = userProvidedFilePath.Trim();
            if (!Path.IsPathRooted(candidate))
                candidate = Path.Combine(root, candidate);

            candidate = Path.GetFullPath(candidate);
            EnsureUnderWorkspace(candidate);
            return candidate;
        }

        public static string ResolveExistingFileUnderWorkspace(string userProvidedFilePath)
        {
            var full = ResolveFileUnderWorkspace(userProvidedFilePath);
            if (!File.Exists(full)) throw new FileNotFoundException($"File not found in workspace: {full}");
            return full;
        }

        private static void EnsureUnderWorkspace(string fullPath)
        {
            var root = Path.GetFullPath(GetWorkspaceRoot())
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var prefix = root + Path.DirectorySeparatorChar;

            var p = Path.GetFullPath(fullPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.Equals(p, root, StringComparison.OrdinalIgnoreCase)) return;
            if (!p.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException($"Path must be under workspace root: {root}");
        }
    }
}


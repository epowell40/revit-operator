using System;
using System.IO;
using System.Linq;

namespace RevitBridge.Common
{
    public static class OperatorSecurity
    {
        private static readonly object _lock = new object();
        private static string? _cachedOperatorToken;

        public static string GetOrCreateOperatorToken()
        {
            lock (_lock)
            {
                if (!string.IsNullOrWhiteSpace(_cachedOperatorToken)) return _cachedOperatorToken!;

                var existing = Environment.GetEnvironmentVariable("OPERATOR_TOKEN");
                if (!string.IsNullOrWhiteSpace(existing))
                {
                    _cachedOperatorToken = existing.Trim();
                    TryPersistTokenFile(_cachedOperatorToken);
                    return _cachedOperatorToken!;
                }

                var cfg = OperatorClientConfig.Load();
                if (!string.IsNullOrWhiteSpace(cfg.operator_token))
                {
                    _cachedOperatorToken = cfg.operator_token.Trim();
                    Environment.SetEnvironmentVariable("OPERATOR_TOKEN", _cachedOperatorToken);
                    TryPersistTokenFile(_cachedOperatorToken);
                    return _cachedOperatorToken!;
                }

                var fromFile = TryReadTokenFile();
                if (!string.IsNullOrWhiteSpace(fromFile))
                {
                    _cachedOperatorToken = fromFile.Trim();
                    Environment.SetEnvironmentVariable("OPERATOR_TOKEN", _cachedOperatorToken);
                    TryPersistTokenFile(_cachedOperatorToken);
                    return _cachedOperatorToken!;
                }

                var token = Guid.NewGuid().ToString("N");
                Environment.SetEnvironmentVariable("OPERATOR_TOKEN", token); // process-level
                _cachedOperatorToken = token;
                TryPersistTokenFile(token);
                return token;
            }
        }

        public static string GetOperatorToken()
        {
            var existing = Environment.GetEnvironmentVariable("OPERATOR_TOKEN");
            return string.IsNullOrWhiteSpace(existing) ? "" : existing.Trim();
        }

        public static string GetDevAgentToken()
        {
            var token = Environment.GetEnvironmentVariable("OPERATOR_DEV_AGENT_TOKEN");
            return string.IsNullOrWhiteSpace(token) ? "" : token.Trim();
        }

        public static bool TokenMatches(string? provided)
        {
            var expected = GetOrCreateOperatorToken();
            if (string.IsNullOrWhiteSpace(provided)) return false;
            return string.Equals(provided.Trim(), expected, StringComparison.Ordinal);
        }

        public static string[] GetAllowedExternalRoots()
        {
            // Comma/semicolon-separated list of safe roots for external referencing/linking (e.g. network drives).
            // Example:
            //   OPERATOR_ALLOWED_EXTERNAL_ROOTS=\\\\server\\share\\projects,P:\\
            var raw = Environment.GetEnvironmentVariable("OPERATOR_ALLOWED_EXTERNAL_ROOTS") ?? "";
            var parts = raw
                .Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(p => (p ?? "").Trim().Trim('"'))
                .Where(p => !string.IsNullOrWhiteSpace(p))
                .ToArray();

            var outList = new System.Collections.Generic.List<string>();
            foreach (var p in parts)
            {
                try
                {
                    if (!Path.IsPathRooted(p)) continue;
                    var full = Path.GetFullPath(p).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                    if (!string.IsNullOrWhiteSpace(full)) outList.Add(full);
                }
                catch
                {
                    // ignore malformed root
                }
            }
            return outList.ToArray();
        }

        public static bool IsUnderAllowedExternalRoot(string fullPath)
        {
            if (string.IsNullOrWhiteSpace(fullPath)) return false;
            var p = Path.GetFullPath(fullPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.IsNullOrWhiteSpace(p)) return false;

            var roots = GetAllowedExternalRoots();
            foreach (var r in roots)
            {
                try
                {
                    var root = Path.GetFullPath(r).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                    if (string.Equals(p, root, StringComparison.OrdinalIgnoreCase)) return true;
                    var prefix = root + Path.DirectorySeparatorChar;
                    if (p.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
                }
                catch
                {
                    // ignore per root
                }
            }
            return false;
        }

        public static string ResolveExistingExternalFileUnderAllowedRoots(string userProvidedPath)
        {
            if (string.IsNullOrWhiteSpace(userProvidedPath))
                throw new ArgumentException("External path is required.");

            var p = userProvidedPath.Trim().Trim('"');
            if (!Path.IsPathRooted(p))
                throw new UnauthorizedAccessException("External paths must be absolute.");

            var full = Path.GetFullPath(p);
            if (!File.Exists(full))
                throw new FileNotFoundException($"External file not found: {full}");

            if (!IsUnderAllowedExternalRoot(full))
            {
                var roots = GetAllowedExternalRoots();
                var hint = roots.Length > 0 ? string.Join(", ", roots) : "(none configured)";
                throw new UnauthorizedAccessException($"External path is not under OPERATOR_ALLOWED_EXTERNAL_ROOTS. Configured roots: {hint}");
            }

            return full;
        }

        private static string GetTokenFilePath()
        {
            try
            {
                var root = WorkspacePaths.GetWorkspaceRoot();
                return Path.Combine(root, "operator_token.txt");
            }
            catch
            {
                var baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                return Path.Combine(baseDir, "RevitOperator", "Workspace", "operator_token.txt");
            }
        }

        private static string? TryReadTokenFile()
        {
            try
            {
                var p = GetTokenFilePath();
                if (!File.Exists(p)) return null;
                var raw = File.ReadAllText(p) ?? "";
                var token = raw.Trim();
                return string.IsNullOrWhiteSpace(token) ? null : token;
            }
            catch
            {
                return null;
            }
        }

        private static void TryPersistTokenFile(string token)
        {
            try
            {
                var p = GetTokenFilePath();
                var dir = Path.GetDirectoryName(p);
                if (!string.IsNullOrWhiteSpace(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(p, token ?? "");
            }
            catch
            {
                // ignore
            }
        }
    }
}

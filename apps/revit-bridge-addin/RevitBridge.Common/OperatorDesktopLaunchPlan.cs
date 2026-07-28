using System;
using System.Collections.Generic;
using System.IO;

namespace RevitBridge.Common
{
    public static class OperatorDesktopLaunchPlan
    {
        public const string DefaultUrl = "http://127.0.0.1:3907/";
        public const string RuntimeIdentityUrl = "http://127.0.0.1:3907/api/runtime-identity";

        public static string GetAssemblyDirectory(string? assemblyLocation)
        {
            if (string.IsNullOrWhiteSpace(assemblyLocation)) return "";
            var normalized = assemblyLocation!.Trim().Trim('"');
            return Path.GetDirectoryName(normalized) ?? "";
        }

        public static IReadOnlyList<string> BuildCandidatePaths(
            string? configuredLauncherPath,
            string localAppData,
            string desktopDirectory,
            string startDirectory,
            int maxAncestorDepth = 10)
        {
            var candidates = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            Add(candidates, seen, configuredLauncherPath);
            Add(candidates, seen, Combine(localAppData, "RevitOperator", "Operator Desktop.cmd"));
            Add(candidates, seen, Combine(desktopDirectory, "Operator Desktop.cmd"));
            Add(candidates, seen, Combine(desktopDirectory, "Operator Desktop.lnk"));

            var current = string.IsNullOrWhiteSpace(startDirectory)
                ? null
                : new DirectoryInfo(startDirectory);
            for (var depth = 0; current != null && depth <= Math.Max(0, maxAncestorDepth); depth++)
            {
                Add(candidates, seen, Combine(
                    current.FullName,
                    "operator-desktop",
                    "scripts",
                    "launch_operator_desktop.cmd"));
                current = current.Parent;
            }

            return candidates;
        }

        public static string? ResolveExistingLauncher(
            IEnumerable<string> candidates,
            Func<string, bool>? fileExists = null)
        {
            var exists = fileExists ?? File.Exists;
            foreach (var candidate in candidates)
            {
                if (!string.IsNullOrWhiteSpace(candidate) && exists(candidate))
                {
                    return candidate;
                }
            }

            return null;
        }

        private static string Combine(params string[] parts)
        {
            foreach (var part in parts)
            {
                if (string.IsNullOrWhiteSpace(part)) return "";
            }

            return Path.Combine(parts);
        }

        private static void Add(List<string> candidates, HashSet<string> seen, string? candidate)
        {
            var normalized = (candidate ?? "").Trim().Trim('"');
            if (normalized.Length == 0 || !seen.Add(normalized)) return;
            candidates.Add(normalized);
        }
    }
}

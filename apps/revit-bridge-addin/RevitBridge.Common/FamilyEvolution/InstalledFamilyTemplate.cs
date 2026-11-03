using System;
using System.IO;
using System.Linq;

namespace RevitBridge.Common.FamilyEvolution
{
    public static class InstalledFamilyTemplate
    {
        // Read-only selection under Revit's configured template root. Not an
        // alternate general file-access root or an output destination.
        public static string Resolve(string configuredRoot, string name)
        {
            if (string.IsNullOrWhiteSpace(configuredRoot) || !Directory.Exists(configuredRoot))
                throw new ArgumentException("Revit has no available configured family-template directory.");
            // Resolve a logical empty-model selection within the configured root
            // only. Do not guess a different language directory or an external root.
            if (name == "generic-model")
            {
                var candidates = new[] { "Generic Model.rft", "Metric Generic Model.rft" }
                    .Where(n => File.Exists(Path.Combine(configuredRoot, n))).ToArray();
                if (candidates.Length != 1)
                    throw new ArgumentException("Configured template directory must contain exactly one Generic Model.rft or Metric Generic Model.rft; select an exact installed filename otherwise.");
                name = candidates[0];
            }
            if (string.IsNullOrWhiteSpace(name) || name != Path.GetFileName(name) || name.Contains(":")
                || name.Contains("/") || name.Contains("\\") || !name.EndsWith(".rft", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Installed template selection must be a single .rft filename.");
            var path = Path.GetFullPath(Path.Combine(Path.GetFullPath(configuredRoot), name));
            if (!File.Exists(path)) throw new FileNotFoundException("Installed family template not found in Revit's configured template directory: " + name);
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Installed template must be an ordinary template file.");
            return path;
        }
    }
}

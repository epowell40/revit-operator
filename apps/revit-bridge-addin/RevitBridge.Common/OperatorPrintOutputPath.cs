using System;
using System.IO;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    public static class OperatorPrintOutputPath
    {
        public static string Resolve(string? requestedFile, string? outputFolder, string fallbackName, Func<string?, string> resolveAllowedFolder)
        {
            var candidate = (requestedFile ?? "").Trim();
            if (Regex.IsMatch(candidate, @"^[A-Za-z]:[^\\/]") || Regex.IsMatch(candidate, @"^[A-Za-z]:$"))
                throw new ArgumentException("Print output requires an absolute or workspace-relative path, not a drive-relative path.");
            var name = candidate.Length > 0 ? Path.GetFileName(candidate) : fallbackName;
            if (string.IsNullOrWhiteSpace(name) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name == "." || name == "..")
                throw new ArgumentException("Print output file name is invalid.");
            if (string.IsNullOrEmpty(Path.GetExtension(name))) name += ".pdf";
            var parent = candidate.Length > 0 ? Path.GetDirectoryName(candidate) : null;
            var folder = resolveAllowedFolder(string.IsNullOrWhiteSpace(parent) ? outputFolder : parent);
            if (!Path.IsPathRooted(folder)) throw new ArgumentException("Print output folder resolver did not return an absolute path.");
            return Path.GetFullPath(Path.Combine(folder, name));
        }
    }
}

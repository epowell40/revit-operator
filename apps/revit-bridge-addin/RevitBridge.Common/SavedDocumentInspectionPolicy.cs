using System;
using System.IO;

namespace RevitBridge.Common
{
    /// <summary>Saved-model inspection is limited to the actual active native document.</summary>
    public static class SavedDocumentInspectionPolicy
    {
        public static string Resolve(string requested, string activePath, bool familyDocument)
        {
            if (string.IsNullOrWhiteSpace(requested) || string.IsNullOrWhiteSpace(activePath)
                || requested.Length > 2000 || activePath.Length > 2000
                || !Path.IsPathRooted(requested) || !Path.IsPathRooted(activePath))
                throw new ArgumentException("Saved-model inspection requires the exact absolute active document path.");
            var full = Path.GetFullPath(requested);
            var expected = Path.GetFullPath(activePath);
            if (!string.Equals(full.Replace('\\', '/'), expected.Replace('\\', '/'), StringComparison.OrdinalIgnoreCase)
                || !string.Equals(Path.GetExtension(full), familyDocument ? ".rfa" : ".rvt", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Only the exact currently open saved Revit document may be inspected.");
            return full;
        }
    }
}

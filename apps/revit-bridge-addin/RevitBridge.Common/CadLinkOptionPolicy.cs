using System;
using System.IO;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    /// <summary>Requested CAD semantics are never replaced by a different effect.</summary>
    public static class CadLinkOptionPolicy
    {
        public static void RequireExpectedSourceHash(string? expected, string actual)
        {
            if (expected == null) return;
            if (!Regex.IsMatch(expected, "^[a-f0-9]{64}$") || !string.Equals(expected, actual, StringComparison.Ordinal))
                throw new ArgumentException("CAD source bytes differ from expectedSourceSha256; no native import/link was started.", nameof(expected));
        }

        public static string SourceFormat(string path)
        {
            var extension = Path.GetExtension(path ?? "").ToLowerInvariant();
            if (extension != ".dwg" && extension != ".dxf")
                throw new ArgumentException("link-cad supports only .dwg and .dxf files.", nameof(path));
            return extension.Substring(1);
        }

        public static bool ShouldCreateDraftingView(bool hasExistingView, bool directSheetImport,
            bool hasSheet, string? requestedViewName, bool? createDraftingView)
            => !hasExistingView && !directSheetImport && createDraftingView != false
                && (hasSheet || !string.IsNullOrWhiteSpace(requestedViewName));

        public static string ResolveColorMode(string? raw)
        {
            var key = (raw ?? "").Trim().ToLowerInvariant().Replace("-", "_").Replace(" ", "_");
            switch (key)
            {
                case "": case "preserve": case "preserved": case "preserve_colors": case "color": return "Preserved";
                case "black_and_white": case "blackandwhite": case "monochrome": return "BlackAndWhite";
                case "invert": case "inverted": case "invert_colors": return "Inverted";
                default: throw new ArgumentException("colorMode must be preserve, black_and_white, or invert.", nameof(raw));
            }
        }

        public static T ExecuteRequestedMode<T>(bool wantLink, Func<T> link, Func<T> import, Func<T, bool> isLinked)
        {
            if (link == null || import == null || isLinked == null) throw new ArgumentNullException();
            // A failed link is a failure, never permission to embed an import.
            var result = wantLink ? link() : import();
            if (isLinked(result) != wantLink)
                throw new InvalidOperationException("Native CAD result does not match the requested link/import mode.");
            return result;
        }
    }
}

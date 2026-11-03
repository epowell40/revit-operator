using System;
using System.Linq;

namespace RevitBridge.Common.Annotation
{
    public static class FamilyLabelInspectionPolicy
    {
        // Revit exposes family labels through public API wrapper types, which
        // do not always have the name displayed by the Family Editor UI.
        public static bool IsLabel(string? runtimeType)
            => string.Equals(runtimeType, "TextElement", StringComparison.Ordinal)
                || runtimeType?.EndsWith("Label", StringComparison.OrdinalIgnoreCase) == true;

        // Search the content kind as well as the native wrapper/name. Revit's
        // generic TextElement wrapper does not itself contain the word label.
        public static bool MatchesQuery(string? query, string? runtimeType, params string[] values)
        {
            if (!IsLabel(runtimeType)) return false;
            var needle = Normalize(query);
            return needle.Length == 0 || values.Concat(new[] { runtimeType ?? "", "family label" })
                .Any(value => Normalize(value).Contains(needle));
        }

        private static string Normalize(string? value)
            => string.Join(" ", new string((value ?? "").Select(character => char.IsLetterOrDigit(character)
                ? char.ToLowerInvariant(character) : ' ').ToArray())
                .Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries));
    }
}

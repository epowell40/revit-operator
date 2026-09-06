using System;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class OperatorDuplicateSheetContract
    {
        public static JsonElement RequestSchema()
        {
            using var stream = typeof(OperatorDuplicateSheetContract).Assembly.GetManifestResourceStream("RevitBridge.Common.duplicate-sheet.request.v1.json")
                ?? throw new InvalidOperationException("Sheet duplication request contract is unavailable.");
            using var document = JsonDocument.Parse(stream);
            return document.RootElement.Clone();
        }

        public static string NormalizeOption(string? value) => (value ?? "views_and_detailing").Trim().ToLowerInvariant().Replace('-', '_').Replace(' ', '_');

        public static string ResolveOptionName(string? value)
        {
            switch (NormalizeOption(value))
            {
                case "empty": return "DuplicateEmptySheet";
                case "detailing": return "DuplicateSheetWithDetailing";
                case "views_only": return "DuplicateSheetWithViewsOnly";
                case "views_and_detailing": return "DuplicateSheetWithViewsAndDetailing";
                case "views_as_dependent": return "DuplicateSheetWithViewsAsDependent";
                default: throw new InvalidOperationException("option must be empty, detailing, views_only, views_and_detailing, or views_as_dependent.");
            }
        }
    }
}

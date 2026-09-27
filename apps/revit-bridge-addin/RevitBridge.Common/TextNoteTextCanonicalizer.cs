using System;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class TextNoteTextCanonicalizer
    {
        public const int MaximumRequestTextLength = 16_384;

        public static void ValidateRequestTextLengths(string? newText, string? expectedOldText)
        {
            if (newText != null && newText.Length > MaximumRequestTextLength)
                throw new ArgumentException("newText is too long.", nameof(newText));
            if (expectedOldText != null && expectedOldText.Length > MaximumRequestTextLength)
                throw new ArgumentException("expectedOldText is too long.", nameof(expectedOldText));
        }

        public static void ValidateReplacementRequestTextLengths(string jsonData)
        {
            if (string.IsNullOrEmpty(jsonData)) return;
            using var document = JsonDocument.Parse(jsonData);
            var body = document.RootElement;
            if (body.ValueKind != JsonValueKind.Object) return;
            // Only bound the two text fields. The handler retains its aliases,
            // null/empty semantics, selectors, confirmation and type validation.
            var newText = body.TryGetProperty("newText", out var next) && next.ValueKind == JsonValueKind.String
                ? next.GetString() : null;
            var expectedOldText = body.TryGetProperty("expectedOldText", out var old) && old.ValueKind == JsonValueKind.String
                ? old.GetString() : null;
            ValidateRequestTextLengths(newText, expectedOldText);
        }

        public static string Normalize(string value)
        {
            // JSON already supports line breaks, but some callers escape them twice.
            var text = value ?? "";
            if (text.IndexOf("\\n", StringComparison.Ordinal) >= 0 ||
                text.IndexOf("\\r", StringComparison.Ordinal) >= 0)
            {
                text = text.Replace("\\r\\n", "\n").Replace("\\n", "\n").Replace("\\r", "\n");
            }

            return text.Replace("\r\n", "\n").Replace('\r', '\n');
        }

        public static bool IsExactRevitRoundTrip(string requested, string actual)
        {
            var requestedNormalized = Normalize(requested);
            var actualNormalized = Normalize(actual);

            // Revit persists a terminal paragraph marker for TextNote.Text. Depending on
            // whether the requested value already ends in a line break, readback contains
            // either the requested canonical text or exactly one additional trailing LF.
            // Do not trim: any other substitution remains a hard failure.
            return string.Equals(actualNormalized, requestedNormalized, StringComparison.Ordinal) ||
                   string.Equals(actualNormalized, requestedNormalized + "\n", StringComparison.Ordinal);
        }
    }
}

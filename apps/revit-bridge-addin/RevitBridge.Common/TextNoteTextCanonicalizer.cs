using System;

namespace RevitBridge.Common
{
    public static class TextNoteTextCanonicalizer
    {
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

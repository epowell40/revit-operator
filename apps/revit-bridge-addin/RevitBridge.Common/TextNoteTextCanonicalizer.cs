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
    }
}

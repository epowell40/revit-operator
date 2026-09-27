using System;
using System.Linq;

namespace RevitBridge.Common
{
    public static class MepConnectorServicePolicy
    {
        public static bool AreCompatible(string? first, string? second)
        {
            var a = Normalize(first);
            var b = Normalize(second);
            return a.Length == 0 || b.Length == 0 || string.Equals(a, b, StringComparison.Ordinal);
        }

        private static string Normalize(string? value)
        {
            var token = new string((value ?? "").Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
            return token == "undefinedsystemtype" || token == "undefined" || token == "none" || token == "unknown"
                ? "" : token;
        }
    }
}

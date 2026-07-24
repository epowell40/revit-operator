using System;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    public static class ElectricalWireSizeProfilePolicy
    {
        public static string Canonicalize(string value)
        {
            return Regex.Replace(value ?? string.Empty, @"\s+", string.Empty).ToUpperInvariant();
        }

        public static bool Matches(string nativeWireSize, string profileToken)
        {
            var native = Canonicalize(nativeWireSize);
            var profile = Canonicalize(profileToken);
            return native.Length > 0 && profile.Length > 0 && string.Equals(native, profile, StringComparison.Ordinal);
        }
    }
}

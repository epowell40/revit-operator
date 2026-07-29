using System;
using System.Globalization;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal static class PortPolicy
    {
        public static bool TryReadOverride(string? raw, out bool hasOverride, out int port)
        {
            hasOverride = false;
            port = 0;
            if (raw == null || raw.Length == 0)
                return true;
            if (!string.Equals(raw, raw.Trim(), StringComparison.Ordinal))
                return false;

            int parsed;
            if (!int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out parsed))
                return false;
            if (parsed < SafeReadContract.MinimumPort || parsed > SafeReadContract.MaximumPort)
                return false;

            hasOverride = true;
            port = parsed;
            return true;
        }

        public static bool IsAllowed(int port)
        {
            return port >= SafeReadContract.MinimumPort && port <= SafeReadContract.MaximumPort;
        }
    }
}

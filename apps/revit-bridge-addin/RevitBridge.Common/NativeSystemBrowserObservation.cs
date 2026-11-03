using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public static class NativeSystemBrowserObservation
    {
        // Called only with native ViewType.SystemBrowser observations. Any
        // enumeration/getter failure propagates to the enclosing incomplete
        // placement state; no empty-success fallback or changed-owner exemption.
        public static object Capture<T>(IEnumerable<T> views, Func<T, object> read)
        {
            var bounded = views.Take(9).ToArray();
            if (bounded.Length > 8) throw new InvalidOperationException("System Browser observation exceeds bound.");
            return new { schema = "operator.native_system_browser_state.v1", complete = true,
                scope = "system_browser_public_state_not_hidden_state", items = bounded.Select(read).ToArray() };
        }
    }
}

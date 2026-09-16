using System;

namespace RevitBridge.Common
{
    public static class OperatorEmbeddedNavigation
    {
        public static bool IsApplication(string? value)
        {
            return !string.IsNullOrWhiteSpace(value)
                && value!.StartsWith(OperatorDesktopLaunchPlan.DefaultUrl, StringComparison.OrdinalIgnoreCase)
                && Uri.TryCreate(value, UriKind.Absolute, out var uri)
                && uri.Scheme == Uri.UriSchemeHttp && uri.Host == "127.0.0.1" && uri.Port == 3907
                && string.IsNullOrEmpty(uri.UserInfo);
        }

        public static bool IsUserReference(string? value, bool userInitiated)
        {
            return userInitiated && Uri.TryCreate(value, UriKind.Absolute, out var uri)
                && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)
                && !uri.IsLoopback && string.IsNullOrEmpty(uri.UserInfo);
        }
    }
}

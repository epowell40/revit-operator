using System;

namespace RevitBridge.Common
{
    public enum OperatorClientAuthMode
    {
        None = 0
    }

    public static class OperatorClientAuthConfig
    {
        public static OperatorClientAuthMode ResolveMode(OperatorClientConfigData? config = null)
        {
            return OperatorClientAuthMode.None;
        }

        public static Uri? ResolveAuthBaseUri(OperatorClientConfigData? config = null)
        {
            var fromEnv = Environment.GetEnvironmentVariable("OPERATOR_AUTH_BASE_URL");
            if (!string.IsNullOrWhiteSpace(fromEnv) && Uri.TryCreate(EnsureTrailingSlash(fromEnv), UriKind.Absolute, out var envUri))
                return envUri;

            return null;
        }

        public static string? ResolveAudience(OperatorClientConfigData? config = null)
        {
            var fromEnv = Environment.GetEnvironmentVariable("OPERATOR_AUTH_AUDIENCE");
            if (!string.IsNullOrWhiteSpace(fromEnv)) return fromEnv.Trim();

            return null;
        }

        public static string? ResolveIssuer(OperatorClientConfigData? config = null)
        {
            var fromEnv = Environment.GetEnvironmentVariable("OPERATOR_AUTH_ISSUER");
            if (!string.IsNullOrWhiteSpace(fromEnv)) return fromEnv.Trim();

            return null;
        }

        public static string ResolveLoginPath(OperatorClientConfigData? config = null)
        {
            var fromEnv = Environment.GetEnvironmentVariable("OPERATOR_AUTH_LOGIN_PATH");
            if (!string.IsNullOrWhiteSpace(fromEnv)) return NormalizeEndpointPath(fromEnv, "auth/login");

            return NormalizeEndpointPath(null, "auth/login");
        }

        public static string ResolveRefreshPath(OperatorClientConfigData? config = null)
        {
            var fromEnv = Environment.GetEnvironmentVariable("OPERATOR_AUTH_REFRESH_PATH");
            if (!string.IsNullOrWhiteSpace(fromEnv)) return NormalizeEndpointPath(fromEnv, "auth/refresh");

            return NormalizeEndpointPath(null, "auth/refresh");
        }

        public static string ResolveOperatorTokenPath(OperatorClientConfigData? config = null)
        {
            var fromEnv = Environment.GetEnvironmentVariable("OPERATOR_AUTH_OPERATOR_TOKEN_PATH");
            if (!string.IsNullOrWhiteSpace(fromEnv)) return NormalizeEndpointPath(fromEnv, "/api/operator/token");

            return NormalizeEndpointPath(null, "/api/operator/token");
        }

        public static bool TryParseMode(string? raw, out OperatorClientAuthMode mode)
        {
            mode = OperatorClientAuthMode.None;
            var v = (raw ?? "").Trim();
            if (v.Length == 0) return false;

            if (string.Equals(v, "none", StringComparison.OrdinalIgnoreCase))
            {
                mode = OperatorClientAuthMode.None;
                return true;
            }

            return false;
        }

        private static string EnsureTrailingSlash(string value)
        {
            var s = (value ?? "").Trim();
            if (s.Length == 0) return s;
            return s.EndsWith("/", StringComparison.Ordinal) ? s : (s + "/");
        }

        private static string NormalizeEndpointPath(string? value, string fallback)
        {
            var s = (value ?? "").Trim();
            if (s.Length == 0) return fallback;
            if (s.StartsWith("./", StringComparison.Ordinal)) s = s.Substring(2);
            return s.Length == 0 ? fallback : s;
        }
    }
}

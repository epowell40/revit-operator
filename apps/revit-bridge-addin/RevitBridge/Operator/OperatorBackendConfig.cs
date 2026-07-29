using System;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal static class OperatorBackendConfig
    {
        public static Uri GetBaseUri()
        {
            var url = Environment.GetEnvironmentVariable("OPERATOR_BACKEND_URL");
            if (!string.IsNullOrWhiteSpace(url))
            {
                return OperatorNativeToolExposureBackendUriPolicy.RequireValidOrigin(url);
            }

            var cfg = OperatorClientConfig.Load();
            if (!string.IsNullOrWhiteSpace(cfg.backend_url))
            {
                return OperatorNativeToolExposureBackendUriPolicy.RequireValidOrigin(cfg.backend_url!);
            }

            var portRaw = Environment.GetEnvironmentVariable("OPERATOR_BACKEND_PORT");
            var port = 7007;
            if (!string.IsNullOrWhiteSpace(portRaw) && int.TryParse(portRaw, out var p) && p > 0 && p < 65536)
            {
                port = p;
            }

            return OperatorNativeToolExposureBackendUriPolicy.RequireValidOrigin($"http://127.0.0.1:{port}/");
        }
    }
}

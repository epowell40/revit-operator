using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal static class OperatorBackendHealth
    {
        public static async Task<bool> IsHealthyAsync(Uri baseUri, int timeoutMs = 750, CancellationToken cancellationToken = default)
        {
            if (baseUri == null) return false;
            if (!string.Equals(baseUri.Scheme, "http", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(baseUri.Scheme, "https", StringComparison.OrdinalIgnoreCase))
                return false;

            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                cts.CancelAfter(Math.Max(250, timeoutMs));
                using var http = new HttpClient
                {
                    BaseAddress = baseUri,
                    Timeout = TimeSpan.FromMilliseconds(Math.Max(250, timeoutMs))
                };

                using var req = new HttpRequestMessage(HttpMethod.Get, "health");
                ApplyAuthHeaders(req);

                using var resp = await http.SendAsync(req, cts.Token).ConfigureAwait(false);

                // Health probe is liveness-oriented. 401/403 still means backend process is up.
                if (resp.StatusCode == HttpStatusCode.Unauthorized || resp.StatusCode == HttpStatusCode.Forbidden)
                    return true;

                var code = (int)resp.StatusCode;
                return code >= 200 && code < 500;
            }
            catch
            {
                return false;
            }
        }

        public static async Task<bool> IsHealthyWithRetriesAsync(
            Uri baseUri,
            int attempts = 3,
            int timeoutMs = 1200,
            int delayMs = 300,
            CancellationToken cancellationToken = default)
        {
            var maxAttempts = Math.Max(1, attempts);
            var baseDelayMs = Math.Max(50, delayMs);

            for (var attempt = 1; attempt <= maxAttempts; attempt++)
            {
                if (await IsHealthyAsync(baseUri, timeoutMs, cancellationToken).ConfigureAwait(false))
                    return true;

                if (attempt >= maxAttempts) break;
                try
                {
                    await Task.Delay(baseDelayMs * attempt, cancellationToken).ConfigureAwait(false);
                }
                catch
                {
                    return false;
                }
            }

            return false;
        }

        private static void ApplyAuthHeaders(HttpRequestMessage request)
        {
            try
            {
                var token = OperatorSecurity.GetOrCreateOperatorToken();
                request.Headers.TryAddWithoutValidation("X-Operator-Token", token);

                var devToken = OperatorSecurity.GetDevAgentToken();
                if (!string.IsNullOrWhiteSpace(devToken))
                    request.Headers.TryAddWithoutValidation("X-Operator-Dev-Agent-Token", devToken);
            }
            catch
            {
                // ignore; liveness probe can still run without headers
            }
        }
    }
}

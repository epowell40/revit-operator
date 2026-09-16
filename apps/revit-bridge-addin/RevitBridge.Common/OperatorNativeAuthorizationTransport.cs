using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace RevitBridge.Common
{
    // Authorizing exact request bytes does not dispatch a Revit operation.
    // A service restart can break a pooled HTTP connection; reconnect once
    // within the caller's existing deadline. Never retry a received decision.
    public static class OperatorNativeAuthorizationTransport
    {
        public static async Task<HttpResponseMessage> SendAsync(
            Func<Task<HttpResponseMessage>> authorize,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return await authorize().ConfigureAwait(false);
            }
            catch (HttpRequestException) when (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(250, cancellationToken).ConfigureAwait(false);
                return await authorize().ConfigureAwait(false);
            }
        }
    }
}

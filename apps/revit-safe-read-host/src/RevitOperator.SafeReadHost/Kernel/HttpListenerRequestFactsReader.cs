using System;
using System.Collections.Specialized;
using System.Net;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal static class HttpListenerRequestFactsReader
    {
        public static async Task<CertifiedRequestFacts> ReadAsync(HttpListenerRequest request)
        {
            if (request == null)
                throw new ArgumentNullException(nameof(request));
            CertifiedRequestFacts facts = new CertifiedRequestFacts();
            facts.Method = request.HttpMethod ?? string.Empty;
            facts.RawTarget = request.RawUrl ?? string.Empty;
            IPEndPoint? remote = request.RemoteEndPoint;
            facts.RemoteEndpointIsIpv4Loopback = remote != null &&
                                                 remote.Address.AddressFamily == AddressFamily.InterNetwork &&
                                                 IPAddress.IsLoopback(remote.Address);
            string? transferEncoding = request.Headers["Transfer-Encoding"];
            facts.HasTransferEncoding = !string.IsNullOrEmpty(transferEncoding);
            facts.IsChunked = transferEncoding != null &&
                              transferEncoding.IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0;
            facts.HasContentEncoding = !string.IsNullOrEmpty(request.Headers["Content-Encoding"]);
            facts.ContentLength = request.ContentLength64;
            facts.ContentType = request.ContentType ?? string.Empty;
            facts.StartupToken = ReadSingleHeader(request.Headers, SafeReadContract.StartupTokenHeader, facts);
            facts.HostInstanceId = ReadSingleHeader(request.Headers, SafeReadContract.HostInstanceHeader, facts);
            facts.DocumentSessionId = ReadSingleHeader(request.Headers, SafeReadContract.DocumentSessionHeader, facts);
            facts.ClientSessionId = ReadSingleHeader(request.Headers, SafeReadContract.ClientSessionHeader, facts);
            facts.RequestId = ReadSingleHeader(request.Headers, SafeReadContract.RequestIdHeader, facts);
            facts.AttemptId = ReadSingleHeader(request.Headers, SafeReadContract.AttemptIdHeader, facts);
            facts.CapabilityNonce = ReadSingleHeader(request.Headers, SafeReadContract.CapabilityNonceHeader, facts);
            string?[]? names = request.Headers.AllKeys;
            if (names != null)
            {
                for (int index = 0; index < names.Length; index++)
                {
                    string? name = names[index];
                    if (name != null && name.StartsWith(SafeReadContract.SafeReadHeaderPrefix, StringComparison.OrdinalIgnoreCase) &&
                        !SafeReadContract.IsRequiredHeader(name))
                        facts.HasUnknownSafeReadHeader = true;
                }
            }

            if (facts.ContentLength == SafeReadContract.RequestByteCount)
            {
                byte[] body = new byte[SafeReadContract.RequestByteCount];
                int offset = 0;
                try
                {
                    while (offset < body.Length)
                    {
                        int read = await request.InputStream.ReadAsync(body, offset, body.Length - offset).ConfigureAwait(false);
                        if (read <= 0)
                            break;
                        offset += read;
                    }
                }
                catch
                {
                    offset = 0;
                }
                if (offset == body.Length)
                    facts.Body = body;
            }
            return facts;
        }

        private static string ReadSingleHeader(
            NameValueCollection headers,
            string name,
            CertifiedRequestFacts facts)
        {
            string[]? values = headers.GetValues(name);
            if (values == null || values.Length != 1)
            {
                if (values != null && values.Length > 1)
                    facts.HasDuplicateRequiredHeader = true;
                return string.Empty;
            }
            return values[0] ?? string.Empty;
        }
    }
}

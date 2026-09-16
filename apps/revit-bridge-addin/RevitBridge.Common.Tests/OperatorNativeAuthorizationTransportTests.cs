using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeAuthorizationTransportTests
    {
        [Fact]
        public async Task BrokenAuthorizationConnectionReconnectsWithIdenticalRequestBytes()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var bodies = new List<string>();
            var server = Task.Run(async () =>
            {
                for (var index = 0; index < 2; index++)
                {
                    using var client = await listener.AcceptTcpClientAsync();
                    using var stream = client.GetStream();
                    using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                    var length = 0;
                    string? line;
                    while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync()))
                        if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                            length = int.Parse(line.Substring("Content-Length:".Length).Trim());
                    var buffer = new char[length];
                    var offset = 0;
                    while (offset < length)
                    {
                        var count = await reader.ReadAsync(buffer, offset, length - offset);
                        if (count == 0) throw new EndOfStreamException();
                        offset += count;
                    }
                    bodies.Add(new string(buffer));
                    if (index == 0)
                    {
                        client.Client.LingerState = new LingerOption(true, 0);
                        continue;
                    }
                    var response = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
                    await stream.WriteAsync(response, 0, response.Length);
                }
            });
            try
            {
                using var http = new HttpClient(new HttpClientHandler { UseProxy = false });
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                var origin = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
                const string body = "{\"request_id\":\"same-request\",\"body_json\":\"exact native bytes\"}";
                using var result = await OperatorNativeAuthorizationTransport.SendAsync(async () =>
                {
                    using var request = new HttpRequestMessage(HttpMethod.Post, origin + "/api/revit-direct/authorize-execution")
                    { Content = new StringContent(body, Encoding.UTF8, "application/json") };
                    request.Headers.ExpectContinue = false;
                    return await http.SendAsync(request, deadline.Token);
                }, deadline.Token);
                Assert.Equal(HttpStatusCode.OK, result.StatusCode);
                await server;
                Assert.Equal(new[] { body, body }, bodies);
            }
            finally { listener.Stop(); }
        }

        [Theory]
        [InlineData(401)]
        [InlineData(403)]
        [InlineData(503)]
        public async Task ReceivedAuthorizationDecisionsAreNeverRetried(int status)
        {
            var calls = 0;
            using var result = await OperatorNativeAuthorizationTransport.SendAsync(() =>
            {
                calls++;
                return Task.FromResult(new HttpResponseMessage((HttpStatusCode)status));
            }, CancellationToken.None);
            Assert.Equal(status, (int)result.StatusCode);
            Assert.Equal(1, calls);
        }

        [Fact]
        public async Task RepeatedConnectionFailureStopsAfterOneReconnect()
        {
            var calls = 0;
            await Assert.ThrowsAsync<HttpRequestException>(() => OperatorNativeAuthorizationTransport.SendAsync(() =>
            {
                calls++;
                throw new HttpRequestException("Disconnected");
            }, CancellationToken.None));
            Assert.Equal(2, calls);
        }

        [Fact]
        public async Task ExistingDeadlineCancelsReconnect()
        {
            var calls = 0;
            using var deadline = new CancellationTokenSource();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => OperatorNativeAuthorizationTransport.SendAsync(() =>
            {
                calls++;
                deadline.CancelAfter(20);
                throw new HttpRequestException("Disconnected");
            }, deadline.Token));
            Assert.Equal(1, calls);
        }
    }
}

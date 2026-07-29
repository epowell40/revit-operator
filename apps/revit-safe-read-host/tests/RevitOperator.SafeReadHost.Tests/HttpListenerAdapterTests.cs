using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;
using RevitOperator.SafeReadHost.Kernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    [CollectionDefinition("SafeRead loopback listener", DisableParallelization = true)]
    public sealed class SafeReadLoopbackListenerCollection
    {
    }

    [Collection("SafeRead loopback listener")]
    public sealed class HttpListenerAdapterTests
    {
        [Fact]
        public async Task Real_loopback_adapter_projects_the_exact_request()
        {
            CertifiedRequestFacts facts = await CaptureAsync(BuildRaw("POST", SafeReadContract.Path, string.Empty, null));

            AdmissionDecision decision = CertifiedRequestAdmission.Evaluate(
                facts,
                TestFacts.Identity(),
                TestFacts.Binding());
            Assert.True(decision.Accepted);
            Assert.Equal(SafeReadContract.RequestJson, Encoding.UTF8.GetString(facts.Body));
        }

        [Theory]
        [InlineData("post", "/revit/certified/sheets/count")]
        [InlineData("POST", "/revit/certified/sheets/count/")]
        [InlineData("POST", "/revit/certified/sheets/count?x=1")]
        [InlineData("POST", "/revit/certified/sheets%2fcount")]
        public async Task Real_adapter_preserves_or_rejects_raw_method_and_target_variants(string method, string target)
        {
            CertifiedRequestFacts facts = await CaptureAsync(BuildRaw(method, target, string.Empty, null));

            AdmissionDecision decision = CertifiedRequestAdmission.Evaluate(
                facts,
                TestFacts.Identity(),
                TestFacts.Binding());
            Assert.False(decision.Accepted);
        }

        [Fact]
        public async Task Duplicate_and_unknown_safe_read_headers_are_rejected_after_real_projection()
        {
            string duplicate = SafeReadContract.StartupTokenHeader + ": " + TestFacts.StartupToken + "\r\n";
            CertifiedRequestFacts duplicated = await CaptureAsync(BuildRaw("POST", SafeReadContract.Path, duplicate, null));
            Assert.False(CertifiedRequestAdmission.Evaluate(
                duplicated, TestFacts.Identity(), TestFacts.Binding()).Accepted);

            CertifiedRequestFacts unknown = await CaptureAsync(BuildRaw(
                "POST",
                SafeReadContract.Path,
                "X-RevitOperator-SafeRead-Unknown: rejected\r\n",
                null));
            Assert.True(unknown.HasUnknownSafeReadHeader);
            Assert.False(CertifiedRequestAdmission.Evaluate(
                unknown, TestFacts.Identity(), TestFacts.Binding()).Accepted);
        }

        [Fact]
        public async Task Missing_required_header_is_rejected_after_real_projection()
        {
            string raw = BuildRaw("POST", SafeReadContract.Path, string.Empty, null)
                .Replace(SafeReadContract.RequestIdHeader + ": " + TestFacts.RequestId + "\r\n", string.Empty);
            CertifiedRequestFacts facts = await CaptureAsync(raw);

            Assert.Equal(string.Empty, facts.RequestId);
            Assert.False(CertifiedRequestAdmission.Evaluate(
                facts, TestFacts.Identity(), TestFacts.Binding()).Accepted);
        }

        [Fact]
        public async Task Truncated_entity_is_rejected_after_real_projection()
        {
            string truncated = SafeReadContract.RequestJson.Substring(0, SafeReadContract.RequestJson.Length - 1);
            CertifiedRequestFacts facts = await CaptureAsync(BuildRaw(
                "POST",
                SafeReadContract.Path,
                string.Empty,
                truncated));

            Assert.Empty(facts.Body);
            Assert.False(CertifiedRequestAdmission.Evaluate(
                facts, TestFacts.Identity(), TestFacts.Binding()).Accepted);
        }

        private static string BuildRaw(string method, string target, string additionalHeaders, string? bodyOverride)
        {
            string body = bodyOverride ?? SafeReadContract.RequestJson;
            return method + " " + target + " HTTP/1.1\r\n" +
                   "Host: 127.0.0.1\r\n" +
                   "Content-Type: " + SafeReadContract.ContentType + "\r\n" +
                   "Content-Length: " + SafeReadContract.RequestByteCount + "\r\n" +
                   SafeReadContract.StartupTokenHeader + ": " + TestFacts.StartupToken + "\r\n" +
                   SafeReadContract.HostInstanceHeader + ": " + TestFacts.HostInstanceId + "\r\n" +
                   SafeReadContract.DocumentSessionHeader + ": " + TestFacts.DocumentSessionId + "\r\n" +
                   SafeReadContract.ClientSessionHeader + ": " + TestFacts.ClientSessionId + "\r\n" +
                   SafeReadContract.RequestIdHeader + ": " + TestFacts.RequestId + "\r\n" +
                   SafeReadContract.AttemptIdHeader + ": " + TestFacts.AttemptId + "\r\n" +
                   SafeReadContract.CapabilityNonceHeader + ": " + TestFacts.CapabilityNonce + "\r\n" +
                   additionalHeaders +
                   "Connection: close\r\n\r\n" + body;
        }

        private static async Task<CertifiedRequestFacts> CaptureAsync(string rawRequest)
        {
            HttpListener? listener = null;
            int port = 0;
            for (int candidate = SafeReadContract.MinimumPort; candidate <= SafeReadContract.MaximumPort; candidate++)
            {
                HttpListener attempt = new HttpListener();
                attempt.Prefixes.Add("http://127.0.0.1:" + candidate + "/");
                try
                {
                    attempt.Start();
                    listener = attempt;
                    port = candidate;
                    break;
                }
                catch
                {
                    attempt.Close();
                }
            }
            Assert.NotNull(listener);

            try
            {
                Task<HttpListenerContext> contextTask = listener!.GetContextAsync();
                using (TcpClient client = new TcpClient(AddressFamily.InterNetwork))
                {
                    await client.ConnectAsync(IPAddress.Loopback, port);
                    byte[] bytes = Encoding.UTF8.GetBytes(rawRequest);
                    NetworkStream stream = client.GetStream();
                    await stream.WriteAsync(bytes, 0, bytes.Length);
                    await stream.FlushAsync();
                    client.Client.Shutdown(SocketShutdown.Send);

                    HttpListenerContext context = await contextTask.WaitAsync(TimeSpan.FromSeconds(5));
                    try
                    {
                        return await HttpListenerRequestFactsReader.ReadAsync(context.Request)
                            .WaitAsync(TimeSpan.FromSeconds(5));
                    }
                    finally
                    {
                        try
                        {
                            context.Response.Close();
                        }
                        catch (HttpListenerException)
                        {
                        }
                    }
                }
            }
            finally
            {
                listener!.Close();
            }
        }
    }
}

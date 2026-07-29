using System.Text;
using RevitOperator.SafeReadHost.Kernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class ContractAdmissionTests
    {
        [Fact]
        public void Exact_request_is_admitted()
        {
            AdmissionDecision decision = CertifiedRequestAdmission.Evaluate(
                TestFacts.ValidRequest(),
                TestFacts.Identity(),
                TestFacts.Binding());

            Assert.True(decision.Accepted);
            Assert.Equal(FailureCode.None, decision.FailureCode);
        }

        [Theory]
        [InlineData("GET", "/revit/certified/sheets/count")]
        [InlineData("post", "/revit/certified/sheets/count")]
        [InlineData("POST", "/revit/certified/sheets/count/")]
        [InlineData("POST", "/Revit/certified/sheets/count")]
        [InlineData("POST", "/revit/certified/sheets/COUNT")]
        [InlineData("POST", "/revit/certified/sheets/count?x=1")]
        [InlineData("POST", "/revit/certified/sheets//count")]
        [InlineData("POST", "/revit/certified/sheets%2fcount")]
        [InlineData("POST", "/revit/sheets/count")]
        public void Method_and_raw_target_must_be_exact(string method, string target)
        {
            CertifiedRequestFacts request = TestFacts.ValidRequest();
            request.Method = method;
            request.RawTarget = target;

            AssertRejected(request, FailureCode.BadRequest);
        }

        [Theory]
        [InlineData("")]
        [InlineData("{}")]
        [InlineData("{\"schema\": \"revit-operator.safe-read.sheets-count.request.v1\"}")]
        [InlineData("{\"schema\":\"revit-operator.safe-read.sheets-count.request.v1\"}\n")]
        [InlineData("{\"schema\":\"revit-operator.safe-read.sheets-count.request.v1\",\"unknown\":true}")]
        [InlineData("{\"schema\":\"revit-operator.safe-read.sheets-count.request.V1\"}")]
        [InlineData("[]")]
        [InlineData("null")]
        public void Entity_bytes_must_be_exact(string json)
        {
            CertifiedRequestFacts request = TestFacts.ValidRequest();
            request.Body = Encoding.UTF8.GetBytes(json);
            request.ContentLength = request.Body.Length;

            AssertRejected(request, FailureCode.BadRequest);
        }

        [Fact]
        public void Utf8_bom_is_rejected()
        {
            CertifiedRequestFacts request = TestFacts.ValidRequest();
            byte[] exact = SafeReadContract.CopyRequestBytes();
            request.Body = new byte[exact.Length + 3];
            request.Body[0] = 0xef;
            request.Body[1] = 0xbb;
            request.Body[2] = 0xbf;
            System.Buffer.BlockCopy(exact, 0, request.Body, 3, exact.Length);
            request.ContentLength = request.Body.Length;

            AssertRejected(request, FailureCode.BadRequest);
        }

        [Fact]
        public void Chunked_transfer_and_content_encoding_are_rejected()
        {
            CertifiedRequestFacts chunked = TestFacts.ValidRequest();
            chunked.IsChunked = true;
            AssertRejected(chunked, FailureCode.BadRequest);

            CertifiedRequestFacts transfer = TestFacts.ValidRequest();
            transfer.HasTransferEncoding = true;
            AssertRejected(transfer, FailureCode.BadRequest);

            CertifiedRequestFacts encoded = TestFacts.ValidRequest();
            encoded.HasContentEncoding = true;
            AssertRejected(encoded, FailureCode.BadRequest);
        }

        [Fact]
        public void Content_type_length_and_loopback_are_exact()
        {
            CertifiedRequestFacts contentType = TestFacts.ValidRequest();
            contentType.ContentType = "application/json; charset=utf-8";
            AssertRejected(contentType, FailureCode.BadRequest);

            CertifiedRequestFacts length = TestFacts.ValidRequest();
            length.ContentLength++;
            AssertRejected(length, FailureCode.BadRequest);

            CertifiedRequestFacts remote = TestFacts.ValidRequest();
            remote.RemoteEndpointIsIpv4Loopback = false;
            AssertRejected(remote, FailureCode.BadRequest);
        }

        [Fact]
        public void Required_identity_headers_are_distinct_and_exact()
        {
            CertifiedRequestFacts token = TestFacts.ValidRequest();
            token.StartupToken = TestFacts.CapabilityNonce;
            AssertRejected(token, FailureCode.Unauthorized);

            CertifiedRequestFacts instance = TestFacts.ValidRequest();
            instance.HostInstanceId = TestFacts.ClientSessionId;
            AssertRejected(instance, FailureCode.Unauthorized);

            CertifiedRequestFacts session = TestFacts.ValidRequest();
            session.DocumentSessionId = TestFacts.ClientSessionId;
            AssertRejected(session, FailureCode.DocumentChanged);

            CertifiedRequestFacts duplicate = TestFacts.ValidRequest();
            duplicate.HasDuplicateRequiredHeader = true;
            AssertRejected(duplicate, FailureCode.BadRequest);

            CertifiedRequestFacts unknown = TestFacts.ValidRequest();
            unknown.HasUnknownSafeReadHeader = true;
            AssertRejected(unknown, FailureCode.BadRequest);
        }

        [Theory]
        [InlineData("client")]
        [InlineData("request")]
        [InlineData("attempt")]
        [InlineData("nonce")]
        public void Authorization_binding_headers_are_canonical(string field)
        {
            CertifiedRequestFacts request = TestFacts.ValidRequest();
            if (field == "client") request.ClientSessionId = "AAAAAAAA-3333-3333-3333-333333333333";
            if (field == "request") request.RequestId = "not-a-guid";
            if (field == "attempt") request.AttemptId = string.Empty;
            if (field == "nonce") request.CapabilityNonce = new string('!', 43);

            AssertRejected(request, FailureCode.BadRequest);
        }

        [Fact]
        public void Missing_active_document_fails_before_queueing()
        {
            AdmissionDecision decision = CertifiedRequestAdmission.Evaluate(
                TestFacts.ValidRequest(),
                TestFacts.Identity(),
                null);

            Assert.False(decision.Accepted);
            Assert.Equal(FailureCode.NoActiveDocument, decision.FailureCode);
        }

        private static void AssertRejected(CertifiedRequestFacts request, FailureCode expected)
        {
            AdmissionDecision decision = CertifiedRequestAdmission.Evaluate(
                request,
                TestFacts.Identity(),
                TestFacts.Binding());
            Assert.False(decision.Accepted);
            Assert.Equal(expected, decision.FailureCode);
        }
    }
}

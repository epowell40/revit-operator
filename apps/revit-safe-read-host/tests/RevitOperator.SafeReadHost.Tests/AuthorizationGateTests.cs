using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using RevitOperator.SafeReadHost.Kernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class AuthorizationGateTests
    {
        private static readonly DateTimeOffset Now = new DateTimeOffset(2026, 7, 29, 12, 0, 0, TimeSpan.Zero);

        [Fact]
        public async Task Deny_all_client_never_authorizes()
        {
            FixedBackendOrigin origin = Origin();
            SafeReadAuthorizationGate gate = Gate(origin, new DenyAllSafeReadAuthorizationClient(origin));

            AuthorizationDecision decision = await gate.AuthorizeAsync(
                TestFacts.AuthorizationFields(),
                TestFacts.CapabilityNonce,
                CancellationToken.None);

            Assert.False(decision.Authorized);
            Assert.Null(decision.Receipt);
        }

        [Fact]
        public async Task Exact_preauthorization_and_hmac_verified_final_receipt_authorize_once()
        {
            FixedBackendOrigin origin = Origin();
            FakeAuthorizationClient client = new FakeAuthorizationClient(origin, Now);
            ReceiptReplayGuard replay = new ReceiptReplayGuard();
            SafeReadAuthorizationGate gate = new SafeReadAuthorizationGate(
                origin,
                client,
                new FakeClock(Now),
                replay);

            AuthorizationDecision first = await gate.AuthorizeAsync(
                TestFacts.AuthorizationFields(),
                TestFacts.CapabilityNonce,
                CancellationToken.None);
            AuthorizationDecision replayed = await gate.AuthorizeAsync(
                TestFacts.AuthorizationFields(),
                TestFacts.CapabilityNonce,
                CancellationToken.None);

            Assert.True(first.Authorized);
            Assert.NotNull(first.Receipt);
            Assert.False(replayed.Authorized);
            Assert.Equal(2, client.PreauthorizationCalls);
            Assert.Equal(2, client.FinalAuthorizationCalls);
        }

        [Fact]
        public async Task Wrong_origin_bindings_hash_or_unverified_hmac_fail_closed()
        {
            FixedBackendOrigin expected = Origin();
            FixedBackendOrigin? wrong;
            Assert.True(FixedBackendOrigin.TryCreate("https://other.example", out wrong));

            FakeAuthorizationClient wrongOrigin = new FakeAuthorizationClient(wrong!, Now);
            Assert.False((await Gate(expected, wrongOrigin).AuthorizeAsync(
                TestFacts.AuthorizationFields(), TestFacts.CapabilityNonce, CancellationToken.None)).Authorized);

            FakeAuthorizationClient wrongBindings = new FakeAuthorizationClient(expected, Now);
            wrongBindings.TamperBindingsHash = true;
            Assert.False((await Gate(expected, wrongBindings).AuthorizeAsync(
                TestFacts.AuthorizationFields(), TestFacts.CapabilityNonce, CancellationToken.None)).Authorized);

            FakeAuthorizationClient badHmac = new FakeAuthorizationClient(expected, Now);
            badHmac.HmacVerified = false;
            Assert.False((await Gate(expected, badHmac).AuthorizeAsync(
                TestFacts.AuthorizationFields(), TestFacts.CapabilityNonce, CancellationToken.None)).Authorized);
        }

        [Theory]
        [InlineData("route")]
        [InlineData("host_instance")]
        [InlineData("executor")]
        [InlineData("runtime_attestation")]
        [InlineData("host_content")]
        [InlineData("host_mvid")]
        [InlineData("revit_api_content")]
        [InlineData("revit_api_mvid")]
        [InlineData("revit_version")]
        [InlineData("project_fingerprint")]
        [InlineData("document_session")]
        [InlineData("client_session")]
        [InlineData("request")]
        [InlineData("attempt")]
        public async Task Every_final_receipt_binding_is_echo_checked(string field)
        {
            FixedBackendOrigin origin = Origin();
            FakeAuthorizationClient client = new FakeAuthorizationClient(origin, Now);
            client.TamperField = field;

            AuthorizationDecision decision = await Gate(origin, client).AuthorizeAsync(
                TestFacts.AuthorizationFields(),
                TestFacts.CapabilityNonce,
                CancellationToken.None);

            Assert.False(decision.Authorized);
        }

        [Fact]
        public async Task Expired_or_longer_than_two_second_receipts_fail_closed()
        {
            FixedBackendOrigin origin = Origin();
            FakeAuthorizationClient expired = new FakeAuthorizationClient(origin, Now);
            expired.ReceiptExpiresAt = Now;
            Assert.False((await Gate(origin, expired).AuthorizeAsync(
                TestFacts.AuthorizationFields(), TestFacts.CapabilityNonce, CancellationToken.None)).Authorized);

            FakeAuthorizationClient longLived = new FakeAuthorizationClient(origin, Now);
            longLived.ReceiptExpiresAt = Now.AddSeconds(3);
            Assert.False((await Gate(origin, longLived).AuthorizeAsync(
                TestFacts.AuthorizationFields(), TestFacts.CapabilityNonce, CancellationToken.None)).Authorized);
        }

        [Fact]
        public async Task Runtime_attestation_and_nonce_hash_are_mandatory()
        {
            FixedBackendOrigin origin = Origin();
            FakeAuthorizationClient client = new FakeAuthorizationClient(origin, Now);
            AuthorizationImmutableFields fields = TestFacts.AuthorizationFields();
            AuthorizationImmutableFields bad = new AuthorizationImmutableFields(
                fields.RouteId,
                fields.HostInstanceId,
                fields.ExecutorId,
                fields.RuntimeAttestationSha256,
                new RuntimeAttestationTuple(
                    string.Empty,
                    fields.RuntimeTuple.HostMvid,
                    fields.RuntimeTuple.RevitApiContentSha256,
                    fields.RuntimeTuple.RevitApiMvid,
                    fields.RuntimeTuple.RevitVersion),
                fields.Document,
                fields.ClientSessionId,
                fields.RequestId,
                fields.AttemptId,
                fields.CapabilityNonceSha256);

            Assert.False((await Gate(origin, client).AuthorizeAsync(
                bad, TestFacts.CapabilityNonce, CancellationToken.None)).Authorized);
            Assert.False((await Gate(origin, client).AuthorizeAsync(
                fields, new string('C', 43), CancellationToken.None)).Authorized);
        }

        private static SafeReadAuthorizationGate Gate(FixedBackendOrigin origin, ISafeReadAuthorizationClient client)
        {
            return new SafeReadAuthorizationGate(origin, client, new FakeClock(Now), new ReceiptReplayGuard());
        }

        private static FixedBackendOrigin Origin()
        {
            FixedBackendOrigin? origin;
            Assert.True(FixedBackendOrigin.TryCreate("https://operator.example", out origin));
            return origin!;
        }

        private static string Utc(DateTimeOffset value)
        {
            return value.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
        }

        private sealed class FakeClock : IAuthorizationClock
        {
            public FakeClock(DateTimeOffset now)
            {
                UtcNow = now;
            }

            public DateTimeOffset UtcNow { get; private set; }
        }

        private sealed class FakeAuthorizationClient : ISafeReadAuthorizationClient
        {
            private readonly DateTimeOffset _now;

            public FakeAuthorizationClient(FixedBackendOrigin origin, DateTimeOffset now)
            {
                Origin = origin;
                _now = now;
                ReceiptExpiresAt = now.AddSeconds(1);
            }

            public FixedBackendOrigin? Origin { get; private set; }
            public string? TamperField { get; set; }
            public bool TamperBindingsHash { get; set; }
            public bool HmacVerified { get; set; } = true;
            public DateTimeOffset ReceiptExpiresAt { get; set; }
            public int PreauthorizationCalls { get; private set; }
            public int FinalAuthorizationCalls { get; private set; }

            public Task<PreauthorizationResponse?> PreauthorizeAsync(
                PreauthorizationRequest request,
                CancellationToken cancellationToken)
            {
                PreauthorizationCalls++;
                return Task.FromResult<PreauthorizationResponse?>(new PreauthorizationResponse(
                    SafeReadContract.PreauthorizationResponseSchema,
                    TestFacts.CapabilityId,
                    TestFacts.BindingsHash,
                    Utc(_now.AddSeconds(-1)),
                    Utc(_now.AddSeconds(20))));
            }

            public Task<FinalAuthorizationReceipt?> FinalAuthorizeAsync(
                FinalAuthorizationRequest request,
                CancellationToken cancellationToken)
            {
                FinalAuthorizationCalls++;
                AuthorizationPublicBindings echoed = Tamper(request.Fields, TamperField);
                string bindingsHash = TamperBindingsHash
                    ? "sha256:" + new string('0', 64)
                    : TestFacts.BindingsHash;
                return Task.FromResult<FinalAuthorizationReceipt?>(new FinalAuthorizationReceipt(
                    SafeReadContract.FinalAuthorizationReceiptSchema,
                    echoed,
                    request.CapabilityId,
                    bindingsHash,
                    TestFacts.ReceiptId,
                    Utc(_now.AddMilliseconds(-100)),
                    Utc(ReceiptExpiresAt),
                    TestFacts.Hmac));
            }

            public bool VerifyReceiptHmac(FinalAuthorizationReceipt receipt, string capabilityNonce)
            {
                return HmacVerified && string.Equals(capabilityNonce, TestFacts.CapabilityNonce, StringComparison.Ordinal);
            }

            private static AuthorizationPublicBindings Tamper(AuthorizationPublicBindings source, string? field)
            {
                if (field == null)
                    return source;
                RuntimeAttestationTuple runtime = new RuntimeAttestationTuple(
                    field == "host_content" ? "sha256:" + new string('0', 64) : source.RuntimeTuple.HostContentSha256,
                    field == "host_mvid" ? "99999999-9999-9999-9999-999999999999" : source.RuntimeTuple.HostMvid,
                    field == "revit_api_content" ? "sha256:" + new string('0', 64) : source.RuntimeTuple.RevitApiContentSha256,
                    field == "revit_api_mvid" ? "99999999-9999-9999-9999-999999999999" : source.RuntimeTuple.RevitApiMvid,
                    field == "revit_version" ? "2024" : source.RuntimeTuple.RevitVersion);
                AuthorizationDocument document = new AuthorizationDocument(
                    field == "project_fingerprint" ? "sha256:" + new string('0', 64) : source.Document.ProjectFingerprint,
                    field == "document_session" ? "99999999-9999-9999-9999-999999999999" : source.Document.DocumentSessionId);
                return new AuthorizationPublicBindings(
                    field == "route" ? "safe_read.other.v1" : source.RouteId,
                    field == "host_instance" ? "99999999-9999-9999-9999-999999999999" : source.HostInstanceId,
                    field == "executor" ? "revit-operator.other.v1" : source.ExecutorId,
                    field == "runtime_attestation" ? "sha256:" + new string('0', 64) : source.RuntimeAttestationSha256,
                    runtime,
                    document,
                    field == "client_session" ? "99999999-9999-9999-9999-999999999999" : source.ClientSessionId,
                    field == "request" ? "99999999-9999-9999-9999-999999999999" : source.RequestId,
                    field == "attempt" ? "99999999-9999-9999-9999-999999999999" : source.AttemptId);
            }
        }
    }
}

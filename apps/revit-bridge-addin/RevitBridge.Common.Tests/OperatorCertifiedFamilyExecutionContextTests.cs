using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorCertifiedFamilyExecutionContextTests
    {
        private const string EnvelopeHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        private const string Challenge = "cmcc1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

        [Fact]
        public void Courier_context_uses_only_final_authorization_transport_identity()
        {
            var authorization = new OperatorCourierFinalExecutionAuthorization
            {
                JobId = "job-a",
                CorrelationId = "correlation-a",
                SessionId = "session-a",
                ExecutorId = "executor-a",
                CertificationEnvelopeHash = EnvelopeHash,
                AuthorizationStage = "final",
                CompletionChallenge = Challenge,
                CompletionChallengeHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(Challenge),
                RequestFamilyAdmission = new OperatorCertifiedRequestFamilyAdmission()
            };

            var context = OperatorCertifiedFamilyExecutionContext.Courier(authorization);

            Assert.Equal("courier", context.TransportKind);
            Assert.Equal("job-a", context.DispatchId);
            Assert.Equal("correlation-a", context.CorrelationId);
            Assert.Equal("session-a", context.ExecutionSessionId);
            Assert.Equal("executor-a", context.ExecutorId);
            Assert.Equal(EnvelopeHash, context.CertificationEnvelopeHash);
            Assert.Equal(OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(Challenge), context.CompletionChallengeHash);
        }

        [Fact]
        public void Courier_context_rejects_preflight_or_challenge_free_authorization()
        {
            var authorization = new OperatorCourierFinalExecutionAuthorization
            {
                AuthorizationStage = "preflight",
                RequestFamilyAdmission = new OperatorCertifiedRequestFamilyAdmission()
            };
            Assert.Throws<System.InvalidOperationException>(() =>
                OperatorCertifiedFamilyExecutionContext.Courier(authorization));

            authorization.AuthorizationStage = "final";
            Assert.Throws<System.InvalidOperationException>(() =>
                OperatorCertifiedFamilyExecutionContext.Courier(authorization));
        }

        [Fact]
        public void Direct_context_uses_protected_request_and_native_process_identity()
        {
            var admission = new OperatorCertifiedRequestFamilyAdmission
            {
                AdmissionSessionId = "admission-a"
            };
            var envelope = new OperatorCourierCertificationEnvelope
            {
                RequestFamilyAdmission = admission,
                EnvelopeHash = EnvelopeHash
            };
            var request = new OperatorNativeHttpRequest(
                "0123456789abcdef0123456789abcdef",
                "POST",
                "/revit/move-elements",
                true,
                "{}",
                "typed_mcp",
                "revit_move_one_element",
                envelope,
                "{}");

            var context = OperatorCertifiedFamilyExecutionContext.Direct(request);

            Assert.Equal("direct", context.TransportKind);
            Assert.Equal(request.RequestId, context.DispatchId);
            Assert.Equal(request.RequestId, context.CorrelationId);
            Assert.Equal("admission-a", context.ExecutionSessionId);
            Assert.Equal(OperatorNativeExecutionAttestationAuthority.KeyId, context.ExecutorId);
            Assert.Equal(EnvelopeHash, context.CertificationEnvelopeHash);
            Assert.Null(context.CompletionChallengeHash);
        }
    }
}

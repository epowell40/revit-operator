using System;

namespace RevitBridge.Common
{
    /// <summary>
    /// Native-only transport identity captured from an already verified direct
    /// request or courier final authorization. This type is never deserialized
    /// from a handler body and is passed beside the sealed family envelope at
    /// the final Revit-thread boundary.
    /// </summary>
    public sealed class OperatorCertifiedFamilyExecutionContext
    {
        private OperatorCertifiedFamilyExecutionContext(
            string transportKind,
            string dispatchId,
            string correlationId,
            string executionSessionId,
            string executorId,
            string certificationEnvelopeHash,
            string? completionChallengeHash)
        {
            TransportKind = transportKind;
            DispatchId = Require(dispatchId, nameof(dispatchId));
            CorrelationId = Require(correlationId, nameof(correlationId));
            ExecutionSessionId = Require(executionSessionId, nameof(executionSessionId));
            ExecutorId = Require(executorId, nameof(executorId));
            CertificationEnvelopeHash = Require(certificationEnvelopeHash, nameof(certificationEnvelopeHash));
            CompletionChallengeHash = completionChallengeHash;
        }

        public string TransportKind { get; }
        public string DispatchId { get; }
        public string CorrelationId { get; }
        public string ExecutionSessionId { get; }
        public string ExecutorId { get; }
        public string CertificationEnvelopeHash { get; }
        public string? CompletionChallengeHash { get; }

        public static OperatorCertifiedFamilyExecutionContext Direct(OperatorNativeHttpRequest request)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            var envelope = request.CertificationEnvelope
                ?? throw new InvalidOperationException("Certified direct execution is missing its verified family envelope.");
            var admission = envelope.RequestFamilyAdmission
                ?? throw new InvalidOperationException("Certified direct execution is missing its request-family admission.");
            return new OperatorCertifiedFamilyExecutionContext(
                "direct",
                request.RequestId,
                request.RequestId,
                admission.AdmissionSessionId,
                OperatorNativeExecutionAttestationAuthority.KeyId,
                envelope.EnvelopeHash,
                null);
        }

        public static OperatorCertifiedFamilyExecutionContext Courier(
            OperatorCourierFinalExecutionAuthorization authorization)
        {
            if (authorization == null) throw new ArgumentNullException(nameof(authorization));
            if (authorization.RequestFamilyAdmission == null
                || !string.Equals(authorization.AuthorizationStage, "final", StringComparison.Ordinal)
                || !OperatorCourierFinalExecutionAuthorizationBinder.ValidateCompletionChallenge(
                    authorization.AuthorizationStage,
                    authorization.CompletionChallenge,
                    authorization.CompletionChallengeHash))
                throw new InvalidOperationException("Certified courier execution requires a final challenge-bound family authorization.");
            return new OperatorCertifiedFamilyExecutionContext(
                "courier",
                authorization.JobId,
                authorization.CorrelationId,
                authorization.SessionId,
                authorization.ExecutorId,
                authorization.CertificationEnvelopeHash,
                authorization.CompletionChallengeHash);
        }

        internal static OperatorCertifiedFamilyExecutionContext ForTests(
            string transportKind,
            string dispatchId,
            string correlationId,
            string executionSessionId,
            string executorId,
            string certificationEnvelopeHash,
            string? completionChallengeHash)
            => new OperatorCertifiedFamilyExecutionContext(
                transportKind,
                dispatchId,
                correlationId,
                executionSessionId,
                executorId,
                certificationEnvelopeHash,
                completionChallengeHash);

        private static string Require(string value, string name)
            => string.IsNullOrWhiteSpace(value)
                ? throw new ArgumentException("Execution context field is empty.", name)
                : value;
    }
}

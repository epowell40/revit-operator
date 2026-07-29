using System;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal sealed class CertifiedRequestFacts
    {
        public string Method { get; set; } = string.Empty;
        public string RawTarget { get; set; } = string.Empty;
        public bool RemoteEndpointIsIpv4Loopback { get; set; }
        public bool IsChunked { get; set; }
        public bool HasTransferEncoding { get; set; }
        public bool HasContentEncoding { get; set; }
        public long ContentLength { get; set; }
        public string ContentType { get; set; } = string.Empty;
        public byte[] Body { get; set; } = new byte[0];
        public string StartupToken { get; set; } = string.Empty;
        public string HostInstanceId { get; set; } = string.Empty;
        public string DocumentSessionId { get; set; } = string.Empty;
        public string ClientSessionId { get; set; } = string.Empty;
        public string RequestId { get; set; } = string.Empty;
        public string AttemptId { get; set; } = string.Empty;
        public string CapabilityNonce { get; set; } = string.Empty;
        public bool HasDuplicateRequiredHeader { get; set; }
        public bool HasUnknownSafeReadHeader { get; set; }
    }

    internal sealed class AdmissionDecision
    {
        private AdmissionDecision(bool accepted, FailureCode failureCode)
        {
            Accepted = accepted;
            FailureCode = failureCode;
        }

        public bool Accepted { get; private set; }
        public FailureCode FailureCode { get; private set; }

        public static AdmissionDecision Accept()
        {
            return new AdmissionDecision(true, FailureCode.None);
        }

        public static AdmissionDecision Reject(FailureCode failureCode)
        {
            return new AdmissionDecision(false, failureCode);
        }
    }

    internal static class CertifiedRequestAdmission
    {
        public static AdmissionDecision Evaluate(
            CertifiedRequestFacts? request,
            InstanceIdentity identity,
            DocumentBinding? currentDocument)
        {
            if (request == null || identity == null)
                return AdmissionDecision.Reject(FailureCode.BadRequest);
            if (!request.RemoteEndpointIsIpv4Loopback)
                return AdmissionDecision.Reject(FailureCode.BadRequest);
            if (!string.Equals(request.Method, SafeReadContract.Method, StringComparison.Ordinal))
                return AdmissionDecision.Reject(FailureCode.BadRequest);
            if (!string.Equals(request.RawTarget, SafeReadContract.Path, StringComparison.Ordinal))
                return AdmissionDecision.Reject(FailureCode.BadRequest);
            if (request.IsChunked || request.HasTransferEncoding || request.HasContentEncoding)
                return AdmissionDecision.Reject(FailureCode.BadRequest);
            if (request.ContentLength != SafeReadContract.RequestByteCount)
                return AdmissionDecision.Reject(FailureCode.BadRequest);
            if (!string.Equals(request.ContentType, SafeReadContract.ContentType, StringComparison.Ordinal))
                return AdmissionDecision.Reject(FailureCode.BadRequest);
            if (!SafeReadContract.RequestBytesEqual(request.Body))
                return AdmissionDecision.Reject(FailureCode.BadRequest);
            if (request.HasDuplicateRequiredHeader || request.HasUnknownSafeReadHeader)
                return AdmissionDecision.Reject(FailureCode.BadRequest);
            if (!identity.TokenMatches(request.StartupToken))
                return AdmissionDecision.Reject(FailureCode.Unauthorized);
            if (!string.Equals(request.HostInstanceId, identity.HostInstanceId, StringComparison.Ordinal))
                return AdmissionDecision.Reject(FailureCode.Unauthorized);
            if (currentDocument == null)
                return AdmissionDecision.Reject(FailureCode.NoActiveDocument);
            if (!string.Equals(request.DocumentSessionId, currentDocument.DocumentSessionId, StringComparison.Ordinal))
                return AdmissionDecision.Reject(FailureCode.DocumentChanged);
            if (!ProtocolValidation.IsCanonicalGuid(request.ClientSessionId) ||
                !ProtocolValidation.IsCanonicalGuid(request.RequestId) ||
                !ProtocolValidation.IsCanonicalGuid(request.AttemptId) ||
                !ProtocolValidation.IsBase64UrlSecret(request.CapabilityNonce))
                return AdmissionDecision.Reject(FailureCode.BadRequest);
            return AdmissionDecision.Accept();
        }
    }
}

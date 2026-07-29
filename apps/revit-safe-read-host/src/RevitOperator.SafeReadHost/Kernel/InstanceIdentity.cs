using System;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal sealed class InstanceIdentity
    {
        public InstanceIdentity(string hostInstanceId, string startupToken)
        {
            if (!ProtocolValidation.IsCanonicalGuid(hostInstanceId))
                throw new ArgumentException("hostInstanceId is not canonical.", nameof(hostInstanceId));
            if (!ProtocolValidation.IsBase64UrlSecret(startupToken))
                throw new ArgumentException("startupToken is not a 256-bit base64url value.", nameof(startupToken));
            HostInstanceId = hostInstanceId;
            StartupToken = startupToken;
        }

        public string HostInstanceId { get; private set; }
        public string StartupToken { get; private set; }

        public static InstanceIdentity Create()
        {
            return new InstanceIdentity(Guid.NewGuid().ToString("D"), ProtocolValidation.NewSecret());
        }

        public bool TokenMatches(string? candidate)
        {
            return ProtocolValidation.FixedTimeSecretEquals(StartupToken, candidate);
        }
    }
}

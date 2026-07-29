using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal interface IAuthorizationClock
    {
        DateTimeOffset UtcNow { get; }
    }

    internal sealed class SystemAuthorizationClock : IAuthorizationClock
    {
        public DateTimeOffset UtcNow
        {
            get { return DateTimeOffset.UtcNow; }
        }
    }

    internal sealed class ReceiptReplayGuard
    {
        private const int Capacity = 256;
        private readonly object _sync = new object();
        private readonly HashSet<string> _seen = new HashSet<string>(StringComparer.Ordinal);
        private readonly Queue<string> _order = new Queue<string>();

        public bool TryConsume(string receiptId)
        {
            if (!ProtocolValidation.IsReceiptId(receiptId))
                return false;
            lock (_sync)
            {
                if (_seen.Contains(receiptId))
                    return false;
                _seen.Add(receiptId);
                _order.Enqueue(receiptId);
                while (_order.Count > Capacity)
                    _seen.Remove(_order.Dequeue());
                return true;
            }
        }
    }

    internal sealed class AuthorizationDecision
    {
        private AuthorizationDecision(
            bool authorized,
            FinalAuthorizationReceipt? receipt,
            DateTimeOffset authorizationExpiresAtUtc)
        {
            Authorized = authorized;
            Receipt = receipt;
            AuthorizationExpiresAtUtc = authorizationExpiresAtUtc;
        }

        public bool Authorized { get; private set; }
        public FinalAuthorizationReceipt? Receipt { get; private set; }
        public DateTimeOffset AuthorizationExpiresAtUtc { get; private set; }

        public static AuthorizationDecision Denied()
        {
            return new AuthorizationDecision(false, null, DateTimeOffset.MinValue);
        }

        public static AuthorizationDecision Verified(
            FinalAuthorizationReceipt receipt,
            DateTimeOffset authorizationExpiresAtUtc)
        {
            return new AuthorizationDecision(true, receipt, authorizationExpiresAtUtc);
        }
    }

    internal sealed class SafeReadAuthorizationGate
    {
        private static readonly TimeSpan MaximumPreauthorizationLifetime = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan MaximumReceiptLifetime = TimeSpan.FromSeconds(2);
        private static readonly TimeSpan FutureClockSkew = TimeSpan.FromSeconds(5);
        private readonly FixedBackendOrigin? _configuredOrigin;
        private readonly ISafeReadAuthorizationClient _client;
        private readonly IAuthorizationClock _clock;
        private readonly ReceiptReplayGuard _replayGuard;

        public SafeReadAuthorizationGate(
            FixedBackendOrigin? configuredOrigin,
            ISafeReadAuthorizationClient client,
            IAuthorizationClock clock,
            ReceiptReplayGuard replayGuard)
        {
            _configuredOrigin = configuredOrigin;
            _client = client ?? throw new ArgumentNullException(nameof(client));
            _clock = clock ?? throw new ArgumentNullException(nameof(clock));
            _replayGuard = replayGuard ?? throw new ArgumentNullException(nameof(replayGuard));
        }

        public async Task<AuthorizationDecision> AuthorizeAsync(
            AuthorizationImmutableFields? fields,
            string? capabilityNonce,
            CancellationToken cancellationToken)
        {
            if (_configuredOrigin == null || !_configuredOrigin.EqualsExact(_client.Origin))
                return AuthorizationDecision.Denied();
            if (fields == null || !fields.IsValid() || !ProtocolValidation.IsBase64UrlSecret(capabilityNonce))
                return AuthorizationDecision.Denied();
            if (!string.Equals(
                    fields.CapabilityNonceSha256,
                    ProtocolValidation.Sha256Digest(capabilityNonce!),
                    StringComparison.Ordinal))
                return AuthorizationDecision.Denied();

            PreauthorizationResponse? preauthorization;
            try
            {
                preauthorization = await _client.PreauthorizeAsync(
                    new PreauthorizationRequest(fields),
                    cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                return AuthorizationDecision.Denied();
            }
            if (!ValidatePreauthorization(preauthorization))
                return AuthorizationDecision.Denied();

            FinalAuthorizationRequest finalRequest = new FinalAuthorizationRequest(
                fields.ToPublicBindings(),
                preauthorization!.CapabilityId,
                capabilityNonce!);
            FinalAuthorizationReceipt? receipt;
            try
            {
                receipt = await _client.FinalAuthorizeAsync(finalRequest, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                return AuthorizationDecision.Denied();
            }

            DateTimeOffset receiptExpiresAtUtc;
            if (!ValidateReceipt(finalRequest, preauthorization.BindingsHash, receipt, out receiptExpiresAtUtc))
                return AuthorizationDecision.Denied();
            bool hmacVerified;
            try
            {
                hmacVerified = _client.VerifyReceiptHmac(receipt!, capabilityNonce!);
            }
            catch
            {
                return AuthorizationDecision.Denied();
            }
            if (!hmacVerified || !_replayGuard.TryConsume(receipt!.ReceiptId))
                return AuthorizationDecision.Denied();
            return AuthorizationDecision.Verified(receipt, receiptExpiresAtUtc);
        }

        private bool ValidatePreauthorization(PreauthorizationResponse? response)
        {
            if (response == null ||
                !string.Equals(response.Schema, SafeReadContract.PreauthorizationResponseSchema, StringComparison.Ordinal) ||
                !ProtocolValidation.IsCapabilityId(response.CapabilityId) ||
                !ProtocolValidation.IsSha256(response.BindingsHash))
                return false;
            return ValidateWindow(response.IssuedAtUtc, response.ExpiresAtUtc, MaximumPreauthorizationLifetime);
        }

        private bool ValidateReceipt(
            FinalAuthorizationRequest request,
            string expectedBindingsHash,
            FinalAuthorizationReceipt? receipt,
            out DateTimeOffset expiresAtUtc)
        {
            expiresAtUtc = DateTimeOffset.MinValue;
            if (receipt == null ||
                !string.Equals(receipt.Schema, SafeReadContract.FinalAuthorizationReceiptSchema, StringComparison.Ordinal) ||
                !string.Equals(receipt.CapabilityId, request.CapabilityId, StringComparison.Ordinal) ||
                !string.Equals(receipt.BindingsHash, expectedBindingsHash, StringComparison.Ordinal) ||
                !ProtocolValidation.IsReceiptId(receipt.ReceiptId) ||
                !ProtocolValidation.IsSha256(receipt.HmacSha256) ||
                !FieldsEqual(receipt.Fields, request.Fields))
                return false;
            if (!ValidateWindow(receipt.IssuedAtUtc, receipt.ExpiresAtUtc, MaximumReceiptLifetime))
                return false;
            return TryParseUtc(receipt.ExpiresAtUtc, out expiresAtUtc);
        }

        private bool ValidateWindow(string issuedText, string expiresText, TimeSpan maximumLifetime)
        {
            DateTimeOffset issued;
            DateTimeOffset expires;
            if (!TryParseUtc(issuedText, out issued) || !TryParseUtc(expiresText, out expires))
                return false;
            DateTimeOffset now = _clock.UtcNow;
            if (issued > now + FutureClockSkew || expires <= now || expires <= issued)
                return false;
            if (expires - issued > maximumLifetime)
                return false;
            return true;
        }

        private static bool TryParseUtc(string value, out DateTimeOffset parsed)
        {
            parsed = default(DateTimeOffset);
            if (string.IsNullOrEmpty(value) || !value.EndsWith("Z", StringComparison.Ordinal))
                return false;
            return DateTimeOffset.TryParse(
                value,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out parsed) && parsed.Offset == TimeSpan.Zero;
        }

        private static bool FieldsEqual(AuthorizationPublicBindings? left, AuthorizationPublicBindings? right)
        {
            if (left == null || right == null || left.RuntimeTuple == null || right.RuntimeTuple == null ||
                left.Document == null || right.Document == null)
                return false;
            return string.Equals(left.RouteId, right.RouteId, StringComparison.Ordinal) &&
                   string.Equals(left.HostInstanceId, right.HostInstanceId, StringComparison.Ordinal) &&
                   string.Equals(left.ExecutorId, right.ExecutorId, StringComparison.Ordinal) &&
                   string.Equals(left.RuntimeAttestationSha256, right.RuntimeAttestationSha256, StringComparison.Ordinal) &&
                   string.Equals(left.RuntimeTuple.HostContentSha256, right.RuntimeTuple.HostContentSha256, StringComparison.Ordinal) &&
                   string.Equals(left.RuntimeTuple.HostMvid, right.RuntimeTuple.HostMvid, StringComparison.Ordinal) &&
                   string.Equals(left.RuntimeTuple.RevitApiContentSha256, right.RuntimeTuple.RevitApiContentSha256, StringComparison.Ordinal) &&
                   string.Equals(left.RuntimeTuple.RevitApiMvid, right.RuntimeTuple.RevitApiMvid, StringComparison.Ordinal) &&
                   string.Equals(left.RuntimeTuple.RevitVersion, right.RuntimeTuple.RevitVersion, StringComparison.Ordinal) &&
                   string.Equals(left.Document.ProjectFingerprint, right.Document.ProjectFingerprint, StringComparison.Ordinal) &&
                   string.Equals(left.Document.DocumentSessionId, right.Document.DocumentSessionId, StringComparison.Ordinal) &&
                   string.Equals(left.ClientSessionId, right.ClientSessionId, StringComparison.Ordinal) &&
                   string.Equals(left.RequestId, right.RequestId, StringComparison.Ordinal) &&
                   string.Equals(left.AttemptId, right.AttemptId, StringComparison.Ordinal);
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace RevitOperator.SafeReadCertifiedExecution
{
    public sealed class RuntimeTuple
    {
        public RuntimeTuple(string hostContentSha256, string hostMvid, string revitApiContentSha256, string revitApiMvid, string revitVersion)
        { HostContentSha256 = hostContentSha256; HostMvid = hostMvid; RevitApiContentSha256 = revitApiContentSha256; RevitApiMvid = revitApiMvid; RevitVersion = revitVersion; }
        public string HostContentSha256 { get; }
        public string HostMvid { get; }
        public string RevitApiContentSha256 { get; }
        public string RevitApiMvid { get; }
        public string RevitVersion { get; }
    }

    public sealed class AuthorizationBindings
    {
        public AuthorizationBindings(string routeId, string hostInstanceId, string executorId, string runtimeAttestationSha256, RuntimeTuple runtimeTuple, string projectFingerprint, string documentSessionId, string clientSessionId, string requestId, string attemptId)
        { RouteId = routeId; HostInstanceId = hostInstanceId; ExecutorId = executorId; RuntimeAttestationSha256 = runtimeAttestationSha256; RuntimeTuple = runtimeTuple; ProjectFingerprint = projectFingerprint; DocumentSessionId = documentSessionId; ClientSessionId = clientSessionId; RequestId = requestId; AttemptId = attemptId; }
        public string RouteId { get; }
        public string HostInstanceId { get; }
        public string ExecutorId { get; }
        public string RuntimeAttestationSha256 { get; }
        public RuntimeTuple RuntimeTuple { get; }
        public string ProjectFingerprint { get; }
        public string DocumentSessionId { get; }
        public string ClientSessionId { get; }
        public string RequestId { get; }
        public string AttemptId { get; }
    }

    public sealed class FinalAuthorizationReceipt
    {
        public FinalAuthorizationReceipt(string schema, AuthorizationBindings bindings, string capabilityId, string bindingsHash, string receiptId, string issuedAtUtc, string expiresAtUtc, string hmacSha256, string canonicalPayloadWithoutHmac)
        { Schema = schema; Bindings = bindings; CapabilityId = capabilityId; BindingsHash = bindingsHash; ReceiptId = receiptId; IssuedAtUtc = issuedAtUtc; ExpiresAtUtc = expiresAtUtc; HmacSha256 = hmacSha256; CanonicalPayloadWithoutHmac = canonicalPayloadWithoutHmac; }
        public string Schema { get; }
        public AuthorizationBindings Bindings { get; }
        public string CapabilityId { get; }
        public string BindingsHash { get; }
        public string ReceiptId { get; }
        public string IssuedAtUtc { get; }
        public string ExpiresAtUtc { get; }
        public string HmacSha256 { get; }
        public string CanonicalPayloadWithoutHmac { get; }
    }

    public sealed class VerifiedFinalAuthorizationToken
    {
        private int _consumed;
        internal VerifiedFinalAuthorizationToken(AuthorizationBindings bindings, string receiptId, DateTimeOffset expiresAtUtc)
        { Bindings = bindings; ReceiptId = receiptId; ExpiresAtUtc = expiresAtUtc; }
        public AuthorizationBindings Bindings { get; }
        public string ReceiptId { get; }
        public DateTimeOffset ExpiresAtUtc { get; }
        internal bool TryConsume(DateTimeOffset now) => now <= ExpiresAtUtc && System.Threading.Interlocked.CompareExchange(ref _consumed, 1, 0) == 0;
    }

    public sealed class FinalReceiptVerifier
    {
        private const string ReceiptSchema = "revit-operator.safe-read-final-authorization-receipt.v1";
        private const string RouteId = "safe_read.sheet_count.v1";
        private static readonly TimeSpan MaximumLifetime = TimeSpan.FromSeconds(2);
        private readonly object _sync = new object();
        private readonly HashSet<string> _seen = new HashSet<string>(StringComparer.Ordinal);
        private readonly Queue<string> _order = new Queue<string>();

        public VerifiedFinalAuthorizationToken? Verify(FinalAuthorizationReceipt? receipt, AuthorizationBindings expected, string expectedCapabilityId, string expectedBindingsHash, byte[] nonce, DateTimeOffset now)
        {
            if (receipt == null || receipt.Bindings == null || nonce == null || nonce.Length != 32 ||
                !String.Equals(receipt.Schema, ReceiptSchema, StringComparison.Ordinal) ||
                !BindingsEqual(receipt.Bindings, expected) ||
                !String.Equals(receipt.CapabilityId, expectedCapabilityId, StringComparison.Ordinal) ||
                !String.Equals(receipt.BindingsHash, expectedBindingsHash, StringComparison.Ordinal) ||
                !IsIdentifier(receipt.ReceiptId, "srr1_", 27) || !IsHash(receipt.HmacSha256)) return null;
            DateTimeOffset issued, expires;
            if (!DateTimeOffset.TryParseExact(receipt.IssuedAtUtc, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out issued) ||
                !DateTimeOffset.TryParseExact(receipt.ExpiresAtUtc, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out expires) ||
                issued > now.AddSeconds(5) || expires <= now || expires <= issued || expires - issued > MaximumLifetime) return null;
            byte[] expectedMac;
            using (HMACSHA256 derive = new HMACSHA256(nonce))
                expectedMac = ComputeMac(derive.ComputeHash(Encoding.UTF8.GetBytes("safe-read-final-receipt-v1")), receipt.CanonicalPayloadWithoutHmac);
            byte[] supplied;
            try { supplied = FromHex(receipt.HmacSha256.Substring(7)); }
            catch { return null; }
            bool equal = FixedTimeEquals(expectedMac, supplied);
            Array.Clear(expectedMac, 0, expectedMac.Length); Array.Clear(supplied, 0, supplied.Length);
            if (!equal || !TryRemember(receipt.ReceiptId)) return null;
            return new VerifiedFinalAuthorizationToken(expected, receipt.ReceiptId, expires);
        }

        private static byte[] ComputeMac(byte[] key, string payload)
        { try { using (HMACSHA256 hmac = new HMACSHA256(key)) return hmac.ComputeHash(Encoding.UTF8.GetBytes(payload ?? String.Empty)); } finally { Array.Clear(key, 0, key.Length); } }
        private bool TryRemember(string id) { lock (_sync) { if (_seen.Contains(id)) return false; _seen.Add(id); _order.Enqueue(id); while (_order.Count > 256) _seen.Remove(_order.Dequeue()); return true; } }
        private static bool BindingsEqual(AuthorizationBindings a, AuthorizationBindings b) =>
            String.Equals(a.RouteId, RouteId, StringComparison.Ordinal) && String.Equals(a.RouteId, b.RouteId, StringComparison.Ordinal) &&
            String.Equals(a.HostInstanceId, b.HostInstanceId, StringComparison.Ordinal) && String.Equals(a.ExecutorId, b.ExecutorId, StringComparison.Ordinal) &&
            String.Equals(a.RuntimeAttestationSha256, b.RuntimeAttestationSha256, StringComparison.Ordinal) && RuntimeEqual(a.RuntimeTuple, b.RuntimeTuple) &&
            String.Equals(a.ProjectFingerprint, b.ProjectFingerprint, StringComparison.Ordinal) && String.Equals(a.DocumentSessionId, b.DocumentSessionId, StringComparison.Ordinal) &&
            String.Equals(a.ClientSessionId, b.ClientSessionId, StringComparison.Ordinal) && String.Equals(a.RequestId, b.RequestId, StringComparison.Ordinal) && String.Equals(a.AttemptId, b.AttemptId, StringComparison.Ordinal);
        private static bool RuntimeEqual(RuntimeTuple a, RuntimeTuple b) => a != null && b != null && String.Equals(a.HostContentSha256,b.HostContentSha256,StringComparison.Ordinal) && String.Equals(a.HostMvid,b.HostMvid,StringComparison.Ordinal) && String.Equals(a.RevitApiContentSha256,b.RevitApiContentSha256,StringComparison.Ordinal) && String.Equals(a.RevitApiMvid,b.RevitApiMvid,StringComparison.Ordinal) && String.Equals(a.RevitVersion,b.RevitVersion,StringComparison.Ordinal);
        private static bool IsHash(string value) => value != null && value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal) && IsHex(value, 7);
        private static bool IsHex(string value, int start) { for (int i=start;i<value.Length;i++) if (!((value[i]>='0'&&value[i]<='9')||(value[i]>='a'&&value[i]<='f'))) return false; return true; }
        private static bool IsIdentifier(string value, string prefix, int length) { if (value == null || value.Length != length || !value.StartsWith(prefix,StringComparison.Ordinal)) return false; for(int i=prefix.Length;i<value.Length;i++){char c=value[i];if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='_'||c=='-'))return false;}return true; }
        private static byte[] FromHex(string hex) { byte[] value=new byte[hex.Length/2]; for(int i=0;i<value.Length;i++) value[i]=Byte.Parse(hex.Substring(i*2,2),NumberStyles.HexNumber,CultureInfo.InvariantCulture); return value; }
        private static bool FixedTimeEquals(byte[] a, byte[] b) { if(a.Length!=b.Length)return false; int d=0;for(int i=0;i<a.Length;i++)d|=a[i]^b[i];return d==0; }
    }
}

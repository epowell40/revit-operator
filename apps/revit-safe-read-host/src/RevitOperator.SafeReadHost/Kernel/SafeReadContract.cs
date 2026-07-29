using System;
using System.Text;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal static class SafeReadContract
    {
        public const string ProductName = "Revit Operator Safe Read Host";
        public const string ProductId = "AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E";

        public const string Method = "POST";
        public const string Path = "/revit/certified/sheets/count";
        public const string RequestSchema = "revit-operator.safe-read.sheets-count.request.v1";
        public const string RequestJson = "{\"schema\":\"revit-operator.safe-read.sheets-count.request.v1\"}";
        public const string ResponseSchema = "revit-operator.safe-read.sheets-count.response.v1";
        public const string FailureSchema = "revit-operator.safe-read.failure.v1";
        public const string DiscoverySchema = "revit-operator.safe-read.instance.v1";
        public const string RouteId = "safe_read.sheet_count.v1";
        public const string ExecutorId = "revit-operator.safe-read-host.v1";

        public const string PreauthorizationRequestSchema = "revit-operator.safe-read-preauthorization-request.v1";
        public const string PreauthorizationResponseSchema = "revit-operator.safe-read-preauthorization-response.v1";
        public const string FinalAuthorizationRequestSchema = "revit-operator.safe-read-final-authorization-request.v1";
        public const string FinalAuthorizationReceiptSchema = "revit-operator.safe-read-final-authorization-receipt.v1";

        public const string StartupTokenHeader = "X-RevitOperator-SafeRead-Startup-Token";
        public const string HostInstanceHeader = "X-RevitOperator-SafeRead-Host-Instance-Id";
        public const string DocumentSessionHeader = "X-RevitOperator-SafeRead-Document-Session-Id";
        public const string ClientSessionHeader = "X-RevitOperator-SafeRead-Client-Session-Id";
        public const string RequestIdHeader = "X-RevitOperator-SafeRead-Request-Id";
        public const string AttemptIdHeader = "X-RevitOperator-SafeRead-Attempt-Id";
        public const string CapabilityNonceHeader = "X-RevitOperator-SafeRead-Capability-Nonce";
        public const string SafeReadHeaderPrefix = "X-RevitOperator-SafeRead-";

        public const string ContentType = "application/json";
        public const string ResponseContentType = "application/json; charset=utf-8";
        public const int MinimumPort = 5040;
        public const int MaximumPort = 5050;
        public const int MaximumSheetCount = 100000;
        public const int MaximumResponseBytes = 4096;
        public const int SecretByteCount = 32;
        public const int Base64UrlSecretLength = 43;
        public const int Sha256DigestLength = 71;
        public const int CapabilityIdLength = 48;
        public const int ReceiptIdLength = 48;

        private static readonly byte[] FrozenRequestBytes = new UTF8Encoding(false).GetBytes(RequestJson);

        public static int RequestByteCount
        {
            get { return FrozenRequestBytes.Length; }
        }

        public static byte[] CopyRequestBytes()
        {
            byte[] copy = new byte[FrozenRequestBytes.Length];
            Buffer.BlockCopy(FrozenRequestBytes, 0, copy, 0, copy.Length);
            return copy;
        }

        public static bool RequestBytesEqual(byte[]? candidate)
        {
            if (candidate == null || candidate.Length != FrozenRequestBytes.Length)
                return false;

            int difference = 0;
            for (int index = 0; index < FrozenRequestBytes.Length; index++)
                difference |= FrozenRequestBytes[index] ^ candidate[index];
            return difference == 0;
        }

        public static bool IsRequiredHeader(string? name)
        {
            return string.Equals(name, StartupTokenHeader, StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(name, HostInstanceHeader, StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(name, DocumentSessionHeader, StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(name, ClientSessionHeader, StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(name, RequestIdHeader, StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(name, AttemptIdHeader, StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(name, CapabilityNonceHeader, StringComparison.OrdinalIgnoreCase);
        }
    }
}

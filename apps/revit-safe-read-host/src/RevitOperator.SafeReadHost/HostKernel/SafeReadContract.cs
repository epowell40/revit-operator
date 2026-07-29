using System;
using System.Text;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal static class SafeReadContract
    {
        public const string ProductId = "aafaa2c0-43f1-42a0-a6b4-d9a0c5f5ce0e";
        public const string DiscoverySchema = "revit-operator.safe-read.instance.v1";
        public const string RouteId = "safe_read.sheet_count.v1";
        public const string Method = "POST";
        public const string Route = "/revit/certified/sheets/count";
        public const string RequestSchema = "revit-operator.safe-read.sheets-count.request.v1";
        public const string RequestJson = "{\"schema\":\"revit-operator.safe-read.sheets-count.request.v1\"}";
        public const string ResponseSchema = "revit-operator.safe-read.sheets-count.response.v1";
        public const string FailureSchema = "revit-operator.safe-read.failure.v1";
        public const string ExecutorId = "revit-operator.safe-read-certified-execution.v1";
        public const string RuntimeAttestationSchema = "revit-operator.safe-read-runtime-attestation.v1";
        public const string PreauthorizationSchema = "revit-operator.safe-read-preauthorization-request.v1";
        public const string PreauthorizationResponseSchema = "revit-operator.safe-read-preauthorization-response.v1";
        public const string FinalAuthorizationSchema = "revit-operator.safe-read-final-authorization-request.v1";
        public const string FinalReceiptSchema = "revit-operator.safe-read-final-authorization-receipt.v1";
        public const string PreauthorizationPath = "/api/safe-read/direct/preauthorize";
        public const string FinalAuthorizationPath = "/api/safe-read/direct/authorize-execution";
        public const string TokenHeader = "X-RevitOperator-SafeRead-Token";
        public const string HostInstanceHeader = "X-RevitOperator-SafeRead-HostInstance";
        public const string DocumentSessionHeader = "X-RevitOperator-SafeRead-DocumentSession";
        public const string ClientSessionHeader = "X-RevitOperator-SafeRead-ClientSession";
        public const string RequestIdHeader = "X-RevitOperator-SafeRead-RequestId";
        public const string AttemptIdHeader = "X-RevitOperator-SafeRead-AttemptId";
        public const string HeaderPrefix = "X-RevitOperator-SafeRead-";
        public const int MinimumPort = 5040;
        public const int MaximumPort = 5050;
        public const int MaximumResponseBytes = 4096;
        public const int MaximumBackendResponseBytes = 65536;
        public static readonly TimeSpan RequestDeadline = TimeSpan.FromSeconds(10);
        public static readonly byte[] RequestBytes = new UTF8Encoding(false).GetBytes(RequestJson);
        public static bool IsRequiredHeader(string name) => String.Equals(name,TokenHeader,StringComparison.OrdinalIgnoreCase)||String.Equals(name,HostInstanceHeader,StringComparison.OrdinalIgnoreCase)||String.Equals(name,DocumentSessionHeader,StringComparison.OrdinalIgnoreCase)||String.Equals(name,ClientSessionHeader,StringComparison.OrdinalIgnoreCase)||String.Equals(name,RequestIdHeader,StringComparison.OrdinalIgnoreCase)||String.Equals(name,AttemptIdHeader,StringComparison.OrdinalIgnoreCase);
    }
}

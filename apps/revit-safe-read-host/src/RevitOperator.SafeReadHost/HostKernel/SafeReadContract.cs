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
        public const string BodySha256 = "sha256:3365135151daf7e1cf9b20c5a3b49a2b5b3b0e42eab9a73a404739a7cdad65d5";
        public const string RequestHash = "sha256:106a5e8cbfce57eb12d94757eb052e660ffc222855ea1b77548b6865d8f769e1";
        public const string EffectHash = "sha256:82669f8c2d957b0bbce5bfa5f7846ef1b7b0f46d9818aec41fbbc4c03de001dc";
        public const string RouteContractSha256 = "sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874";
        public const string PolicySha256 = "sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67";
        public const string ResponseSchema = "revit-operator.safe-read.sheets-count.response.v1";
        public const string FailureSchema = "revit-operator.safe-read.failure.v1";
        public const string ExecutorId = "revit-operator.safe-read-host.v1";
        public const string RuntimeAttestationSchema = "revit-operator.safe-read-runtime-attestation.v1";
        public const string PreauthorizationSchema = "revit-operator.safe-read-preauthorization-request.v1";
        public const string PreauthorizationResponseSchema = "revit-operator.safe-read-preauthorization-response.v1";
        public const string FinalAuthorizationSchema = "revit-operator.safe-read-final-authorization-request.v1";
        public const string FinalReceiptSchema = "revit-operator.safe-read-final-authorization-receipt.v1";
        public const string PreauthorizationPath = "/api/safe-read/direct/preauthorize";
        public const string FinalAuthorizationPath = "/api/safe-read/direct/authorize-execution";
        public const string TokenHeader = "X-RevitOperator-SafeRead-Startup-Token";
        public const string HostInstanceHeader = "X-RevitOperator-SafeRead-Host-Instance-Id";
        public const string DocumentSessionHeader = "X-RevitOperator-SafeRead-Document-Session-Id";
        public const string ClientSessionHeader = "X-RevitOperator-SafeRead-Client-Session-Id";
        public const string RequestIdHeader = "X-RevitOperator-SafeRead-Request-Id";
        public const string AttemptIdHeader = "X-RevitOperator-SafeRead-Attempt-Id";
        public const string HeaderPrefix = "X-RevitOperator-SafeRead-";
        public const int MinimumPort = 5040;
        public const int MaximumPort = 5050;
        public const int MaximumResponseBytes = 4096;
        public const int MaximumBackendResponseBytes = 65536;
        public static readonly TimeSpan RequestDeadline = TimeSpan.FromSeconds(10);
        public static readonly TimeSpan AuthorizationDeadline = TimeSpan.FromSeconds(3);
        public static readonly TimeSpan ExternalEventDeadline = TimeSpan.FromSeconds(3);
        public static readonly byte[] RequestBytes = new UTF8Encoding(false).GetBytes(RequestJson);
        public static bool IsRequiredHeader(string name) => String.Equals(name,TokenHeader,StringComparison.OrdinalIgnoreCase)||String.Equals(name,HostInstanceHeader,StringComparison.OrdinalIgnoreCase)||String.Equals(name,DocumentSessionHeader,StringComparison.OrdinalIgnoreCase)||String.Equals(name,ClientSessionHeader,StringComparison.OrdinalIgnoreCase)||String.Equals(name,RequestIdHeader,StringComparison.OrdinalIgnoreCase)||String.Equals(name,AttemptIdHeader,StringComparison.OrdinalIgnoreCase);
    }
}

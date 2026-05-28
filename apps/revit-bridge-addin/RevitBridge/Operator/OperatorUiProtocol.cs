using System.Text.Json;

namespace RevitBridge.Operator
{
    public static class OperatorUiProtocol
    {
        public const string Version = "operator.ui.v1";

        public static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true,
            WriteIndented = false
        };
    }
}

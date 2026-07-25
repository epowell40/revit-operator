using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Operator;

namespace RevitBridge.Handlers
{
    public sealed class NativeApiCatalogHandler : IRequestHandler
    {
        private sealed class Params
        {
            public string? query { get; set; }
            public string? namespacePrefix { get; set; }
            public string? typeContains { get; set; }
            public string? risk { get; set; }
            public int? offset { get; set; }
            public int? limit { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData, OperatorUiProtocol.JsonOptions) ?? new Params());
            var result = OperatorNativeApiGateway.GetCatalog(p.query, p.namespacePrefix, p.typeContains, p.risk, p.offset ?? 0, p.limit ?? 80);
            return Task.FromResult(result);
        }
    }

    public sealed class NativeApiSearchHandler : IRequestHandler
    {
        private sealed class Params
        {
            public string? query { get; set; }
            public string? namespacePrefix { get; set; }
            public string? risk { get; set; }
            public int? max { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData, OperatorUiProtocol.JsonOptions) ?? new Params());
            var result = OperatorNativeApiGateway.Search(p.query ?? "", p.namespacePrefix, p.risk, p.max ?? 20);
            return Task.FromResult(result);
        }
    }

    public sealed class NativeApiCallHandler : IRequestHandler
    {
        private sealed class Params
        {
            public string? memberId { get; set; }
            public string? target { get; set; }
            public JsonElement? args { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData, OperatorUiProtocol.JsonOptions) ?? new Params());
            if (string.IsNullOrWhiteSpace(p.memberId))
            {
                throw new InvalidOperationException("native-api-call.memberId is required.");
            }
            var result = OperatorNativeApiGateway.Invoke(app, p.memberId!, p.target, p.args, p.dryRun ?? false);
            return Task.FromResult(result);
        }
    }

    public sealed class NativeApiOpsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            return Task.FromResult(OperatorNativeApiGateway.InvokeReadOnlyOperations(app, jsonData));
        }
    }

    public sealed class NativeApiPolicyHandler : IRequestHandler
    {
        private sealed class Params
        {
            public string? profile { get; set; }
            public string? maxRisk { get; set; }
            public bool? allowMutating { get; set; }
            public bool? blockFreezeRisk { get; set; }
            public int? maxResults { get; set; }
            public int? maxInvocationParams { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            if (string.IsNullOrWhiteSpace(jsonData))
            {
                return Task.FromResult(OperatorNativeApiPolicy.GetStatus());
            }
            var p = JsonSerializer.Deserialize<Params>(jsonData, OperatorUiProtocol.JsonOptions) ?? new Params();
            var result = OperatorNativeApiPolicy.SetPolicy(p.profile, p.maxRisk, p.allowMutating, p.blockFreezeRisk, p.maxResults, p.maxInvocationParams);
            return Task.FromResult(result);
        }
    }
}

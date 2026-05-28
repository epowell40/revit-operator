using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Operator;

namespace RevitBridge.Handlers
{
    public sealed class ToolRegistryHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            return Task.FromResult<object>(OperatorToolIntrospection.GetRegistry());
        }
    }

    public sealed class ToolDocHandler : IRequestHandler
    {
        private sealed class Params
        {
            public string? method { get; set; }
            public string? path { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData, OperatorUiProtocol.JsonOptions) ?? new Params());
            var method = (p.method ?? "").Trim();
            var path = (p.path ?? "").Trim();
            if (string.IsNullOrWhiteSpace(method)) throw new InvalidOperationException("tool-doc.method is required.");
            if (string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("tool-doc.path is required.");

            return Task.FromResult<object>(OperatorToolIntrospection.GetToolDoc(method, path));
        }
    }

    public sealed class ToolSearchHandler : IRequestHandler
    {
        private sealed class Params
        {
            public string? query { get; set; }
            public string? group { get; set; }
            public string? risk { get; set; }
            public string? method { get; set; }
            public int? max { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData, OperatorUiProtocol.JsonOptions) ?? new Params());
            var query = (p.query ?? "").Trim();
            if (string.IsNullOrWhiteSpace(query)) throw new InvalidOperationException("tool-search.query is required.");

            return Task.FromResult<object>(OperatorToolIntrospection.SearchTools(query, p.group, p.risk, p.method, p.max));
        }
    }

    public sealed class ToolExamplesHandler : IRequestHandler
    {
        private sealed class Params
        {
            public string? method { get; set; }
            public string? path { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData, OperatorUiProtocol.JsonOptions) ?? new Params());
            var method = (p.method ?? "").Trim();
            var path = (p.path ?? "").Trim();
            if (string.IsNullOrWhiteSpace(method)) throw new InvalidOperationException("tool-examples.method is required.");
            if (string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("tool-examples.path is required.");

            return Task.FromResult<object>(OperatorToolIntrospection.GetToolExamples(method, path));
        }
    }
}


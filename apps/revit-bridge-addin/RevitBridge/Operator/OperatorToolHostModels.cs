using System;
using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Operator
{
    internal static class OperatorToolHostProtocol
    {
        public const string Version = "operator.toolhost.v1";
        public const string BuildStamp = "20260308a";
        public const int DefaultMaxRequestsPerWindow = 24;
        public static readonly TimeSpan DefaultRequestWindow = TimeSpan.FromSeconds(10);
    }

    internal sealed class OperatorToolHostOpenRequest
    {
        public string Url { get; set; } = "";
        public string Mode { get; set; } = "pane";
        public string? Title { get; set; }
        public int? Width { get; set; }
        public int? Height { get; set; }
        public List<string>? AllowedMessageTypes { get; set; }
        public List<OperatorToolHostActionSpec>? AllowedActions { get; set; }
        public List<string>? AllowedBackendPaths { get; set; }
        public JsonElement? InitialPayload { get; set; }
    }

    internal sealed class OperatorToolHostActionSpec
    {
        public string Method { get; set; } = "";
        public string Path { get; set; } = "";
    }

    internal sealed class OperatorToolHostEnvelope
    {
        public string Version { get; set; } = OperatorToolHostProtocol.Version;
        public string Id { get; set; } = "";
        public string Type { get; set; } = "";
        public JsonElement Payload { get; set; }
    }

    internal sealed class OperatorToolHostResponse
    {
        public string Version { get; set; } = OperatorToolHostProtocol.Version;
        public string Id { get; set; } = "";
        public string Type { get; set; } = "";
        public bool Ok { get; set; }
        public object? Payload { get; set; }
        public string? Error { get; set; }
    }

    internal sealed class OperatorToolHostSession
    {
        private readonly object _gate = new object();
        private readonly Queue<DateTime> _recentRequestsUtc = new Queue<DateTime>();
        private readonly HashSet<string> _allowedMessageTypes;
        private readonly HashSet<string> _allowedActionKeys;
        private readonly List<string> _allowedBackendPaths;

        public OperatorToolHostSession(OperatorToolHostOpenRequest request, Uri url)
        {
            Id = Guid.NewGuid().ToString("N");
            Url = url;
            Mode = NormalizeMode(request.Mode);
            Title = string.IsNullOrWhiteSpace(request.Title) ? "Tool UI" : request.Title!.Trim();
            Width = ClampDimension(request.Width, fallback: 960);
            Height = ClampDimension(request.Height, fallback: 720);
            InitialPayload = request.InitialPayload.HasValue ? request.InitialPayload.Value.Clone() : (JsonElement?)null;

            _allowedMessageTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var raw in request.AllowedMessageTypes ?? new List<string>())
            {
                var value = (raw ?? "").Trim();
                if (value.Length > 0) _allowedMessageTypes.Add(value);
            }

            _allowedActionKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var spec in request.AllowedActions ?? new List<OperatorToolHostActionSpec>())
            {
                var method = (spec?.Method ?? "").Trim().ToUpperInvariant();
                var path = (spec?.Path ?? "").Trim();
                if (method.Length == 0 || path.Length == 0) continue;
                _allowedActionKeys.Add(BuildActionKey(method, path));
            }

            _allowedBackendPaths = new List<string>();
            foreach (var raw in request.AllowedBackendPaths ?? new List<string>())
            {
                var value = NormalizeBackendPath(raw);
                if (!string.IsNullOrWhiteSpace(value)) _allowedBackendPaths.Add(value);
            }
        }

        public string Id { get; }
        public Uri Url { get; }
        public string Mode { get; }
        public string Title { get; }
        public int Width { get; }
        public int Height { get; }
        public JsonElement? InitialPayload { get; }

        public object ToInitPayload()
        {
            return new
            {
                sessionId = Id,
                hostBuild = OperatorToolHostProtocol.BuildStamp,
                title = Title,
                mode = Mode,
                url = Url.ToString(),
                initialPayload = InitialPayload,
                permissions = new
                {
                    messageTypes = _allowedMessageTypes,
                    actions = _allowedActionKeys,
                    backendPaths = _allowedBackendPaths
                }
            };
        }

        public bool AllowsMessageType(string type)
        {
            if (string.Equals(type, "host.close", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(type, "host.ping", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(type, "host.getInitPayload", StringComparison.OrdinalIgnoreCase)) return true;
            if (_allowedMessageTypes.Count == 0) return false;
            return _allowedMessageTypes.Contains((type ?? "").Trim());
        }

        public bool AllowsAction(string method, string path)
        {
            if (_allowedActionKeys.Count == 0) return false;
            return _allowedActionKeys.Contains(BuildActionKey(method, path));
        }

        public bool AllowsBackendPath(string path)
        {
            var normalized = NormalizeBackendPath(path);
            if (string.IsNullOrWhiteSpace(normalized) || _allowedBackendPaths.Count == 0) return false;

            foreach (var allowed in _allowedBackendPaths)
            {
                if (allowed.EndsWith("*", StringComparison.Ordinal))
                {
                    var prefix = allowed.Substring(0, allowed.Length - 1);
                    if (normalized.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
                    continue;
                }

                if (string.Equals(normalized, allowed, StringComparison.OrdinalIgnoreCase)) return true;
            }

            return false;
        }

        public bool TryConsumeRequest()
        {
            var now = DateTime.UtcNow;
            lock (_gate)
            {
                while (_recentRequestsUtc.Count > 0 && now - _recentRequestsUtc.Peek() > OperatorToolHostProtocol.DefaultRequestWindow)
                    _recentRequestsUtc.Dequeue();

                if (_recentRequestsUtc.Count >= OperatorToolHostProtocol.DefaultMaxRequestsPerWindow)
                    return false;

                _recentRequestsUtc.Enqueue(now);
                return true;
            }
        }

        private static string NormalizeMode(string? raw)
        {
            return string.Equals((raw ?? "").Trim(), "popup", StringComparison.OrdinalIgnoreCase)
                ? "popup"
                : "pane";
        }

        private static int ClampDimension(int? raw, int fallback)
        {
            if (!raw.HasValue) return fallback;
            var value = raw.Value;
            if (value < 320) value = 320;
            if (value > 2200) value = 2200;
            return value;
        }

        private static string BuildActionKey(string method, string path)
        {
            return ((method ?? "").Trim().ToUpperInvariant()) + " " + ((path ?? "").Trim());
        }

        private static string NormalizeBackendPath(string? raw)
        {
            var value = (raw ?? "").Trim();
            if (value.Length == 0) return "";
            if (Uri.TryCreate(value, UriKind.Absolute, out _)) return "";
            if (!value.StartsWith("/", StringComparison.Ordinal)) value = "/" + value;
            return value;
        }
    }
}

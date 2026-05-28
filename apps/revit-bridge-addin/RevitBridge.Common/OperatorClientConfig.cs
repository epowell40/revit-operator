using System;
using System.IO;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class OperatorClientConfigData
    {
        public string? backend_url { get; set; }
        public string? operator_token { get; set; }
        public bool? backend_autostart { get; set; }

    }

    public static class OperatorClientConfig
    {
        private static readonly object _sync = new object();
        private static OperatorClientConfigData? _cached;
        private static DateTime _cachedAtUtc;

        public static OperatorClientConfigData Load()
        {
            lock (_sync)
            {
                // Keep reads cheap inside Revit: refresh at most once every 2 seconds.
                if (_cached != null && (DateTime.UtcNow - _cachedAtUtc).TotalSeconds < 2)
                {
                    return _cached;
                }

                _cached = LoadCore();
                _cachedAtUtc = DateTime.UtcNow;
                return _cached;
            }
        }

        public static string GetConfigPath()
        {
            var fromEnv = Environment.GetEnvironmentVariable("OPERATOR_CLIENT_CONFIG_PATH");
            if (!string.IsNullOrWhiteSpace(fromEnv)) return fromEnv.Trim();
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(localAppData, "RevitOperator", "config", "operator-client.json");
        }

        public static string GetConfigDirectoryPath()
        {
            var cfgPath = GetConfigPath();
            var dir = Path.GetDirectoryName(cfgPath);
            if (!string.IsNullOrWhiteSpace(dir)) return dir;

            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(localAppData, "RevitOperator", "config");
        }

        private static OperatorClientConfigData LoadCore()
        {
            try
            {
                var path = GetConfigPath();
                if (!File.Exists(path)) return new OperatorClientConfigData();
                var raw = File.ReadAllText(path);
                if (string.IsNullOrWhiteSpace(raw)) return new OperatorClientConfigData();
                var parsed = JsonSerializer.Deserialize<OperatorClientConfigData>(raw, new JsonSerializerOptions
                {
                    AllowTrailingCommas = true,
                    ReadCommentHandling = JsonCommentHandling.Skip
                });
                return parsed ?? new OperatorClientConfigData();
            }
            catch
            {
                return new OperatorClientConfigData();
            }
        }
    }
}

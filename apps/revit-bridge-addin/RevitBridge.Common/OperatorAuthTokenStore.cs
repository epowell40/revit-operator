using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class OperatorAuthTokenSet
    {
        public string? AccessToken { get; set; }
        public string? RefreshToken { get; set; }
        public DateTime? AccessTokenExpiresAtUtc { get; set; }
        public DateTime? RefreshTokenExpiresAtUtc { get; set; }
        public DateTime? LastRefreshUtc { get; set; }
        public string? UserId { get; set; }
        public string? Email { get; set; }
        public string? Issuer { get; set; }
        public string? Audience { get; set; }
    }

    public static class OperatorAuthTokenStore
    {
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("RevitOperator.Auth.v1");

        public static string GetStorePath()
        {
            var fromEnv = Environment.GetEnvironmentVariable("OPERATOR_CLIENT_AUTH_STORE_PATH");
            if (!string.IsNullOrWhiteSpace(fromEnv)) return fromEnv.Trim();

            var dir = OperatorClientConfig.GetConfigDirectoryPath();
            return Path.Combine(dir, "operator-auth-tokens.bin");
        }

        public static OperatorAuthTokenSet? TryLoad()
        {
            return TryLoadFromPath(GetStorePath());
        }

        public static bool Save(OperatorAuthTokenSet tokens)
        {
            return SaveToPath(GetStorePath(), tokens);
        }

        public static void Clear()
        {
            ClearPath(GetStorePath());
        }

        public static OperatorAuthTokenSet? TryLoadFromPath(string path)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
                var protectedBytes = File.ReadAllBytes(path);
                if (protectedBytes == null || protectedBytes.Length == 0) return null;

                var plainBytes = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.CurrentUser);
                var json = Encoding.UTF8.GetString(plainBytes ?? Array.Empty<byte>());
                if (string.IsNullOrWhiteSpace(json)) return null;

                return JsonSerializer.Deserialize<OperatorAuthTokenSet>(json, new JsonSerializerOptions
                {
                    AllowTrailingCommas = true,
                    ReadCommentHandling = JsonCommentHandling.Skip
                });
            }
            catch
            {
                return null;
            }
        }

        public static bool SaveToPath(string path, OperatorAuthTokenSet tokens)
        {
            if (tokens == null) return false;

            try
            {
                var dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrWhiteSpace(dir)) Directory.CreateDirectory(dir);

                var json = JsonSerializer.Serialize(tokens);
                var plainBytes = Encoding.UTF8.GetBytes(json);
                var protectedBytes = ProtectedData.Protect(plainBytes, Entropy, DataProtectionScope.CurrentUser);
                File.WriteAllBytes(path, protectedBytes);
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static void ClearPath(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch
            {
                // ignore best-effort clear
            }
        }
    }
}

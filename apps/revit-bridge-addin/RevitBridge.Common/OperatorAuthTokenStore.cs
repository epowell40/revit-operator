using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

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

        private sealed class RefreshLease : IDisposable
        {
            private readonly string _path;
            private FileStream? _stream;

            public RefreshLease(string path, FileStream stream)
            {
                _path = path;
                _stream = stream;
            }

            public void Dispose()
            {
                var stream = Interlocked.Exchange(ref _stream, null);
                if (stream == null) return;

                try { stream.Dispose(); } catch { }
                try { if (File.Exists(_path)) File.Delete(_path); } catch { }
            }
        }

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

        public static OperatorAuthTokenSet? PreferPersistedSnapshot(
            OperatorAuthTokenSet? current,
            OperatorAuthTokenSet? persisted)
        {
            if (persisted == null || string.IsNullOrWhiteSpace(persisted.RefreshToken)) return current;
            if (current == null || string.IsNullOrWhiteSpace(current.RefreshToken)) return persisted;
            if (!string.Equals(current.RefreshToken, persisted.RefreshToken, StringComparison.Ordinal)) return persisted;
            if (persisted.LastRefreshUtc.HasValue &&
                (!current.LastRefreshUtc.HasValue || persisted.LastRefreshUtc.Value > current.LastRefreshUtc.Value))
            {
                return persisted;
            }

            return current;
        }

        public static bool Save(OperatorAuthTokenSet tokens)
        {
            return SaveToPath(GetStorePath(), tokens);
        }

        public static void Clear()
        {
            ClearPath(GetStorePath());
        }

        public static Task<IDisposable> AcquireRefreshLeaseAsync(CancellationToken cancellationToken)
        {
            return AcquireRefreshLeaseAtPathAsync(
                GetStorePath() + ".refresh.lock",
                timeoutMilliseconds: 15_000,
                staleAfterMilliseconds: 60_000,
                cancellationToken);
        }

        public static async Task<IDisposable> AcquireRefreshLeaseAtPathAsync(
            string lockPath,
            int timeoutMilliseconds,
            int staleAfterMilliseconds,
            CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(lockPath)) throw new ArgumentException("Refresh lock path is required.", nameof(lockPath));
            if (timeoutMilliseconds <= 0) throw new ArgumentOutOfRangeException(nameof(timeoutMilliseconds));
            if (staleAfterMilliseconds <= 0) throw new ArgumentOutOfRangeException(nameof(staleAfterMilliseconds));

            var dir = Path.GetDirectoryName(lockPath);
            if (!string.IsNullOrWhiteSpace(dir)) Directory.CreateDirectory(dir);

            var started = DateTime.UtcNow;
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    var stream = new FileStream(lockPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
                    return new RefreshLease(lockPath, stream);
                }
                catch (IOException)
                {
                    try
                    {
                        if (File.Exists(lockPath) &&
                            DateTime.UtcNow - File.GetLastWriteTimeUtc(lockPath) > TimeSpan.FromMilliseconds(staleAfterMilliseconds))
                        {
                            File.Delete(lockPath);
                            continue;
                        }
                    }
                    catch
                    {
                        // The current owner may still hold the file. Retry until timeout.
                    }
                }

                if (DateTime.UtcNow - started >= TimeSpan.FromMilliseconds(timeoutMilliseconds))
                    throw new TimeoutException("Timed out waiting for the shared Operator authentication refresh lease.");

                await Task.Delay(100, cancellationToken).ConfigureAwait(false);
            }
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

using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RevitBridge.Common
{
    public enum OperatorWriteGrantMode
    {
        Once = 0,
        Session = 1,
        Yolo = 2
    }

    public sealed class OperatorWriteGrantStatus
    {
        public bool Active { get; set; }
        public string Mode { get; set; } = "none";
        public string Token { get; set; } = "";
        public DateTime? ExpiresAtUtc { get; set; }
        public int? UsesRemaining { get; set; }
        public string? Error { get; set; }
    }

    public static class OperatorWriteGrant
    {
        private static readonly object _lock = new object();
        private static readonly byte[] _hmacKey;

        static OperatorWriteGrant()
        {
            _hmacKey = new byte[32];
            try
            {
                // Stable per-workspace key to avoid "signature mismatch" after restarting Revit.
                // Security model: this is a local-only consent gate to prevent accidental writes, not a remote attacker model.
                var token = OperatorSecurity.GetOrCreateOperatorToken() ?? "";
                using (var sha = SHA256.Create())
                {
                    var seed = Encoding.UTF8.GetBytes("write_grant|" + token);
                    var hash = sha.ComputeHash(seed);
                    Array.Copy(hash, 0, _hmacKey, 0, Math.Min(_hmacKey.Length, hash.Length));
                }
            }
            catch
            {
                // ignore
            }
        }

        private static string GetGrantFilePath()
        {
            var root = WorkspacePaths.GetWorkspaceRoot();
            return Path.Combine(root, "write_grant.json");
        }

        private static string ModeToString(OperatorWriteGrantMode mode)
        {
            if (mode == OperatorWriteGrantMode.Session) return "session";
            if (mode == OperatorWriteGrantMode.Yolo) return "yolo";
            return "once";
        }

        private static OperatorWriteGrantMode StringToMode(string? mode)
        {
            var m = (mode ?? "").Trim().ToLowerInvariant();
            if (m == "session") return OperatorWriteGrantMode.Session;
            if (m == "yolo") return OperatorWriteGrantMode.Yolo;
            return OperatorWriteGrantMode.Once;
        }

        private sealed class GrantFile
        {
            public int version { get; set; } = 1;
            public string token { get; set; } = "";
            public string mode { get; set; } = "once";
            public string issued_at_utc { get; set; } = "";
            public string expires_at_utc { get; set; } = "";
            public int? uses_remaining { get; set; }
            public string sig { get; set; } = "";
        }

        private static string ComputeSignature(GrantFile f)
        {
            var payload = $"{f.version}|{f.token}|{f.mode}|{f.issued_at_utc}|{f.expires_at_utc}|{(f.uses_remaining.HasValue ? f.uses_remaining.Value.ToString() : "")}";
            using (var h = new HMACSHA256(_hmacKey))
            {
                var bytes = Encoding.UTF8.GetBytes(payload);
                var hash = h.ComputeHash(bytes);
                return Convert.ToBase64String(hash);
            }
        }

        public static OperatorWriteGrantStatus Issue(OperatorWriteGrantMode mode, TimeSpan ttl)
        {
            lock (_lock)
            {
                var now = DateTime.UtcNow;
                var token = Guid.NewGuid().ToString("N");
                var expires = now.Add(ttl);

                var f = new GrantFile
                {
                    version = 1,
                    token = token,
                    mode = ModeToString(mode),
                    issued_at_utc = now.ToString("o"),
                    expires_at_utc = expires.ToString("o"),
                    uses_remaining = mode == OperatorWriteGrantMode.Once ? 1 : (int?)null,
                };
                f.sig = ComputeSignature(f);

                var json = JsonSerializer.Serialize(f, new JsonSerializerOptions { WriteIndented = true });
                // Write without BOM so non-.NET consumers can JSON.parse reliably.
                try { File.WriteAllText(GetGrantFilePath(), json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)); } catch { /* ignore */ }

                return new OperatorWriteGrantStatus
                {
                    Active = true,
                    Mode = f.mode,
                    Token = token,
                    ExpiresAtUtc = expires,
                    UsesRemaining = f.uses_remaining
                };
            }
        }

        public static void Clear()
        {
            lock (_lock)
            {
                try
                {
                    var p = GetGrantFilePath();
                    if (File.Exists(p)) File.Delete(p);
                }
                catch
                {
                    // ignore
                }
            }
        }

        public static OperatorWriteGrantStatus ReadStatus()
        {
            lock (_lock)
            {
                try
                {
                    var p = GetGrantFilePath();
                    if (!File.Exists(p)) return new OperatorWriteGrantStatus { Active = false };

                    var raw = File.ReadAllText(p, Encoding.UTF8) ?? "";
                    var f = JsonSerializer.Deserialize<GrantFile>(raw);
                    if (f == null) return new OperatorWriteGrantStatus { Active = false, Error = "Invalid write grant file." };

                    if (string.IsNullOrWhiteSpace(f.token) || string.IsNullOrWhiteSpace(f.sig))
                        return new OperatorWriteGrantStatus { Active = false, Error = "Write grant file missing fields." };

                    var expected = ComputeSignature(f);
                    if (!string.Equals(expected, f.sig, StringComparison.Ordinal))
                        return new OperatorWriteGrantStatus { Active = false, Error = "Write grant signature mismatch." };

                    if (!DateTimeOffset.TryParse(f.expires_at_utc, out var expiresAtOffset))
                        return new OperatorWriteGrantStatus { Active = false, Error = "Write grant expiry invalid." };

                    var expiresAtUtc = expiresAtOffset.UtcDateTime;
                    if (DateTime.UtcNow > expiresAtUtc)
                        return new OperatorWriteGrantStatus { Active = false, Error = "Write grant expired." };

                    return new OperatorWriteGrantStatus
                    {
                        Active = true,
                        Mode = f.mode,
                        Token = f.token,
                        ExpiresAtUtc = expiresAtUtc,
                        UsesRemaining = f.uses_remaining
                    };
                }
                catch (Exception ex)
                {
                    return new OperatorWriteGrantStatus { Active = false, Error = ex.Message };
                }
            }
        }

        public static bool ValidateAndConsumeIfNeeded(string? providedToken, out string error)
        {
            error = "";
            lock (_lock)
            {
                var status = ReadStatus();
                if (!status.Active)
                {
                    error = string.IsNullOrWhiteSpace(status.Error) ? "Missing/invalid write grant." : status.Error!;
                    return false;
                }

                var got = (providedToken ?? "").Trim();
                if (string.IsNullOrWhiteSpace(got))
                {
                    error = "Missing X-Operator-Write-Grant.";
                    return false;
                }
                if (!string.Equals(got, status.Token, StringComparison.Ordinal))
                {
                    error = "Invalid X-Operator-Write-Grant.";
                    return false;
                }

                if (string.Equals(status.Mode, "once", StringComparison.OrdinalIgnoreCase))
                {
                    // Consume (single use) by clearing file.
                    Clear();
                }

                return true;
            }
        }
    }
}

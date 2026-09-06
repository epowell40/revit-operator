using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;

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
        private static readonly Lazy<OperatorWriteGrantStore> Store = new Lazy<OperatorWriteGrantStore>(() =>
            new OperatorWriteGrantStore(Path.Combine(WorkspacePaths.GetWorkspaceRoot(), "write_grant.json"),
                OperatorSecurity.GetOrCreateOperatorToken()));

        public static OperatorWriteGrantStatus Issue(OperatorWriteGrantMode mode, TimeSpan ttl) => Store.Value.Issue(mode, ttl);
        public static OperatorWriteGrantStatus RenewSession(TimeSpan ttl) => Store.Value.RenewSession(ttl);
        public static OperatorWriteGrantStatus ReadStatus() => Store.Value.ReadStatus();
        public static void Clear() => Store.Value.Clear();
        public static bool ValidateAndConsumeIfNeeded(string? providedToken, out string error) =>
            Store.Value.ValidateAndConsumeIfNeeded(providedToken, out error);
    }

    // The same signed file is shared by the native pane, Sidecar and native HTTP
    // admission. An instance also allows executable tests with an isolated store.
    internal sealed class OperatorWriteGrantStore
    {
        private readonly object _lock = new object();
        private readonly byte[] _hmacKey;
        private readonly string _grantFilePath;
        private readonly Func<DateTime> _utcNow;

        internal OperatorWriteGrantStore(string grantFilePath, string operatorToken, Func<DateTime>? utcNow = null)
        {
            _grantFilePath = grantFilePath;
            _utcNow = utcNow ?? (() => DateTime.UtcNow);
            using var sha = SHA256.Create();
            _hmacKey = sha.ComputeHash(Encoding.UTF8.GetBytes("write_grant|" + operatorToken));
        }

        private string GetGrantFilePath() => _grantFilePath;

        private string ReadGrantFile()
        {
            // Windows replacement can briefly make the name unavailable while a
            // previous reader still holds the replaced file. Retry only the file
            // read, then validate the newly read signature and expiry normally.
            for (int attempt = 0; ; ++attempt)
            {
                try
                {
                    using var stream = new FileStream(GetGrantFilePath(), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    using var reader = new StreamReader(stream, Encoding.UTF8);
                    return reader.ReadToEnd();
                }
                catch (IOException) when (attempt < 4) { Thread.Sleep(5); }
            }
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

        private string ComputeSignature(GrantFile f)
        {
            var payload = $"{f.version}|{f.token}|{f.mode}|{f.issued_at_utc}|{f.expires_at_utc}|{(f.uses_remaining.HasValue ? f.uses_remaining.Value.ToString() : "")}";
            using (var h = new HMACSHA256(_hmacKey))
            {
                var bytes = Encoding.UTF8.GetBytes(payload);
                var hash = h.ComputeHash(bytes);
                return Convert.ToBase64String(hash);
            }
        }

        public OperatorWriteGrantStatus RenewSession(TimeSpan ttl) => IssueCore(OperatorWriteGrantMode.Session, ttl, true);

        public OperatorWriteGrantStatus Issue(OperatorWriteGrantMode mode, TimeSpan ttl) => IssueCore(mode, ttl, false);

        private OperatorWriteGrantStatus IssueCore(OperatorWriteGrantMode mode, TimeSpan ttl, bool renewActiveSession)
        {
            lock (_lock)
            {
                var now = _utcNow();
                var current = renewActiveSession ? ReadStatus() : null;
                // Renewing the same active consent must not revoke a header already
                // prepared by the other process. Explicit Issue always rotates.
                var token = current?.Active == true && current.Mode == "session" && current.UsesRemaining == null
                    ? current.Token : Guid.NewGuid().ToString("N");
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
                // Atomically publish a complete signed file to concurrent readers.
                // A persistence failure must not report an active grant.
                var target = GetGrantFilePath();
                var temporary = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    File.WriteAllText(temporary, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
                    if (File.Exists(target)) File.Replace(temporary, target, null);
                    else
                    {
                        try { File.Move(temporary, target); }
                        catch (IOException) when (File.Exists(target)) { File.Replace(temporary, target, null); }
                    }
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }

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

        public void Clear()
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

        public OperatorWriteGrantStatus ReadStatus()
        {
            lock (_lock)
            {
                try
                {
                    var raw = ReadGrantFile();
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
                    if (_utcNow() >= expiresAtUtc)
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

        public bool ValidateAndConsumeIfNeeded(string? providedToken, out string error)
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

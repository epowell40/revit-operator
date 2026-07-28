using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal static class OperatorDesktopLauncher
    {
        private const int LauncherObservationTimeoutMilliseconds = 30000;
        private const int PostExitLivenessTimeoutMilliseconds = 5000;
        private const int RuntimeIdentityDeadlineMilliseconds = 1500;
        private const int RuntimeIdentityMaxBytes = 4096;
        private static readonly OperatorDesktopLaunchFailureReceiptStore FailureReceipts = CreateFailureReceiptStore();
        private static readonly object LauncherPathSnapshotSync = new object();
        private static string? CachedLauncherPath;
        private static string LauncherPathDiscoveryError = "";
        private static bool LauncherPathPreloadComplete;
        private static int LauncherPathRefreshQueued;

        static OperatorDesktopLauncher()
        {
            RequestLauncherPathRefresh();
        }

        public static bool UseLegacyPane()
        {
            var mode = ReadSetting("OPERATOR_UI_MODE");
            if (string.Equals(mode, "pane", StringComparison.OrdinalIgnoreCase)
                || string.Equals(mode, "native", StringComparison.OrdinalIgnoreCase)
                || string.Equals(mode, "legacy", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return IsTruthy(ReadSetting("OPERATOR_USE_LEGACY_PANE"));
        }

        public static string? ResolveLauncherPath()
        {
            RequestLauncherPathRefresh();
            lock (LauncherPathSnapshotSync) return CachedLauncherPath;
        }

        internal static string? ResolveLauncherPath(
            string configuredLauncherPath,
            string localApplicationData,
            string desktopDirectory,
            string assemblyLocation,
            Func<string, bool> fileExists)
        {
            var candidates = OperatorDesktopLaunchPlan.BuildCandidatePaths(
                configuredLauncherPath,
                localApplicationData,
                desktopDirectory,
                OperatorDesktopLaunchPlan.GetAssemblyDirectory(assemblyLocation));
            return OperatorDesktopLaunchPlan.ResolveExistingLauncher(candidates, fileExists);
        }

        public static bool TryLaunch(out string detail)
        {
            RequestLauncherPathRefresh();
            string? launcherPath;
            string discoveryError;
            bool preloadComplete;
            lock (LauncherPathSnapshotSync)
            {
                launcherPath = CachedLauncherPath;
                discoveryError = LauncherPathDiscoveryError;
                preloadComplete = LauncherPathPreloadComplete;
            }
            if (!preloadComplete)
            {
                detail = "Operator Desktop launcher discovery is still loading in the background. Retry the command.";
                return false;
            }
            if (!string.IsNullOrWhiteSpace(discoveryError))
            {
                detail = "Operator Desktop launcher discovery failed in the background. " + discoveryError;
                return false;
            }
            return TryLaunch(
                launcherPath,
                new OperatorDesktopLaunchRuntime(
                    DispatchLauncher,
                    FailureReceipts),
                out detail);
        }

        private static void RequestLauncherPathRefresh()
        {
            if (Interlocked.Exchange(ref LauncherPathRefreshQueued, 1) != 0) return;
            _ = Task.Run(() =>
            {
                try
                {
                    var resolved = ResolveLauncherPath(
                        ReadSetting("OPERATOR_DESKTOP_LAUNCHER_PATH"),
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                        Assembly.GetExecutingAssembly().Location,
                        File.Exists);
                    lock (LauncherPathSnapshotSync)
                    {
                        CachedLauncherPath = resolved;
                        LauncherPathDiscoveryError = "";
                        LauncherPathPreloadComplete = true;
                    }
                }
                catch (Exception ex)
                {
                    lock (LauncherPathSnapshotSync)
                    {
                        CachedLauncherPath = null;
                        LauncherPathDiscoveryError = $"{ex.GetType().Name}: {ex.Message}";
                        LauncherPathPreloadComplete = true;
                    }
                }
                finally
                {
                    Interlocked.Exchange(ref LauncherPathRefreshQueued, 0);
                }
            });
        }

        internal static bool TryLaunch(
            string? launcherPath,
            OperatorDesktopLaunchRuntime runtime,
            out string detail)
        {
            try
            {
                if (!runtime.FailureReceipts.InitialRefreshComplete)
                {
                    detail = "Operator Desktop failure receipt preload is still loading in the background. Retry the command.";
                    return false;
                }

                runtime.FailureReceipts.RequestRefresh();
                if (runtime.FailureReceipts.TryTake(out var pendingFailure))
                {
                    detail = "A prior Operator Desktop launch requires attention. " + pendingFailure;
                    return false;
                }

                if (!string.IsNullOrWhiteSpace(launcherPath))
                {
                    var selectedLauncherPath = launcherPath!;
                    var dispatch = runtime.DispatchLauncher(selectedLauncherPath);
                    if (!dispatch.Accepted)
                    {
                        detail = $"Launcher could not be dispatched: {selectedLauncherPath}. {dispatch.Error}".Trim();
                        return false;
                    }

                    detail = $"Launcher dispatch accepted ({dispatch.LaunchId}): {selectedLauncherPath}. Sidecar readiness is not yet claimed; late failure will be reported once on the next Operator Desktop invocation.";
                    return true;
                }

                detail = "No Operator Desktop launcher was found. No inline liveness or browser I/O was attempted from Revit. "
                    + "Set OPERATOR_DESKTOP_LAUNCHER_PATH or install the workstation package.";
                return false;
            }
            catch (Exception ex)
            {
                detail = $"{ex.GetType().Name}: {ex.Message}";
                return false;
            }
        }

        private static OperatorDesktopDispatchResult DispatchLauncher(string launcherPath)
        {
            try
            {
                var launchId = Guid.NewGuid().ToString("N");
                var process = Process.Start(BuildLauncherStartInfo(launcherPath));
                if (process == null)
                {
                    return OperatorDesktopDispatchResult.Rejected("Windows did not return a launcher process handle.");
                }

                _ = Task.Run(() => ObserveLauncherProcess(process, launcherPath, launchId));
                return OperatorDesktopDispatchResult.DispatchAccepted(launchId);
            }
            catch (Exception ex)
            {
                return OperatorDesktopDispatchResult.Rejected($"{ex.GetType().Name}: {ex.Message}");
            }
        }

        internal static ProcessStartInfo BuildLauncherStartInfo(
            string launcherPath,
            string? powershellPath = null,
            string? commandInterpreterPath = null)
        {
            var workingDirectory = Path.GetDirectoryName(launcherPath) ?? "";
            var extension = Path.GetExtension(launcherPath);
            if (string.Equals(extension, ".ps1", StringComparison.OrdinalIgnoreCase))
            {
                var executable = powershellPath ?? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "WindowsPowerShell",
                    "v1.0",
                    "powershell.exe");
                return new ProcessStartInfo
                {
                    FileName = executable,
                    Arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{launcherPath}\"",
                    WorkingDirectory = workingDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
            }

            if (string.Equals(extension, ".cmd", StringComparison.OrdinalIgnoreCase))
            {
                var executable = commandInterpreterPath
                    ?? Environment.GetEnvironmentVariable("ComSpec")
                    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
                return new ProcessStartInfo
                {
                    FileName = executable,
                    Arguments = $"/D /S /C \"\"{launcherPath}\"\"",
                    WorkingDirectory = workingDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
            }

            if (string.Equals(extension, ".lnk", StringComparison.OrdinalIgnoreCase))
            {
                return new ProcessStartInfo
                {
                    FileName = launcherPath,
                    WorkingDirectory = workingDirectory,
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
            }

            throw new NotSupportedException($"Unsupported Operator Desktop launcher extension '{extension}'. Use .ps1, .cmd, or .lnk.");
        }

        internal static string? GetObservedLaunchFailure(
            string launcherPath,
            bool exited,
            int exitCode,
            bool sidecarLive)
        {
            if (!exited && !sidecarLive)
            {
                return $"Launcher did not prove Sidecar liveness within {LauncherObservationTimeoutMilliseconds / 1000} seconds: {launcherPath}. The process was not stopped.";
            }
            if (exited && exitCode != 0)
            {
                return $"Launcher exited with code {exitCode}: {launcherPath}.";
            }
            if (exited && !sidecarLive)
            {
                return $"Launcher exited successfully, but Sidecar liveness was not observed: {launcherPath}.";
            }
            return null;
        }

        private static void ObserveLauncherProcess(Process process, string launcherPath, string launchId)
        {
            try
            {
                var exited = process.WaitForExit(LauncherObservationTimeoutMilliseconds);
                var exitCode = exited ? process.ExitCode : 0;
                var sidecarLive = exited
                    ? WaitForSidecarLiveness(PostExitLivenessTimeoutMilliseconds)
                    : IsSidecarLive(OperatorDesktopLaunchPlan.RuntimeIdentityUrl);
                var failure = GetObservedLaunchFailure(launcherPath, exited, exitCode, sidecarLive);
                if (failure != null) FailureReceipts.Record(failure, launchId);
            }
            catch (Exception ex)
            {
                FailureReceipts.Record(
                    $"Launcher observation failed for {launcherPath}: {ex.GetType().Name}: {ex.Message}",
                    launchId);
            }
            finally
            {
                process.Dispose();
            }
        }

        private static bool WaitForSidecarLiveness(int timeoutMilliseconds)
        {
            var stopwatch = Stopwatch.StartNew();
            do
            {
                if (IsSidecarLive(OperatorDesktopLaunchPlan.RuntimeIdentityUrl)) return true;
                Thread.Sleep(250);
            }
            while (stopwatch.ElapsedMilliseconds < timeoutMilliseconds);
            return false;
        }

        private static bool IsSidecarLive(string runtimeIdentityUrl)
        {
            try
            {
                return ProbeSidecarLivenessAsync(
                    runtimeIdentityUrl,
                    RuntimeIdentityDeadlineMilliseconds).GetAwaiter().GetResult();
            }
            catch
            {
                return false;
            }
        }

        private static async Task<bool> ProbeSidecarLivenessAsync(
            string runtimeIdentityUrl,
            int deadlineMilliseconds)
        {
            using var deadline = new CancellationTokenSource(deadlineMilliseconds);
            HttpWebRequest? request = null;
            try
            {
                request = WebRequest.CreateHttp(runtimeIdentityUrl);
                request.Method = "GET";
                request.AllowAutoRedirect = false;
                request.Proxy = null;
                request.Timeout = deadlineMilliseconds;
                request.ReadWriteTimeout = deadlineMilliseconds;
                using var abortRegistration = deadline.Token.Register(request.Abort);
                using var response = (HttpWebResponse)await request.GetResponseAsync().ConfigureAwait(false);
                if (response.StatusCode != HttpStatusCode.OK) return false;
                if (response.ContentLength > RuntimeIdentityMaxBytes) return false;
                if (!(response.ContentType ?? "").StartsWith("application/json", StringComparison.OrdinalIgnoreCase)) return false;
                using var stream = response.GetResponseStream();
                if (stream == null) return false;
                var body = await ReadBoundedResponseAsync(
                    stream,
                    RuntimeIdentityMaxBytes,
                    deadline.Token).ConfigureAwait(false);
                if (body == null) return false;
                using var document = JsonDocument.Parse(body);
                var root = document.RootElement;
                return root.TryGetProperty("ok", out var ok)
                    && ok.ValueKind == JsonValueKind.True
                    && root.TryGetProperty("sidecarRuntime", out var runtime)
                    && runtime.ValueKind == JsonValueKind.Object
                    && runtime.TryGetProperty("pid", out var pid)
                    && pid.ValueKind == JsonValueKind.Number
                    && pid.TryGetInt32(out var processId)
                    && processId > 0
                    && runtime.TryGetProperty("startedAt", out var startedAt)
                    && startedAt.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(startedAt.GetString())
                    && runtime.TryGetProperty("serverSourceSha256", out var sourceHash)
                    && sourceHash.ValueKind == JsonValueKind.String
                    && IsSha256(sourceHash.GetString());
            }
            catch
            {
                request?.Abort();
                return false;
            }
        }

        internal static async Task<string?> ReadBoundedResponseAsync(
            Stream stream,
            int maxBytes,
            CancellationToken cancellationToken)
        {
            var buffer = new byte[maxBytes + 1];
            var total = 0;
            while (total < buffer.Length)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var count = await stream.ReadAsync(
                    buffer,
                    total,
                    buffer.Length - total,
                    cancellationToken).ConfigureAwait(false);
                if (count == 0) break;
                total += count;
            }
            if (total > maxBytes) return null;
            return Encoding.UTF8.GetString(buffer, 0, total);
        }

        private static OperatorDesktopLaunchFailureReceiptStore CreateFailureReceiptStore()
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RevitOperator",
                "launch",
                "operator-desktop-failure.json");
            return new OperatorDesktopLaunchFailureReceiptStore(
                () =>
                {
                    if (!File.Exists(path)) return null;
                    var info = new FileInfo(path);
                    if (info.Length > OperatorDesktopLaunchFailureReceiptStore.MaximumEnvelopeBytes)
                    {
                        throw new OperatorDesktopReceiptOversizeException(info.Length);
                    }
                    return File.ReadAllText(path);
                },
                json =>
                {
                    var directory = Path.GetDirectoryName(path)!;
                    Directory.CreateDirectory(directory);
                    var temporaryPath = Path.Combine(
                        directory,
                        $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
                    try
                    {
                        File.WriteAllText(temporaryPath, json, new UTF8Encoding(false));
                        if (File.Exists(path)) File.Replace(temporaryPath, path, null, true);
                        else File.Move(temporaryPath, path);
                    }
                    finally
                    {
                        if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
                    }
                },
                reason =>
                {
                    if (!File.Exists(path)) return;
                    var directory = Path.GetDirectoryName(path)!;
                    var quarantinePath = Path.Combine(
                        directory,
                        $"operator-desktop-failure.quarantine.{DateTime.UtcNow:yyyyMMddHHmmss}.{Guid.NewGuid():N}.json");
                    File.Move(path, quarantinePath);
                },
                @"Local\RevitOperator.OperatorDesktopLaunchFailureReceipt.v2",
                $"{Process.GetCurrentProcess().Id}:{Guid.NewGuid():N}",
                () => DateTimeOffset.UtcNow,
                TimeSpan.FromHours(24));
        }

        private static bool IsSha256(string? value)
        {
            if (value == null || value.Length != 64) return false;
            foreach (var character in value)
            {
                var isHex = character >= '0' && character <= '9'
                    || character >= 'a' && character <= 'f'
                    || character >= 'A' && character <= 'F';
                if (!isHex) return false;
            }
            return true;
        }

        private static string ReadSetting(string name)
        {
            foreach (var target in new EnvironmentVariableTarget?[]
            {
                null,
                EnvironmentVariableTarget.User,
                EnvironmentVariableTarget.Machine
            })
            {
                try
                {
                    var value = target.HasValue
                        ? Environment.GetEnvironmentVariable(name, target.Value)
                        : Environment.GetEnvironmentVariable(name);
                    if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
                }
                catch { }
            }

            return "";
        }

        private static bool IsTruthy(string value)
        {
            return string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
                || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase)
                || string.Equals(value, "on", StringComparison.OrdinalIgnoreCase);
        }
    }

    internal sealed class OperatorDesktopLaunchRuntime
    {
        public OperatorDesktopLaunchRuntime(
            Func<string, OperatorDesktopDispatchResult> dispatchLauncher,
            OperatorDesktopLaunchFailureReceiptStore failureReceipts)
        {
            DispatchLauncher = dispatchLauncher ?? throw new ArgumentNullException(nameof(dispatchLauncher));
            FailureReceipts = failureReceipts ?? throw new ArgumentNullException(nameof(failureReceipts));
        }

        public Func<string, OperatorDesktopDispatchResult> DispatchLauncher { get; }
        public OperatorDesktopLaunchFailureReceiptStore FailureReceipts { get; }
    }

    internal readonly struct OperatorDesktopDispatchResult
    {
        private OperatorDesktopDispatchResult(bool accepted, string error, string launchId)
        {
            Accepted = accepted;
            Error = error;
            LaunchId = launchId;
        }

        public bool Accepted { get; }
        public string Error { get; }
        public string LaunchId { get; }

        public static OperatorDesktopDispatchResult DispatchAccepted(string launchId)
            => new OperatorDesktopDispatchResult(true, "", launchId ?? "");

        public static OperatorDesktopDispatchResult Rejected(string error)
            => new OperatorDesktopDispatchResult(false, error ?? "", "");
    }

    internal sealed class OperatorDesktopLaunchFailureReceiptStore
    {
        internal const int MaximumEnvelopeBytes = 8192;
        internal const int MaximumEnvelopeEntries = 32;
        private static readonly TimeSpan ClaimLease = TimeSpan.FromMinutes(5);
        private readonly Func<string?> _read;
        private readonly Action<string> _write;
        private readonly Action<string> _quarantine;
        private readonly string _mutexName;
        private readonly string _instanceId;
        private readonly Func<DateTimeOffset> _utcNow;
        private readonly TimeSpan _freshness;
        private readonly object _memorySync = new object();
        private readonly Queue<OperatorDesktopLaunchFailureSnapshot> _snapshots = new Queue<OperatorDesktopLaunchFailureSnapshot>();
        private readonly HashSet<string> _knownReceiptIds = new HashSet<string>(StringComparer.Ordinal);
        private readonly object _backgroundSync = new object();
        private Task _backgroundTask = Task.CompletedTask;
        private int _initialRefreshComplete;

        public OperatorDesktopLaunchFailureReceiptStore(
            Func<string?> read,
            Action<string> write,
            Action<string> quarantine,
            string mutexName,
            string instanceId,
            Func<DateTimeOffset> utcNow,
            TimeSpan freshness)
        {
            _read = read ?? throw new ArgumentNullException(nameof(read));
            _write = write ?? throw new ArgumentNullException(nameof(write));
            _quarantine = quarantine ?? throw new ArgumentNullException(nameof(quarantine));
            _mutexName = !string.IsNullOrWhiteSpace(mutexName) ? mutexName : throw new ArgumentException("Mutex name is required.", nameof(mutexName));
            _instanceId = !string.IsNullOrWhiteSpace(instanceId) ? instanceId : throw new ArgumentException("Instance id is required.", nameof(instanceId));
            _utcNow = utcNow ?? throw new ArgumentNullException(nameof(utcNow));
            _freshness = freshness > TimeSpan.Zero ? freshness : throw new ArgumentOutOfRangeException(nameof(freshness));
            QueueBackground(
                RefreshAndClaim,
                () => Volatile.Write(ref _initialRefreshComplete, 1));
        }

        public bool InitialRefreshComplete => Volatile.Read(ref _initialRefreshComplete) != 0;

        public void Record(string message, string? launchId = null)
        {
            var now = _utcNow();
            var receipt = new OperatorDesktopLaunchFailureReceipt
            {
                ReceiptId = Guid.NewGuid().ToString("N"),
                InstanceId = _instanceId,
                LaunchId = string.IsNullOrWhiteSpace(launchId) ? Guid.NewGuid().ToString("N") : Limit(launchId, 128),
                Message = Limit(message, 2048),
                ObservedAtUtc = now.ToString("O"),
                ClaimedByInstanceId = _instanceId,
                ClaimedAtUtc = now.ToString("O")
            };
            QueueBackground(() =>
            {
                WithMutex(() =>
                {
                    var envelope = ReadEnvelope();
                    RemoveExpired(envelope, _utcNow());
                    envelope.Receipts.Add(receipt);
                    Sort(envelope);
                    WriteBounded(envelope);
                    AddSnapshot(new[] { receipt });
                    return true;
                }, TimeSpan.FromSeconds(5));
            });
        }

        public bool TryTake(out string message)
        {
            message = "";
            OperatorDesktopLaunchFailureSnapshot? snapshot;
            lock (_memorySync)
            {
                if (_snapshots.Count == 0) return false;
                snapshot = _snapshots.Dequeue();
            }
            message = snapshot.Message;
            if (snapshot.ReceiptIds.Count > 0)
            {
                QueueBackground(() => CleanupClaimedReceipts(snapshot.ReceiptIds));
            }
            return true;
        }

        public void RequestRefresh() => QueueBackground(RefreshAndClaim);

        internal Task WaitForBackgroundIdleAsync()
        {
            lock (_backgroundSync) return _backgroundTask;
        }

        private void RefreshAndClaim()
        {
            WithMutex(() =>
            {
                var now = _utcNow();
                var envelope = ReadEnvelope();
                var changed = RemoveExpired(envelope, now);
                var claimed = new List<OperatorDesktopLaunchFailureReceipt>();
                foreach (var receipt in envelope.Receipts)
                {
                    if (string.IsNullOrWhiteSpace(receipt.Message)) continue;
                    var claimExpired = !DateTimeOffset.TryParse(receipt.ClaimedAtUtc, out var claimedAt)
                        || now - claimedAt > ClaimLease;
                    if (!string.IsNullOrWhiteSpace(receipt.ClaimedByInstanceId)
                        && !string.Equals(receipt.ClaimedByInstanceId, _instanceId, StringComparison.Ordinal)
                        && !claimExpired)
                    {
                        continue;
                    }
                    lock (_memorySync)
                    {
                        if (_knownReceiptIds.Contains(receipt.ReceiptId)) continue;
                    }
                    receipt.ClaimedByInstanceId = _instanceId;
                    receipt.ClaimedAtUtc = now.ToString("O");
                    claimed.Add(receipt);
                    changed = true;
                }
                if (changed) WriteBounded(envelope);
                AddSnapshot(claimed);
                return true;
            }, TimeSpan.FromSeconds(5));
        }

        private void CleanupClaimedReceipts(IReadOnlyCollection<string> receiptIds)
        {
            WithMutex(() =>
            {
                var envelope = ReadEnvelope();
                var ids = new HashSet<string>(receiptIds, StringComparer.Ordinal);
                var removed = envelope.Receipts.RemoveAll(receipt =>
                    ids.Contains(receipt.ReceiptId)
                    && string.Equals(receipt.ClaimedByInstanceId, _instanceId, StringComparison.Ordinal));
                if (removed > 0) WriteBounded(envelope);
                return true;
            }, TimeSpan.FromSeconds(5));
        }

        private void AddSnapshot(IEnumerable<OperatorDesktopLaunchFailureReceipt> receipts)
        {
            var ordered = receipts
                .Where(receipt => !string.IsNullOrWhiteSpace(receipt.Message))
                .OrderBy(receipt => receipt.ObservedAtUtc, StringComparer.Ordinal)
                .ThenBy(receipt => receipt.InstanceId, StringComparer.Ordinal)
                .ThenBy(receipt => receipt.LaunchId, StringComparer.Ordinal)
                .ThenBy(receipt => receipt.ReceiptId, StringComparer.Ordinal)
                .ToList();
            if (ordered.Count == 0) return;
            lock (_memorySync)
            {
                ordered = ordered.Where(receipt => _knownReceiptIds.Add(receipt.ReceiptId)).ToList();
                if (ordered.Count == 0) return;
                _snapshots.Enqueue(new OperatorDesktopLaunchFailureSnapshot(
                    ordered.Select(receipt => receipt.ReceiptId).ToList(),
                    string.Join(
                        Environment.NewLine,
                        ordered.Select(receipt => $"[{receipt.InstanceId}/{receipt.LaunchId}] {receipt.Message}"))));
            }
        }

        private void AddSyntheticFailure(string message)
        {
            lock (_memorySync)
            {
                _snapshots.Enqueue(new OperatorDesktopLaunchFailureSnapshot(
                    Array.Empty<string>(),
                    Limit(message, 2048)));
            }
        }

        private void QueueBackground(Action action, Action? completed = null)
        {
            lock (_backgroundSync)
            {
                var prior = _backgroundTask;
                _backgroundTask = Task.Run(async () =>
                {
                    try { await prior.ConfigureAwait(false); } catch { }
                    try { action(); }
                    catch (OperatorDesktopReceiptOversizeException ex)
                    {
                        AddSyntheticFailure($"The Operator Desktop failure receipt was {ex.Length} bytes, exceeded the {MaximumEnvelopeBytes}-byte limit, and was quarantined without overwrite.");
                    }
                    catch (Exception ex)
                    {
                        AddSyntheticFailure($"Operator Desktop failure receipt background processing failed ({ex.GetType().Name}: {ex.Message}).");
                    }
                    finally
                    {
                        completed?.Invoke();
                    }
                });
            }
        }

        private OperatorDesktopLaunchFailureReceiptEnvelope ReadEnvelope()
        {
            string? json;
            try
            {
                json = _read();
            }
            catch (OperatorDesktopReceiptOversizeException ex)
            {
                _quarantine($"Envelope size {ex.Length} exceeded {MaximumEnvelopeBytes} bytes.");
                throw;
            }
            if (string.IsNullOrWhiteSpace(json)) return new OperatorDesktopLaunchFailureReceiptEnvelope();
            var byteCount = Encoding.UTF8.GetByteCount(json!);
            if (byteCount > MaximumEnvelopeBytes)
            {
                _quarantine($"Envelope size {byteCount} exceeded {MaximumEnvelopeBytes} bytes.");
                throw new OperatorDesktopReceiptOversizeException(byteCount);
            }
            var envelope = JsonSerializer.Deserialize<OperatorDesktopLaunchFailureReceiptEnvelope>(json!);
            return envelope?.SchemaVersion == 2 && envelope.Receipts != null
                ? envelope
                : new OperatorDesktopLaunchFailureReceiptEnvelope();
        }

        private bool RemoveExpired(OperatorDesktopLaunchFailureReceiptEnvelope envelope, DateTimeOffset now)
        {
            return envelope.Receipts.RemoveAll(receipt =>
                !DateTimeOffset.TryParse(receipt.ObservedAtUtc, out var observed)
                || observed > now.AddMinutes(5)
                || now - observed > _freshness) > 0;
        }

        private static void Sort(OperatorDesktopLaunchFailureReceiptEnvelope envelope)
        {
            envelope.Receipts.Sort((left, right) =>
            {
                var time = string.CompareOrdinal(left.ObservedAtUtc, right.ObservedAtUtc);
                if (time != 0) return time;
                var instance = string.CompareOrdinal(left.InstanceId, right.InstanceId);
                if (instance != 0) return instance;
                var launch = string.CompareOrdinal(left.LaunchId, right.LaunchId);
                return launch != 0 ? launch : string.CompareOrdinal(left.ReceiptId, right.ReceiptId);
            });
        }

        private T WithMutex<T>(Func<T> action, TimeSpan timeout)
        {
            using var mutex = new Mutex(false, _mutexName);
            var acquired = false;
            try
            {
                try
                {
                    acquired = mutex.WaitOne(timeout);
                }
                catch (AbandonedMutexException)
                {
                    acquired = true;
                }
                if (!acquired) throw new TimeoutException("Timed out waiting for the Operator Desktop failure receipt mutex.");
                return action();
            }
            finally
            {
                if (acquired) mutex.ReleaseMutex();
            }
        }

        private void WriteBounded(OperatorDesktopLaunchFailureReceiptEnvelope envelope)
        {
            Sort(envelope);
            var pruned = 0;
            while (envelope.Receipts.Count > MaximumEnvelopeEntries)
            {
                envelope.Receipts.RemoveAt(0);
                pruned++;
            }
            var json = JsonSerializer.Serialize(envelope);
            while (Encoding.UTF8.GetByteCount(json) > MaximumEnvelopeBytes && envelope.Receipts.Count > 0)
            {
                envelope.Receipts.RemoveAt(0);
                pruned++;
                json = JsonSerializer.Serialize(envelope);
            }
            if (Encoding.UTF8.GetByteCount(json) > MaximumEnvelopeBytes)
            {
                throw new InvalidDataException("The empty Operator Desktop receipt envelope exceeds its byte limit.");
            }
            _write(json);
            if (pruned > 0)
            {
                AddSyntheticFailure($"The Operator Desktop failure receipt envelope deterministically pruned {pruned} oldest entr{(pruned == 1 ? "y" : "ies")} to remain within {MaximumEnvelopeEntries} entries and {MaximumEnvelopeBytes} bytes.");
            }
        }

        private static string Limit(string? value, int maximumLength)
        {
            var normalized = (value ?? "").Trim();
            return normalized.Length <= maximumLength
                ? normalized
                : normalized.Substring(0, maximumLength);
        }
    }

    internal sealed class OperatorDesktopLaunchFailureSnapshot
    {
        public OperatorDesktopLaunchFailureSnapshot(IReadOnlyList<string> receiptIds, string message)
        {
            ReceiptIds = receiptIds;
            Message = message;
        }

        public IReadOnlyList<string> ReceiptIds { get; }
        public string Message { get; }
    }

    internal sealed class OperatorDesktopReceiptOversizeException : Exception
    {
        public OperatorDesktopReceiptOversizeException(long length)
            : base($"Operator Desktop receipt envelope was {length} bytes.")
        {
            Length = length;
        }

        public long Length { get; }
    }

    internal sealed class OperatorDesktopLaunchFailureReceipt
    {
        public string ReceiptId { get; set; } = "";
        public string InstanceId { get; set; } = "";
        public string LaunchId { get; set; } = "";
        public string Message { get; set; } = "";
        public string ObservedAtUtc { get; set; } = "";
        public string ClaimedByInstanceId { get; set; } = "";
        public string ClaimedAtUtc { get; set; } = "";
    }

    internal sealed class OperatorDesktopLaunchFailureReceiptEnvelope
    {
        public int SchemaVersion { get; set; } = 2;
        public List<OperatorDesktopLaunchFailureReceipt> Receipts { get; set; } = new List<OperatorDesktopLaunchFailureReceipt>();
    }
}

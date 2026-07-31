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
        internal const int FirstClickPreloadWaitMilliseconds = 750;
        private const int LauncherObservationTimeoutMilliseconds = 30000;
        private const int PostExitLivenessTimeoutMilliseconds = 5000;
        private const int RuntimeIdentityDeadlineMilliseconds = 1500;
        private const int RuntimeIdentityMaxBytes = 4096;
        private static readonly OperatorDesktopLaunchFailureReceiptStore FailureReceipts = CreateFailureReceiptStore();
        private static readonly OperatorDesktopInFlightLaunchGate LaunchGate = new OperatorDesktopInFlightLaunchGate();
        private static readonly object LauncherPathSnapshotSync = new object();
        private static string? CachedLauncherPath;
        private static string LauncherPathDiscoveryError = "";
        private static bool LauncherPathPreloadComplete;
        private static int LauncherPathRefreshQueued;
        private static int ShuttingDown;
        private static readonly ManualResetEventSlim LauncherPathInitialRefreshCompleted = new ManualResetEventSlim(false);

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
            => TryLaunch(null, out detail);

        public static bool TryLaunch(
            Func<OperatorDesktopPersistedFailure, bool>? reportDelayedFailure,
            out string detail)
        {
            if (Volatile.Read(ref ShuttingDown) != 0)
            {
                detail = "Operator Desktop launch was not started because Revit is shutting down. Start Operator Desktop after Revit has closed if you still need it.";
                return false;
            }

            var preloadStopwatch = Stopwatch.StartNew();
            RequestLauncherPathRefresh();
            if (!WaitForLauncherPathInitialRefresh(RemainingPreloadBudget(preloadStopwatch)))
            {
                detail = BuildPreloadTimeoutDetail("launcher discovery");
                return false;
            }

            string? launcherPath;
            string discoveryError;
            lock (LauncherPathSnapshotSync)
            {
                launcherPath = CachedLauncherPath;
                discoveryError = LauncherPathDiscoveryError;
            }
            if (!string.IsNullOrWhiteSpace(discoveryError))
            {
                detail = "Operator Desktop launcher discovery failed in the background. " + discoveryError;
                return false;
            }
            return TryLaunch(
                launcherPath,
                new OperatorDesktopLaunchRuntime(
                    path => DispatchLauncher(path, reportDelayedFailure),
                    FailureReceipts),
                RemainingPreloadBudget(preloadStopwatch),
                out detail);
        }

        internal static void BeginShutdown()
        {
            Interlocked.Exchange(ref ShuttingDown, 1);
            LaunchGate.Shutdown();
            FailureReceipts.ReleaseAllClaimsForInstance();
        }

        internal static OperatorDesktopLaunchFailureReceiptStore SharedFailureReceipts => FailureReceipts;

        private static TimeSpan RemainingPreloadBudget(Stopwatch stopwatch)
        {
            var remaining = FirstClickPreloadWaitMilliseconds - (int)stopwatch.ElapsedMilliseconds;
            return TimeSpan.FromMilliseconds(Math.Max(0, remaining));
        }

        private static bool WaitForLauncherPathInitialRefresh(TimeSpan timeout)
        {
            lock (LauncherPathSnapshotSync)
            {
                if (LauncherPathPreloadComplete) return true;
            }

            if (timeout <= TimeSpan.Zero) return false;
            LauncherPathInitialRefreshCompleted.Wait(timeout);
            lock (LauncherPathSnapshotSync) return LauncherPathPreloadComplete;
        }

        private static string BuildPreloadTimeoutDetail(string preloadName)
            => $"Operator Desktop {preloadName} did not complete within the bounded "
                + $"{FirstClickPreloadWaitMilliseconds}-millisecond first-click wait, so no launch was attempted and Revit was not blocked further. "
                + "Start 'Operator Desktop' from the Windows desktop or workstation package. If it is missing or also fails, reinstall the workstation package or set OPERATOR_DESKTOP_LAUNCHER_PATH and restart Revit.";

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
                    LauncherPathInitialRefreshCompleted.Set();
                    Interlocked.Exchange(ref LauncherPathRefreshQueued, 0);
                }
            });
        }

        internal static bool TryLaunch(
            string? launcherPath,
            OperatorDesktopLaunchRuntime runtime,
            out string detail)
            => TryLaunch(
                launcherPath,
                runtime,
                TimeSpan.FromMilliseconds(FirstClickPreloadWaitMilliseconds),
                out detail);

        internal static bool TryLaunch(
            string? launcherPath,
            OperatorDesktopLaunchRuntime runtime,
            TimeSpan preloadWait,
            out string detail)
        {
            try
            {
                if (!runtime.FailureReceipts.WaitForInitialRefresh(preloadWait))
                {
                    detail = BuildPreloadTimeoutDetail("failure receipt check");
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

                    detail = dispatch.ReusedInFlight
                        ? $"Operator Desktop launch ({dispatch.LaunchId}) is already in progress; no duplicate launcher was started."
                        : $"Launcher dispatch accepted ({dispatch.LaunchId}): {selectedLauncherPath}. Sidecar readiness is not yet claimed; an observed late failure will be persisted before it is surfaced in Revit.";
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

        private static OperatorDesktopDispatchResult DispatchLauncher(
            string launcherPath,
            Func<OperatorDesktopPersistedFailure, bool>? reportDelayedFailure)
        {
            if (!LaunchGate.TryEnter(out var lease))
            {
                return lease == null
                    ? OperatorDesktopDispatchResult.Rejected("Revit is shutting down; no Operator Desktop launch was dispatched.")
                    : OperatorDesktopDispatchResult.DispatchAccepted(lease.LaunchId, reusedInFlight: true);
            }
            var ownedLease = lease!;

            try
            {
                var process = Process.Start(BuildLauncherStartInfo(launcherPath));
                if (process == null)
                {
                    ownedLease.Dispose();
                    return OperatorDesktopDispatchResult.Rejected("Windows did not return a launcher process handle.");
                }

                _ = Task.Run(() => ObserveLauncherProcess(
                    process,
                    launcherPath,
                    ownedLease,
                    reportDelayedFailure));
                return OperatorDesktopDispatchResult.DispatchAccepted(ownedLease.LaunchId);
            }
            catch (Exception ex)
            {
                ownedLease.Dispose();
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

        private static void ObserveLauncherProcess(
            Process process,
            string launcherPath,
            OperatorDesktopInFlightLaunchLease launchLease,
            Func<OperatorDesktopPersistedFailure, bool>? reportDelayedFailure)
        {
            try
            {
                var exited = process.WaitForExit(LauncherObservationTimeoutMilliseconds);
                var exitCode = exited ? process.ExitCode : 0;
                var sidecarLive = exited
                    ? WaitForSidecarLiveness(PostExitLivenessTimeoutMilliseconds)
                    : IsSidecarLive(OperatorDesktopLaunchPlan.RuntimeIdentityUrl);
                var failure = GetObservedLaunchFailure(launcherPath, exited, exitCode, sidecarLive);
                if (failure != null)
                {
                    ReportOrPersistObservedFailure(
                        failure,
                        launchLease.LaunchId,
                        FailureReceipts,
                        reportDelayedFailure);
                }
            }
            catch (Exception ex)
            {
                ReportOrPersistObservedFailure(
                    $"Launcher observation failed for {launcherPath}: {ex.GetType().Name}: {ex.Message}",
                    launchLease.LaunchId,
                    FailureReceipts,
                    reportDelayedFailure);
            }
            finally
            {
                process.Dispose();
                launchLease.Dispose();
            }
        }

        internal static void ReportOrPersistObservedFailure(
            string failure,
            string launchId,
            OperatorDesktopLaunchFailureReceiptStore failureReceipts,
            Func<OperatorDesktopPersistedFailure, bool>? reportDelayedFailure)
        {
            OperatorDesktopPersistedFailure persistedFailure;
            try
            {
                persistedFailure = failureReceipts.PersistForNotification(failure, launchId);
            }
            catch
            {
                failureReceipts.Record(failure, launchId);
                return;
            }

            if (Volatile.Read(ref ShuttingDown) != 0)
            {
                failureReceipts.ReleasePersistedFailures(new[] { persistedFailure.ReceiptId });
                return;
            }

            var reported = false;
            if (reportDelayedFailure != null)
            {
                try
                {
                    reported = reportDelayedFailure(persistedFailure);
                }
                catch
                {
                    reported = false;
                }
            }

            if (!reported) failureReceipts.SurfacePersistedFailures(new[] { persistedFailure });
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
        private OperatorDesktopDispatchResult(bool accepted, string error, string launchId, bool reusedInFlight)
        {
            Accepted = accepted;
            Error = error;
            LaunchId = launchId;
            ReusedInFlight = reusedInFlight;
        }

        public bool Accepted { get; }
        public string Error { get; }
        public string LaunchId { get; }
        public bool ReusedInFlight { get; }

        public static OperatorDesktopDispatchResult DispatchAccepted(string launchId, bool reusedInFlight = false)
            => new OperatorDesktopDispatchResult(true, "", launchId ?? "", reusedInFlight);

        public static OperatorDesktopDispatchResult Rejected(string error)
            => new OperatorDesktopDispatchResult(false, error ?? "", "", false);
    }

    internal sealed class OperatorDesktopInFlightLaunchGate
    {
        private readonly object _sync = new object();
        private string? _launchId;
        private bool _shuttingDown;

        public bool TryEnter(out OperatorDesktopInFlightLaunchLease? lease)
        {
            lock (_sync)
            {
                if (_shuttingDown)
                {
                    lease = null;
                    return false;
                }
                if (_launchId != null)
                {
                    lease = new OperatorDesktopInFlightLaunchLease(this, _launchId, ownsGate: false);
                    return false;
                }

                _launchId = Guid.NewGuid().ToString("N");
                lease = new OperatorDesktopInFlightLaunchLease(this, _launchId, ownsGate: true);
                return true;
            }
        }

        public void Shutdown()
        {
            lock (_sync) _shuttingDown = true;
        }

        internal void Exit(string launchId)
        {
            lock (_sync)
            {
                if (string.Equals(_launchId, launchId, StringComparison.Ordinal)) _launchId = null;
            }
        }
    }

    internal sealed class OperatorDesktopInFlightLaunchLease : IDisposable
    {
        private OperatorDesktopInFlightLaunchGate? _owner;
        private readonly bool _ownsGate;

        public OperatorDesktopInFlightLaunchLease(
            OperatorDesktopInFlightLaunchGate owner,
            string launchId,
            bool ownsGate)
        {
            _owner = owner;
            LaunchId = launchId;
            _ownsGate = ownsGate;
        }

        public string LaunchId { get; }

        public void Dispose()
        {
            var owner = Interlocked.Exchange(ref _owner, null);
            if (_ownsGate) owner?.Exit(LaunchId);
        }
    }

    internal sealed class OperatorDesktopPersistedFailure
    {
        public OperatorDesktopPersistedFailure(
            string receiptId,
            string launchId,
            string message,
            string observedAtUtc)
        {
            ReceiptId = receiptId;
            LaunchId = launchId;
            Message = message;
            ObservedAtUtc = observedAtUtc;
        }

        public string ReceiptId { get; }
        public string LaunchId { get; }
        public string Message { get; }
        public string ObservedAtUtc { get; }
    }

    internal sealed class OperatorDesktopDelayedFailureBatch
    {
        public OperatorDesktopDelayedFailureBatch(
            long token,
            IReadOnlyList<OperatorDesktopPersistedFailure> failures,
            int reportCount,
            string message)
        {
            Token = token;
            Failures = failures;
            ReportCount = reportCount;
            Message = message;
        }

        public long Token { get; }
        public IReadOnlyList<OperatorDesktopPersistedFailure> Failures { get; }
        public int ReportCount { get; }
        public string Message { get; }
    }

    internal sealed class OperatorDesktopDelayedFailureBuffer : IDisposable
    {
        internal const int MaximumTrackedReceipts = OperatorDesktopLaunchFailureReceiptStore.MaximumEnvelopeEntries;
        internal const int MaximumDetailedFailures = 4;
        private readonly OperatorDesktopLaunchFailureReceiptStore _failureReceipts;
        private readonly object _sync = new object();
        private PendingAggregate _pending = new PendingAggregate();
        private OperatorDesktopDelayedFailureBatch? _activeBatch;
        private long _nextToken;
        private bool _shuttingDown;

        public OperatorDesktopDelayedFailureBuffer(OperatorDesktopLaunchFailureReceiptStore failureReceipts)
        {
            _failureReceipts = failureReceipts ?? throw new ArgumentNullException(nameof(failureReceipts));
        }

        public bool TryEnqueue(OperatorDesktopPersistedFailure failure)
        {
            var release = false;
            lock (_sync)
            {
                if (_shuttingDown) release = true;
                else
                {
                    var activeIds = _activeBatch == null
                        ? new HashSet<string>(StringComparer.Ordinal)
                        : new HashSet<string>(
                            _activeBatch.Failures.Select(item => item.ReceiptId),
                            StringComparer.Ordinal);
                    var current = _failureReceipts.ReadClaimedFailuresForInstance()
                        .Where(item => !activeIds.Contains(item.ReceiptId))
                        .ToList();
                    _pending.AddReport(current);
                }
            }

            if (release) _failureReceipts.ReleasePersistedFailures(new[] { failure.ReceiptId });
            return true;
        }

        public OperatorDesktopDelayedFailureBatch? TryBeginDisplay()
        {
            lock (_sync)
            {
                if (_shuttingDown || _activeBatch != null || _pending.ReportCount == 0) return null;
                var aggregate = _pending;
                _pending = new PendingAggregate();
                var batch = aggregate.ToBatch(++_nextToken);
                _activeBatch = batch;
                return batch;
            }
        }

        public bool HasPending
        {
            get
            {
                lock (_sync) return !_shuttingDown && _pending.ReportCount > 0;
            }
        }

        public void CompleteDisplay(OperatorDesktopDelayedFailureBatch batch, bool displayed)
        {
            if (batch == null) throw new ArgumentNullException(nameof(batch));
            lock (_sync)
            {
                if (_activeBatch == null || _activeBatch.Token != batch.Token) return;
                if (displayed)
                {
                    _failureReceipts.AcknowledgePersistedFailures(
                        batch.Failures.Select(failure => failure.ReceiptId).ToList());
                }
                else
                {
                    _failureReceipts.SurfacePersistedFailures(batch.Failures);
                }
                _activeBatch = null;
            }
        }

        public void FailPendingDelivery()
        {
            OperatorDesktopDelayedFailureBatch? batch;
            lock (_sync)
            {
                if (_pending.ReportCount == 0) return;
                var aggregate = _pending;
                _pending = new PendingAggregate();
                batch = aggregate.ToBatch(++_nextToken);
            }
            _failureReceipts.SurfacePersistedFailures(batch.Failures);
        }

        public void Dispose()
        {
            List<string> receiptIds;
            lock (_sync)
            {
                if (_shuttingDown) return;
                _shuttingDown = true;
                receiptIds = _pending.Failures
                    .Concat(_activeBatch?.Failures ?? Array.Empty<OperatorDesktopPersistedFailure>())
                    .Select(failure => failure.ReceiptId)
                    .Distinct(StringComparer.Ordinal)
                    .ToList();
                _pending = new PendingAggregate();
                _activeBatch = null;
            }
            if (receiptIds.Count > 0) _failureReceipts.ReleasePersistedFailures(receiptIds);
        }

        private sealed class PendingAggregate
        {
            private readonly List<OperatorDesktopPersistedFailure> _failures = new List<OperatorDesktopPersistedFailure>();

            public IReadOnlyList<OperatorDesktopPersistedFailure> Failures => _failures;
            public int ReportCount { get; private set; }

            public void AddReport(IReadOnlyList<OperatorDesktopPersistedFailure> currentFailures)
            {
                if (ReportCount < int.MaxValue) ReportCount++;
                _failures.Clear();
                _failures.AddRange(currentFailures.Skip(
                    Math.Max(0, currentFailures.Count - MaximumTrackedReceipts)));
            }

            public OperatorDesktopDelayedFailureBatch ToBatch(long token)
            {
                var details = _failures.Take(MaximumDetailedFailures)
                    .Select(failure => $"[{failure.LaunchId}] {failure.Message}")
                    .ToList();
                var omitted = Math.Max(0, ReportCount - details.Count);
                var message = string.Join(Environment.NewLine, details);
                if (omitted > 0)
                {
                    message += Environment.NewLine + $"... and {omitted} additional launch failure{(omitted == 1 ? "" : "s")} were coalesced.";
                }
                if (message.Length > 4096) message = message.Substring(0, 4096);
                return new OperatorDesktopDelayedFailureBatch(
                    token,
                    _failures.ToList(),
                    ReportCount,
                    message);
            }
        }
    }

    internal enum OperatorDesktopDelayedFailureRaiseResult
    {
        Accepted,
        Pending,
        Denied,
        TimedOut
    }

    internal sealed class OperatorDesktopDelayedFailureDelivery : IDisposable
    {
        private readonly OperatorDesktopDelayedFailureBuffer _buffer;
        private readonly Func<OperatorDesktopDelayedFailureRaiseResult> _raise;
        private readonly Action _disposeRaiseTarget;
        private readonly Func<int, Task> _delay;
        private readonly object _retrySync = new object();
        private Task _retryTask = Task.CompletedTask;
        private int _raiseOutstanding;
        private int _shuttingDown;
        private int _disposed;

        public OperatorDesktopDelayedFailureDelivery(
            OperatorDesktopDelayedFailureBuffer buffer,
            Func<OperatorDesktopDelayedFailureRaiseResult> raise,
            Action disposeRaiseTarget,
            Func<int, Task>? delay = null)
        {
            _buffer = buffer ?? throw new ArgumentNullException(nameof(buffer));
            _raise = raise ?? throw new ArgumentNullException(nameof(raise));
            _disposeRaiseTarget = disposeRaiseTarget ?? throw new ArgumentNullException(nameof(disposeRaiseTarget));
            _delay = delay ?? (milliseconds => Task.Delay(milliseconds));
        }

        public bool TryReport(OperatorDesktopPersistedFailure failure)
        {
            _buffer.TryEnqueue(failure);
            if (Volatile.Read(ref _shuttingDown) != 0) return true;
            EnsureRaise();
            return true;
        }

        public void Execute(Func<string, bool> display)
        {
            if (display == null) throw new ArgumentNullException(nameof(display));
            if (Volatile.Read(ref _shuttingDown) != 0) return;
            var batch = _buffer.TryBeginDisplay();
            if (batch == null)
            {
                Interlocked.Exchange(ref _raiseOutstanding, 0);
                return;
            }

            var displayed = false;
            try
            {
                displayed = display(batch.Message);
            }
            finally
            {
                _buffer.CompleteDisplay(batch, displayed);
                Interlocked.Exchange(ref _raiseOutstanding, 0);
                if (_buffer.HasPending && Volatile.Read(ref _shuttingDown) == 0) EnsureRaise();
            }
        }

        internal Task WaitForRetryIdleAsync()
        {
            lock (_retrySync) return _retryTask;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            Interlocked.Exchange(ref _shuttingDown, 1);
            _buffer.Dispose();
            try { _disposeRaiseTarget(); } catch { }
        }

        private void EnsureRaise()
        {
            if (Volatile.Read(ref _shuttingDown) != 0
                || Interlocked.CompareExchange(ref _raiseOutstanding, 1, 0) != 0)
            {
                return;
            }

            var result = TryRaise();
            if (result == OperatorDesktopDelayedFailureRaiseResult.Accepted) return;
            if (result == OperatorDesktopDelayedFailureRaiseResult.Pending)
            {
                QueuePendingRetry();
                return;
            }
            _buffer.FailPendingDelivery();
            Interlocked.Exchange(ref _raiseOutstanding, 0);
            if (_buffer.HasPending && Volatile.Read(ref _shuttingDown) == 0) EnsureRaise();
        }

        private void QueuePendingRetry()
        {
            lock (_retrySync)
            {
                if (!_retryTask.IsCompleted) return;
                _retryTask = RetryPendingRaiseAsync();
            }
        }

        private async Task RetryPendingRaiseAsync()
        {
            for (var attempt = 0; attempt < 4 && Volatile.Read(ref _shuttingDown) == 0; attempt++)
            {
                await _delay(25 * (attempt + 1)).ConfigureAwait(false);
                if (Volatile.Read(ref _shuttingDown) != 0) return;
                var result = TryRaise();
                if (result == OperatorDesktopDelayedFailureRaiseResult.Accepted) return;
                if (result == OperatorDesktopDelayedFailureRaiseResult.Denied) break;
                if (result == OperatorDesktopDelayedFailureRaiseResult.TimedOut && attempt == 3) break;
            }

            if (Volatile.Read(ref _shuttingDown) != 0) return;
            _buffer.FailPendingDelivery();
            Interlocked.Exchange(ref _raiseOutstanding, 0);
            if (_buffer.HasPending && Volatile.Read(ref _shuttingDown) == 0) EnsureRaise();
        }

        private OperatorDesktopDelayedFailureRaiseResult TryRaise()
        {
            try { return _raise(); }
            catch { return OperatorDesktopDelayedFailureRaiseResult.Denied; }
        }
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
        private readonly Task _initialRefreshTask;
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
            _initialRefreshTask = QueueBackground(
                RefreshAndClaim,
                () => Volatile.Write(ref _initialRefreshComplete, 1));
        }

        public bool InitialRefreshComplete => Volatile.Read(ref _initialRefreshComplete) != 0;

        internal bool WaitForInitialRefresh(TimeSpan timeout)
        {
            if (InitialRefreshComplete) return true;
            if (timeout <= TimeSpan.Zero) return false;
            _initialRefreshTask.Wait(timeout);
            return InitialRefreshComplete;
        }

        public void Record(string message, string? launchId = null)
        {
            QueueBackground(() =>
            {
                var persisted = Persist(message, launchId, surfacePrune: true);
                SurfacePersistedFailures(new[] { persisted });
            });
        }

        internal OperatorDesktopPersistedFailure PersistForNotification(string message, string? launchId)
            => Persist(message, launchId, surfacePrune: false);

        private OperatorDesktopPersistedFailure Persist(
            string message,
            string? launchId,
            bool surfacePrune)
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
            WithMutex(() =>
            {
                var envelope = ReadEnvelope();
                RemoveExpired(envelope, now);
                envelope.Receipts.Add(receipt);
                Sort(envelope);
                WriteBounded(envelope, surfacePrune);
                return true;
            }, TimeSpan.FromSeconds(5));
            return new OperatorDesktopPersistedFailure(
                receipt.ReceiptId,
                receipt.LaunchId,
                receipt.Message,
                receipt.ObservedAtUtc);
        }

        internal void SurfacePersistedFailures(IEnumerable<OperatorDesktopPersistedFailure> failures)
        {
            AddSnapshot(failures.Select(failure => new OperatorDesktopLaunchFailureReceipt
            {
                ReceiptId = failure.ReceiptId,
                InstanceId = _instanceId,
                LaunchId = failure.LaunchId,
                Message = failure.Message,
                ObservedAtUtc = failure.ObservedAtUtc,
                ClaimedByInstanceId = _instanceId,
                ClaimedAtUtc = _utcNow().ToString("O")
            }));
        }

        internal void AcknowledgePersistedFailures(IReadOnlyCollection<string> receiptIds)
            => RemoveOrReleasePersistedFailures(receiptIds, remove: true);

        internal void ReleasePersistedFailures(IReadOnlyCollection<string> receiptIds)
            => RemoveOrReleasePersistedFailures(receiptIds, remove: false);

        internal void ReleaseAllClaimsForInstance()
            => RemoveOrReleasePersistedFailures(null, remove: false);

        internal IReadOnlyList<OperatorDesktopPersistedFailure> ReadClaimedFailuresForInstance()
        {
            HashSet<string> alreadySurfaced;
            lock (_memorySync)
            {
                alreadySurfaced = new HashSet<string>(_knownReceiptIds, StringComparer.Ordinal);
            }
            return WithMutex(() =>
            {
                var envelope = ReadEnvelope();
                return (IReadOnlyList<OperatorDesktopPersistedFailure>)envelope.Receipts
                    .Where(receipt => string.Equals(
                        receipt.ClaimedByInstanceId,
                        _instanceId,
                        StringComparison.Ordinal)
                        && !alreadySurfaced.Contains(receipt.ReceiptId))
                    .Select(receipt => new OperatorDesktopPersistedFailure(
                        receipt.ReceiptId,
                        receipt.LaunchId,
                        receipt.Message,
                        receipt.ObservedAtUtc))
                    .ToList();
            }, TimeSpan.FromSeconds(5));
        }

        private void RemoveOrReleasePersistedFailures(
            IReadOnlyCollection<string>? receiptIds,
            bool remove)
        {
            var ids = receiptIds == null
                ? null
                : new HashSet<string>(receiptIds, StringComparer.Ordinal);
            WithMutex(() =>
            {
                var envelope = ReadEnvelope();
                var changed = false;
                if (remove)
                {
                    changed = envelope.Receipts.RemoveAll(receipt =>
                        string.Equals(receipt.ClaimedByInstanceId, _instanceId, StringComparison.Ordinal)
                        && ids != null
                        && ids.Contains(receipt.ReceiptId)) > 0;
                }
                else
                {
                    foreach (var receipt in envelope.Receipts)
                    {
                        if (!string.Equals(receipt.ClaimedByInstanceId, _instanceId, StringComparison.Ordinal)
                            || ids != null && !ids.Contains(receipt.ReceiptId))
                        {
                            continue;
                        }
                        receipt.ClaimedByInstanceId = "";
                        receipt.ClaimedAtUtc = "";
                        changed = true;
                    }
                }
                if (changed) WriteBounded(envelope);
                return true;
            }, TimeSpan.FromSeconds(5));
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

        private Task QueueBackground(Action action, Action? completed = null)
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
                return _backgroundTask;
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

        private void WriteBounded(
            OperatorDesktopLaunchFailureReceiptEnvelope envelope,
            bool surfacePrune = true)
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
            if (pruned > 0 && surfacePrune)
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

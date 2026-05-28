using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal static class OperatorBackendAutoStart
    {
        private static int _watchdogStarted;
        private static readonly SemaphoreSlim _ensureGate = new SemaphoreSlim(1, 1);
        private static long _lastEnsureAttemptTicksUtc;

        public static void TryStartInBackground()
        {
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            var logDir = WorkspacePaths.EnsureDir("logs");
            var tracePath = Path.Combine(logDir, "operator-backend-autostart-trace.log");

            void Trace(string msg)
            {
                try { File.AppendAllText(tracePath, $"[{DateTime.Now:O}] {msg}{Environment.NewLine}"); } catch { }
            }

            Trace("TryStartInBackground invoked");
            if (!IsEnabled()) return;

            // Start a lightweight watchdog that can restart the backend if it dies mid-session.
            // The actual start attempts are gated by _ensureGate so multiple callers won't stampede.
            if (Interlocked.Exchange(ref _watchdogStarted, 1) == 1) return;

            Task.Run(async () =>
            {
                try
                {
                    var baseUri = OperatorBackendConfig.GetBaseUri();
                    Trace($"BaseUri={baseUri}");

                    // Kick once immediately, then keep checking periodically.
                    await EnsureHealthyAsync(baseUri, Trace, CancellationToken.None).ConfigureAwait(false);

                    while (true)
                    {
                        await Task.Delay(2000).ConfigureAwait(false);
                        await EnsureHealthyAsync(baseUri, Trace, CancellationToken.None).ConfigureAwait(false);
                    }
                }
                catch (Exception ex)
                {
                    Trace($"Exception during autostart: {ex.GetType().FullName}: {ex.Message}");
                }
            });
        }

        public static async Task<bool> EnsureHealthyAsync(Uri baseUri, CancellationToken cancellationToken)
        {
            return await EnsureHealthyAsync(baseUri, trace: null, cancellationToken).ConfigureAwait(false);
        }

        private static async Task<bool> EnsureHealthyAsync(Uri baseUri, Action<string>? trace, CancellationToken cancellationToken)
        {
            if (!IsEnabled()) return await OperatorBackendHealth.IsHealthyAsync(baseUri).ConfigureAwait(false);
            if (await OperatorBackendHealth.IsHealthyAsync(baseUri).ConfigureAwait(false)) return true;

            // Throttle ensure attempts so callers don't spam Process.Start while the backend is starting.
            var nowTicks = DateTime.UtcNow.Ticks;
            var lastTicks = Interlocked.Read(ref _lastEnsureAttemptTicksUtc);
            if (lastTicks != 0 && new TimeSpan(nowTicks - lastTicks).TotalMilliseconds < 500)
            {
                // Briefly wait and recheck.
                await Task.Delay(250, cancellationToken).ConfigureAwait(false);
                return await OperatorBackendHealth.IsHealthyAsync(baseUri).ConfigureAwait(false);
            }
            Interlocked.Exchange(ref _lastEnsureAttemptTicksUtc, nowTicks);

            await _ensureGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (await OperatorBackendHealth.IsHealthyAsync(baseUri).ConfigureAwait(false)) return true;

                var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
                var logDir = WorkspacePaths.EnsureDir("logs");

                void Trace(string msg)
                {
                    try { trace?.Invoke(msg); } catch { }
                    try
                    {
                        var tracePath = Path.Combine(logDir, "operator-backend-autostart-trace.log");
                        File.AppendAllText(tracePath, $"[{DateTime.Now:O}] {msg}{Environment.NewLine}");
                    }
                    catch { }
                }

                var workDir = GetBackendWorkDir();
                Trace($"EnsureHealthyAsync WorkDir={(workDir ?? "<null>")}");
                if (workDir == null) return false;

                var stdout = Path.Combine(logDir, $"operator-backend-autostart-{stamp}.out.log");
                var stderr = Path.Combine(logDir, $"operator-backend-autostart-{stamp}.err.log");

                var psi = CreateStartInfo(workDir, baseUri, Trace);
                try { psi.EnvironmentVariables["OPERATOR_TOKEN"] = OperatorSecurity.GetOrCreateOperatorToken(); } catch { }
                try
                {
                    var existingBrain = Environment.GetEnvironmentVariable("OPERATOR_BRAIN");
                    if (string.IsNullOrWhiteSpace(existingBrain)) psi.EnvironmentVariables["OPERATOR_BRAIN"] = "codex";
                }
                catch { }
                try
                {
                    var existingDevMode = Environment.GetEnvironmentVariable("OPERATOR_DEV_MODE");
                    if (string.IsNullOrWhiteSpace(existingDevMode)) psi.EnvironmentVariables["OPERATOR_DEV_MODE"] = "1";
                }
                catch { }
                try { psi.EnvironmentVariables["OPERATOR_BACKEND_PORT"] = baseUri.Port.ToString(); } catch { }

                var proc = Process.Start(psi);
                if (proc != null)
                {
                    Trace($"Started PID={proc.Id}");
                    try
                    {
                        var o = new StreamWriter(new FileStream(stdout, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true };
                        var e = new StreamWriter(new FileStream(stderr, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true };

                        proc.EnableRaisingEvents = true;
                        proc.OutputDataReceived += (_, a) => { if (a.Data != null) { try { o.WriteLine(a.Data); } catch { } } };
                        proc.ErrorDataReceived += (_, a) => { if (a.Data != null) { try { e.WriteLine(a.Data); } catch { } } };
                        proc.Exited += (_, __) =>
                        {
                            try { o.WriteLine($"[exited] code={proc.ExitCode}"); } catch { }
                            try { e.WriteLine($"[exited] code={proc.ExitCode}"); } catch { }
                            try { o.Dispose(); e.Dispose(); } catch { }
                            Trace($"Exited PID={proc.Id} code={proc.ExitCode}");
                        };
                        proc.BeginOutputReadLine();
                        proc.BeginErrorReadLine();
                    }
                    catch { }
                }
                else
                {
                    Trace("Process.Start returned null");
                }

                for (int i = 0; i < 10; i++)
                {
                    await Task.Delay(300, cancellationToken).ConfigureAwait(false);
                    if (await OperatorBackendHealth.IsHealthyAsync(baseUri).ConfigureAwait(false)) return true;
                }

                Trace("EnsureHealthyAsync: health did not become OK after retries");
                return false;
            }
            finally
            {
                try { _ensureGate.Release(); } catch { }
            }
        }

        private static ProcessStartInfo CreateStartInfo(string backendWorkDir, Uri baseUri, Action<string> trace)
        {
            // Prefer starting via the repo script (handles build + port conflicts + restart behavior).
            // Fallback to raw node execution if the script isn't available.
            try
            {
                var repoRoot = FindRepoRootFromBackendDir(backendWorkDir);
                var script = Path.Combine(repoRoot, "start_operator_backend.ps1");
                if (File.Exists(script))
                {
                    trace($"StartMode=powershell-script");
                    trace($"Script={script}");

                    return new ProcessStartInfo
                    {
                        FileName = "powershell.exe",
                        Arguments = RenderPowerShellArgs(script),
                        WorkingDirectory = repoRoot,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };
                }
            }
            catch (Exception ex)
            {
                trace($"CreateStartInfo script path error: {ex.GetType().FullName}: {ex.Message}");
            }

            var nodeExe = Environment.GetEnvironmentVariable("OPERATOR_BACKEND_NODE") ?? FindNodeExe() ?? "node";
            var args = Environment.GetEnvironmentVariable("OPERATOR_BACKEND_ARGS") ?? "dist/src/index.js";
            trace($"StartMode=node-direct");
            trace($"NodeExe={nodeExe}");
            trace($"Args={args}");

            return new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = args,
                WorkingDirectory = backendWorkDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
        }

        private static string FindRepoRootFromBackendDir(string backendWorkDir)
        {
            // backendWorkDir should be "<repoRoot>\\operator-backend". Prefer its parent.
            try
            {
                var parent = Directory.GetParent(backendWorkDir);
                if (parent != null)
                {
                    var candidate = parent.FullName;
                    var script = Path.Combine(candidate, "start_operator_backend.ps1");
                    if (File.Exists(script)) return candidate;
                }
            }
            catch { }

            // Fallback: walk upwards and look for the start script.
            var cur = backendWorkDir;
            for (int i = 0; i < 10; i++)
            {
                try
                {
                    var script = Path.Combine(cur, "start_operator_backend.ps1");
                    if (File.Exists(script)) return cur;
                    var parent = Directory.GetParent(cur);
                    if (parent == null) break;
                    cur = parent.FullName;
                }
                catch
                {
                    break;
                }
            }

            return backendWorkDir;
        }

        private static string QuotePowerShellArg(string s)
        {
            // PowerShell uses double-quotes for standard argument quoting; escape embedded quotes.
            return "\"" + (s ?? "").Replace("\"", "`\"") + "\"";
        }

        private static string RenderPowerShellArgs(string scriptPath)
        {
            // Use -Restart so we recover if the port is occupied by a stale backend instance.
            var sb = new StringBuilder();
            sb.Append("-NoProfile -ExecutionPolicy Bypass -File ");
            sb.Append(QuotePowerShellArg(scriptPath));
            sb.Append(" -Restart");
            return sb.ToString();
        }

        private static bool IsEnabled()
        {
            var v = Environment.GetEnvironmentVariable("OPERATOR_BACKEND_AUTOSTART");
            if (!string.IsNullOrWhiteSpace(v))
            {
                return string.Equals(v, "1", StringComparison.OrdinalIgnoreCase) ||
                       string.Equals(v, "true", StringComparison.OrdinalIgnoreCase) ||
                       string.Equals(v, "yes", StringComparison.OrdinalIgnoreCase);
            }

            var cfg = OperatorClientConfig.Load();
            if (cfg.backend_autostart.HasValue) return cfg.backend_autostart.Value;

            // Safe default: only autostart if backend URL resolves to loopback/local host.
            var baseUri = OperatorBackendConfig.GetBaseUri();
            if (baseUri.IsLoopback) return true;

            var host = (baseUri.Host ?? string.Empty).Trim();
            return string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase);
        }

        private static string? GetBackendWorkDir()
        {
            var explicitDir = Environment.GetEnvironmentVariable("OPERATOR_BACKEND_WORKDIR");
            if (!string.IsNullOrWhiteSpace(explicitDir) && Directory.Exists(explicitDir)) return explicitDir;

            // Dev convenience: infer repo root from current assembly location.
            try
            {
                var asmPath = Assembly.GetExecutingAssembly().Location;
                var dir = Path.GetDirectoryName(asmPath);
                if (string.IsNullOrWhiteSpace(dir)) return null;

                // Walk up a few levels and look for "operator-backend".
                var cur = dir;
                for (int i = 0; i < 10; i++)
                {
                    var candidate = Path.Combine(cur, "operator-backend");
                    if (Directory.Exists(candidate)) return candidate;
                    var parent = Directory.GetParent(cur);
                    if (parent == null) break;
                    cur = parent.FullName;
                }
            }
            catch { }

            // Dev convenience: common local repo paths.
            try
            {
                var user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                var common = new[]
                {
                    Path.Combine(user, "source", "repos", "RevitOperator", "operator-backend"),
                    Path.Combine(user, "Source", "Repos", "RevitOperator", "operator-backend"),
                    Path.Combine(user, "repos", "RevitOperator", "operator-backend")
                };
                foreach (var c in common)
                {
                    if (Directory.Exists(c)) return c;
                }
            }
            catch { }

            // Try to infer from any RevitBridge.addin assembly path that points into a repo checkout.
            try
            {
                var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                var addinsRoot = Path.Combine(appData, "Autodesk", "Revit", "Addins");
                if (Directory.Exists(addinsRoot))
                {
                    foreach (var addin in Directory.EnumerateFiles(addinsRoot, "RevitBridge.addin", SearchOption.AllDirectories))
                    {
                        try
                        {
                            var xml = File.ReadAllText(addin);
                            var m = Regex.Match(xml, "<Assembly>([^<]+)</Assembly>", RegexOptions.IgnoreCase);
                            if (!m.Success) continue;
                            var asm = (m.Groups[1].Value ?? "").Trim();
                            if (string.IsNullOrWhiteSpace(asm) || !File.Exists(asm)) continue;

                            var p = Path.GetDirectoryName(asm);
                            if (string.IsNullOrWhiteSpace(p)) continue;
                            var cur = p;
                            for (int i = 0; i < 12; i++)
                            {
                                var candidate = Path.Combine(cur, "operator-backend");
                                if (Directory.Exists(candidate)) return candidate;
                                var parent = Directory.GetParent(cur);
                                if (parent == null) break;
                                cur = parent.FullName;
                            }
                        }
                        catch
                        {
                            // ignore malformed addin files
                        }
                    }
                }
            }
            catch { }

            return null;
        }

        private static string? FindNodeExe()
        {
            try
            {
                var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                var candidate = Path.Combine(programFiles, "nodejs", "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }

            try
            {
                var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
                var candidate = Path.Combine(programFilesX86, "nodejs", "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }

            try
            {
                var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                var candidate = Path.Combine(local, "Programs", "nodejs", "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }

            return null;
        }
    }
}


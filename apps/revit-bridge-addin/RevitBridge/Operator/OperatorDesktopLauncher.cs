using System;
using System.Diagnostics;
using System.IO;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal static class OperatorDesktopLauncher
    {
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
            var candidates = OperatorDesktopLaunchPlan.BuildCandidatePaths(
                ReadSetting("OPERATOR_DESKTOP_LAUNCHER_PATH"),
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                AppContext.BaseDirectory);
            return OperatorDesktopLaunchPlan.ResolveExistingLauncher(candidates);
        }

        public static bool TryLaunch(out string detail)
        {
            var launcherPath = ResolveLauncherPath();
            try
            {
                if (!string.IsNullOrWhiteSpace(launcherPath))
                {
                    StartLauncher(launcherPath);
                    detail = launcherPath;
                    return true;
                }

                Process.Start(new ProcessStartInfo
                {
                    FileName = OperatorDesktopLaunchPlan.DefaultUrl,
                    UseShellExecute = true
                });
                detail = $"No installed launcher was found; opened {OperatorDesktopLaunchPlan.DefaultUrl}.";
                return true;
            }
            catch (Exception ex)
            {
                detail = $"{ex.GetType().Name}: {ex.Message}";
                return false;
            }
        }

        private static void StartLauncher(string launcherPath)
        {
            if (string.Equals(Path.GetExtension(launcherPath), ".ps1", StringComparison.OrdinalIgnoreCase))
            {
                var powershell = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "WindowsPowerShell",
                    "v1.0",
                    "powershell.exe");
                Process.Start(new ProcessStartInfo
                {
                    FileName = powershell,
                    Arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{launcherPath}\"",
                    WorkingDirectory = Path.GetDirectoryName(launcherPath) ?? "",
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
                return;
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = launcherPath,
                WorkingDirectory = Path.GetDirectoryName(launcherPath) ?? "",
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
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
}

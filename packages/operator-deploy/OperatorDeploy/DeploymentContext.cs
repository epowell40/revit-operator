using System.Diagnostics;

namespace RevitOperator.Deployment;

public sealed class DeploymentContext
{
    public string LocalAppData { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    public string AppData { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
    public string Desktop { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
    public string ProgramFiles { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
    public string CommonAppData { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
    public Version WindowsVersion { get; init; } = Environment.OSVersion.Version;
    public Func<bool> IsRevitRunning { get; init; } = () => Process.GetProcessesByName("Revit").Length > 0;
    public Func<DateTimeOffset> UtcNow { get; init; } = () => DateTimeOffset.UtcNow;
    public Func<string, string?> GetEnvironmentVariable { get; init; } = Environment.GetEnvironmentVariable;
    public IDesktopShortcutManager DesktopShortcuts { get; init; } = DesktopShortcutManager.CreateDefault();
    public Func<IDisposable?> TryAcquireDeploymentMutex { get; init; } = DeploymentMutex.TryAcquire;

    public string ProductRoot => Path.Combine(LocalAppData, "RevitOperator");
    public string ReleasesRoot => Path.Combine(ProductRoot, "releases");
    public string DeploymentRoot => Path.Combine(ProductRoot, "deployment");
    public string LogsRoot => Path.Combine(ProductRoot, "logs", "deployment");
    public string ConfigRoot => Path.Combine(ProductRoot, "config");
    public string StatePath => Path.Combine(DeploymentRoot, "state.json");
    public string StableDesktopLauncherPath => Path.Combine(ProductRoot, "Operator Desktop.cmd");
    public string DesktopCommandPath => Path.Combine(Desktop, "Operator Desktop.cmd");
    public string DesktopShortcutPath => Path.Combine(Desktop, "Operator Desktop.lnk");

    public bool IsRevitInstalled(string year)
        => File.Exists(Path.Combine(ProgramFiles, "Autodesk", $"Revit {year}", "Revit.exe"));
}

internal static class DeploymentMutex
{
    private const string Name = @"Global\BIMTools.RevitOperator.OperatorDeploy.v1";

    public static IDisposable? TryAcquire()
    {
        var mutex = new Mutex(initiallyOwned: false, Name);
        try
        {
            var acquired = false;
            try { acquired = mutex.WaitOne(TimeSpan.Zero); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired)
            {
                mutex.Dispose();
                return null;
            }
            return new Lease(mutex);
        }
        catch
        {
            mutex.Dispose();
            throw;
        }
    }

    private sealed class Lease(Mutex mutex) : IDisposable
    {
        private Mutex? _mutex = mutex;
        public void Dispose()
        {
            var value = Interlocked.Exchange(ref _mutex, null);
            if (value == null) return;
            try { value.ReleaseMutex(); }
            finally { value.Dispose(); }
        }
    }
}

public sealed class DeploymentOptions
{
    public string Operation { get; init; } = "";
    public string? ManifestPath { get; init; }
    public bool Quiet { get; init; }
    public bool DryRun { get; init; }
    public bool Force { get; init; }
    public bool BundleOnly { get; init; }
    public string? LogPath { get; init; }
    public string InstallScope { get; init; } = "user";
    public string? RevitVersion { get; init; }
}

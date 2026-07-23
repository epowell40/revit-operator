using System.Diagnostics;

namespace RevitOperator.Deployment;

public sealed class DeploymentContext
{
    public string LocalAppData { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    public string AppData { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
    public string Desktop { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
    public string ProgramFiles { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
    public Func<bool> IsRevitRunning { get; init; } = () => Process.GetProcessesByName("Revit").Length > 0;
    public Func<DateTimeOffset> UtcNow { get; init; } = () => DateTimeOffset.UtcNow;

    public string ProductRoot => Path.Combine(LocalAppData, "RevitOperator");
    public string ReleasesRoot => Path.Combine(ProductRoot, "releases");
    public string DeploymentRoot => Path.Combine(ProductRoot, "deployment");
    public string LogsRoot => Path.Combine(ProductRoot, "logs", "deployment");
    public string ConfigRoot => Path.Combine(ProductRoot, "config");
    public string StatePath => Path.Combine(DeploymentRoot, "state.json");

    public bool IsRevitInstalled(string year)
        => File.Exists(Path.Combine(ProgramFiles, "Autodesk", $"Revit {year}", "Revit.exe"));
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

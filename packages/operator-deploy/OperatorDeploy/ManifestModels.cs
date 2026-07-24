using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitOperator.Deployment;

public sealed class ReleaseManifest
{
    public int SchemaVersion { get; set; }
    public string ReleaseVersion { get; set; } = "";
    public string GeneratedAtUtc { get; set; } = "";
    public string SourceRevision { get; set; } = "";
    public string MinimumWindowsVersion { get; set; } = "10.0.17763";
    public string? BackendUrl { get; set; }
    public string? MinimumBackendApiVersion { get; set; }
    public string? MaximumBackendApiVersion { get; set; }
    public List<ReleaseComponent> Components { get; set; } = new();

    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static ReleaseManifest Load(string path)
    {
        if (!File.Exists(path)) throw new DeploymentException(ExitCodes.ManifestInvalid, $"Manifest not found: {path}");
        try
        {
            var value = JsonSerializer.Deserialize<ReleaseManifest>(File.ReadAllText(path), JsonOptions)
                ?? throw new InvalidDataException("Manifest was empty.");
            value.Validate();
            return value;
        }
        catch (DeploymentException) { throw; }
        catch (Exception ex)
        {
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"Manifest could not be parsed: {ex.Message}", ex);
        }
    }

    public void Validate()
    {
        if (SchemaVersion != 1) throw new DeploymentException(ExitCodes.ManifestInvalid, $"Unsupported manifest schemaVersion {SchemaVersion}; expected 1.");
        if (string.IsNullOrWhiteSpace(ReleaseVersion) || ReleaseVersion.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new DeploymentException(ExitCodes.ManifestInvalid, "releaseVersion is required and must be safe for a directory name.");
        if (!Version.TryParse(MinimumWindowsVersion, out _))
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"minimumWindowsVersion is invalid: '{MinimumWindowsVersion}'.");
        if (Components.Count == 0) throw new DeploymentException(ExitCodes.ManifestInvalid, "Manifest must contain at least one component.");

        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var component in Components)
        {
            if (string.IsNullOrWhiteSpace(component.Id) || !ids.Add(component.Id))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Component id is missing or duplicated: '{component.Id}'.");
            if (component.Kind is not ("revit-addin" or "operator-desktop" or "config-default"))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Component '{component.Id}' has unsupported kind '{component.Kind}'.");
            if (component.Kind == "revit-addin" && (component.RevitYear?.Length != 4 || !int.TryParse(component.RevitYear, out _)))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Component '{component.Id}' requires a four-digit revitYear.");
            EnsureSafeRelativePath(component.PayloadPath, $"component '{component.Id}' payloadPath");
            if (component.Files.Count == 0 && component.Required)
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Required component '{component.Id}' has no files.");

            var filePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in component.Files)
            {
                EnsureSafeRelativePath(file.Path, $"component '{component.Id}' file path");
                if (!filePaths.Add(file.Path)) throw new DeploymentException(ExitCodes.ManifestInvalid, $"Component '{component.Id}' duplicates file '{file.Path}'.");
                if (file.Size < 0) throw new DeploymentException(ExitCodes.ManifestInvalid, $"Component '{component.Id}' file '{file.Path}' has an invalid size.");
                if (file.Sha256.Length != 64 || file.Sha256.Any(ch => !Uri.IsHexDigit(ch)))
                    throw new DeploymentException(ExitCodes.ManifestInvalid, $"Component '{component.Id}' file '{file.Path}' has an invalid SHA-256.");
            }
        }
    }

    public static void EnsureSafeRelativePath(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || Path.IsPathRooted(value))
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"{label} must be a non-empty relative path.");
        var normalized = value.Replace('/', Path.DirectorySeparatorChar);
        if (normalized.Split(Path.DirectorySeparatorChar).Any(part => part is "" or "." or ".."))
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"{label} contains an unsafe path segment.");
    }
}

public sealed class ReleaseComponent
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Version { get; set; } = "";
    public bool Required { get; set; }
    public string InstallScope { get; set; } = "user";
    public string PayloadPath { get; set; } = "";
    public string? RevitYear { get; set; }
    public bool InstallWhenRevitMissing { get; set; } = true;
    public bool PreserveExisting { get; set; }
    public List<ReleaseFile> Files { get; set; } = new();
}

public sealed class ReleaseFile
{
    public string Path { get; set; } = "";
    public long Size { get; set; }
    public string Sha256 { get; set; } = "";
}

public sealed class InstalledState
{
    public int SchemaVersion { get; set; } = 1;
    public string CurrentRelease { get; set; } = "";
    public List<string> SuccessfulReleases { get; set; } = new();
    public string UpdatedAtUtc { get; set; } = "";
}

public sealed class OperationResult
{
    public bool Ok { get; set; }
    public string Operation { get; set; } = "";
    public int ExitCode { get; set; }
    public string Message { get; set; } = "";
    public string? ReleaseVersion { get; set; }
    public string? LogPath { get; set; }
    public List<string> Details { get; set; } = new();
    public List<string> Warnings { get; set; } = new();
}

public static class ExitCodes
{
    public const int Success = 0;
    public const int InvalidArguments = 2;
    public const int ManifestInvalid = 10;
    public const int HashMismatch = 11;
    public const int BlockedProcess = 12;
    public const int PermissionDenied = 13;
    public const int InstallFailed = 20;
    public const int ValidationFailed = 21;
    public const int RollbackFailed = 22;
    public const int NoInstalledRelease = 23;
    public const int Unsupported = 30;
}

public sealed class DeploymentException : Exception
{
    public int ExitCode { get; }
    public DeploymentException(int exitCode, string message, Exception? inner = null) : base(message, inner) => ExitCode = exitCode;
}

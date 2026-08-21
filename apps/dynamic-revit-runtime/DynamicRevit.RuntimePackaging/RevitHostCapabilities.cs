using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitOperator.DynamicRevit.RuntimePackaging;

public sealed class RevitHostCapabilityManifest
{
    public const string CurrentSchema = "dynamic-revit-host-capabilities/v1";
    private static readonly string[] RequiredYears = ["2023", "2024", "2025", "2026"];

    public string Schema { get; set; } = CurrentSchema;
    public string ManifestVersion { get; set; } = "";
    public string ProtocolVersion { get; set; } = "";
    public RevitHostCapability[] Hosts { get; set; } = [];

    public static RevitHostCapabilityManifest LoadTrusted(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("A trusted host-capability manifest path is required.", nameof(path));
        var fullPath = Path.GetFullPath(path);
        using var stream = File.OpenRead(fullPath);
        var manifest = JsonSerializer.Deserialize<RevitHostCapabilityManifest>(stream, JsonOptions)
            ?? throw new InvalidDataException("The trusted host-capability manifest is empty.");
        manifest.Validate();
        return manifest;
    }

    public RevitHostCapability Select(string revitYear)
    {
        if (string.IsNullOrWhiteSpace(revitYear)) throw new ArgumentException("targetRevitYear is required.", nameof(revitYear));
        var selected = Hosts.SingleOrDefault(host => string.Equals(host.RevitYear, revitYear, StringComparison.Ordinal));
        return selected ?? throw new InvalidOperationException($"Revit {revitYear} is not present in the trusted host-capability manifest.");
    }

    public void Validate()
    {
        if (!string.Equals(Schema, CurrentSchema, StringComparison.Ordinal)) throw new InvalidDataException($"Host-capability schema must be {CurrentSchema}.");
        if (string.IsNullOrWhiteSpace(ManifestVersion) || string.IsNullOrWhiteSpace(ProtocolVersion)) throw new InvalidDataException("Host-capability manifest and protocol versions are required.");
        if (Hosts is null) throw new InvalidDataException("Host-capability entries are required.");
        var years = new HashSet<string>(StringComparer.Ordinal);
        foreach (var host in Hosts)
        {
            host.Validate();
            if (!years.Add(host.RevitYear)) throw new InvalidDataException($"Duplicate Revit {host.RevitYear} host-capability entry.");
        }
        if (!RequiredYears.SequenceEqual(years.OrderBy(value => value, StringComparer.Ordinal)))
            throw new InvalidDataException("The trusted host-capability manifest must contain exactly Revit 2023, 2024, 2025, and 2026.");
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
}

public sealed class RevitHostCapability
{
    public string RevitYear { get; set; } = "";
    public string TargetFramework { get; set; } = "";
    public string InstallDirectoryName { get; set; } = "";
    public string ExecutableName { get; set; } = "";
    public string HostArtifactRelativePath { get; set; } = "";
    public string[] SdkDomains { get; set; } = [];

    public string ResolveExpectedExecutable(string programFilesDirectory)
    {
        if (string.IsNullOrWhiteSpace(programFilesDirectory)) throw new ArgumentException("Program Files directory is required.", nameof(programFilesDirectory));
        return Path.GetFullPath(Path.Combine(programFilesDirectory, "Autodesk", InstallDirectoryName, ExecutableName));
    }

    internal void Validate()
    {
        if (RevitYear is not ("2023" or "2024" or "2025" or "2026")) throw new InvalidDataException($"Unsupported Revit host year '{RevitYear}'.");
        var expectedFramework = RevitYear is "2025" or "2026" ? "net8.0-windows" : "net48";
        if (!string.Equals(TargetFramework, expectedFramework, StringComparison.Ordinal)) throw new InvalidDataException($"Revit {RevitYear} must use {expectedFramework}.");
        if (!string.Equals(InstallDirectoryName, "Revit " + RevitYear, StringComparison.Ordinal)) throw new InvalidDataException($"Revit {RevitYear} install directory identity is invalid.");
        if (!string.Equals(ExecutableName, "Revit.exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("The trusted Revit host executable must be Revit.exe.");
        RuntimePackageVerifier.ValidateSafeRelativePath(HostArtifactRelativePath, $"Revit {RevitYear} host artifact");
        if (SdkDomains is null || SdkDomains.Length == 0 || SdkDomains.Any(string.IsNullOrWhiteSpace)) throw new InvalidDataException($"Revit {RevitYear} must declare at least one SDK domain.");
    }
}

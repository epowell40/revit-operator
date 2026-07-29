using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

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
    public List<RevitAddinProfile> RevitAddinProfiles { get; set; } = new();
    public List<ReleaseComponent> Components { get; set; } = new();

    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 32
    };

    public static ReleaseManifest Load(string path)
    {
        if (!File.Exists(path)) throw new DeploymentException(ExitCodes.ManifestInvalid, $"Manifest not found: {path}");
        try
        {
            var json = File.ReadAllText(path);
            RejectDuplicateJsonProperties(json);
            var value = JsonSerializer.Deserialize<ReleaseManifest>(json, JsonOptions)
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
        if (SchemaVersion is not (1 or 2)) throw new DeploymentException(ExitCodes.ManifestInvalid, $"Unsupported manifest schemaVersion {SchemaVersion}; expected 1 or 2.");
        EnsureSafeBaseName(ReleaseVersion, "releaseVersion");
        if (!Version.TryParse(MinimumWindowsVersion, out _))
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"minimumWindowsVersion is invalid: '{MinimumWindowsVersion}'.");
        if (Components.Count == 0) throw new DeploymentException(ExitCodes.ManifestInvalid, "Manifest must contain at least one component.");

        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var profileIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var manifestNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var addInIds = new HashSet<Guid>();
        foreach (var profile in RevitAddinProfiles)
        {
            if (SchemaVersion == 1)
                throw new DeploymentException(ExitCodes.ManifestInvalid, "Schema-v1 manifests cannot declare revitAddinProfiles.");
            EnsureSafeBaseName(profile.Id, "Revit add-in profile id");
            if (!profileIds.Add(profile.Id))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit add-in profile id is duplicated: '{profile.Id}'.");
            EnsureSafeBaseName(profile.ManifestFileName, $"Revit add-in profile '{profile.Id}' manifestFileName");
            if (!profile.ManifestFileName.EndsWith(".addin", StringComparison.OrdinalIgnoreCase))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit add-in profile '{profile.Id}' manifestFileName must end in .addin.");
            if (!manifestNames.Add(profile.ManifestFileName))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit add-in manifestFileName is duplicated: '{profile.ManifestFileName}'.");
            EnsureSafeRelativePath(profile.AssemblyPath, $"Revit add-in profile '{profile.Id}' assemblyPath");
            if (!profile.AssemblyPath.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit add-in profile '{profile.Id}' assemblyPath must name a DLL.");
            if (!profile.Type.Equals("Application", StringComparison.Ordinal))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit add-in profile '{profile.Id}' has unsupported type '{profile.Type}'.");
            EnsureXmlText(profile.Name, 128, $"Revit add-in profile '{profile.Id}' name");
            EnsureDottedIdentifier(profile.FullClassName, $"Revit add-in profile '{profile.Id}' fullClassName");
            EnsureXmlText(profile.VendorId, 32, $"Revit add-in profile '{profile.Id}' vendorId");
            EnsureXmlText(profile.VendorDescription, 256, $"Revit add-in profile '{profile.Id}' vendorDescription");
            if (!Guid.TryParse(profile.AddInId, out var addInId))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit add-in profile '{profile.Id}' addInId must be a GUID.");
            if (!addInIds.Add(addInId))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit add-in addInId is duplicated: '{profile.AddInId}'.");
        }

        var profileReferencesByYear = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var component in Components)
        {
            EnsureSafeBaseName(component.Id, "component id");
            if (!ids.Add(component.Id))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Component id is missing or duplicated: '{component.Id}'.");
            if (component.Kind is not ("revit-addin" or "operator-desktop" or "config-default"))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Component '{component.Id}' has unsupported kind '{component.Kind}'.");
            if (component.Kind == "revit-addin" && (component.RevitYear?.Length != 4 || !int.TryParse(component.RevitYear, out _)))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Component '{component.Id}' requires a four-digit revitYear.");
            if (component.Kind == "revit-addin")
            {
                if (SchemaVersion == 1 && !string.IsNullOrWhiteSpace(component.RevitAddinProfileId))
                    throw new DeploymentException(ExitCodes.ManifestInvalid, $"Schema-v1 component '{component.Id}' cannot declare revitAddinProfileId.");
                if (SchemaVersion == 2)
                {
                    if (string.IsNullOrWhiteSpace(component.RevitAddinProfileId) || !profileIds.Contains(component.RevitAddinProfileId))
                        throw new DeploymentException(ExitCodes.ManifestInvalid, $"Schema-v2 component '{component.Id}' references an unknown revitAddinProfileId.");
                    if (!profileReferencesByYear.TryGetValue(component.RevitYear!, out var references))
                        profileReferencesByYear[component.RevitYear!] = references = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    if (!references.Add(component.RevitAddinProfileId))
                        throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit {component.RevitYear} repeats add-in profile '{component.RevitAddinProfileId}'.");
                }
            }
            else if (!string.IsNullOrWhiteSpace(component.RevitAddinProfileId))
            {
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Non-Revit component '{component.Id}' cannot declare revitAddinProfileId.");
            }
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

        if (SchemaVersion == 2)
        {
            if (Components.Any(component => component.Kind == "revit-addin") && RevitAddinProfiles.Count == 0)
                throw new DeploymentException(ExitCodes.ManifestInvalid, "Schema-v2 Revit components require revitAddinProfiles.");
            foreach (var pair in profileReferencesByYear)
            {
                if (!pair.Value.SetEquals(profileIds))
                    throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit {pair.Key} must contain exactly one component for every declared add-in profile.");
                var missingPolicyCount = Components.Where(component => component.Kind == "revit-addin" && component.RevitYear == pair.Key)
                    .Select(component => component.InstallWhenRevitMissing).Distinct().Count();
                if (missingPolicyCount != 1)
                    throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit {pair.Key} add-in profiles must use one installWhenRevitMissing policy to preserve a complete activation set.");
            }
            var referenced = profileReferencesByYear.Values.SelectMany(value => value).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (!referenced.SetEquals(profileIds))
                throw new DeploymentException(ExitCodes.ManifestInvalid, "Every schema-v2 Revit add-in profile must be referenced by a complete per-year activation set.");
        }
    }

    public static void EnsureSafeRelativePath(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || Path.IsPathRooted(value))
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"{label} must be a non-empty relative path.");
        var normalized = value.Replace('/', Path.DirectorySeparatorChar);
        var parts = normalized.Split(Path.DirectorySeparatorChar);
        if (value.Contains(':') || parts.Any(part => part is "" or "." or ".." || part.EndsWith('.') || !SafeName.IsMatch(part) || IsReservedDeviceName(part)))
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"{label} contains an unsafe path segment.");
    }

    public static void EnsureSafeBaseName(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 128 || value is "." or ".." || value.EndsWith('.') || Path.GetFileName(value) != value ||
            !SafeName.IsMatch(value) || IsReservedDeviceName(value))
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"{label} must be a safe base name.");
    }

    private static readonly Regex SafeName = new("^[A-Za-z0-9][A-Za-z0-9._-]*$", RegexOptions.CultureInvariant);
    private static readonly Regex DottedIdentifier = new("^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)+$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> ReservedDeviceNames = new(
        new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" },
        StringComparer.OrdinalIgnoreCase);

    private static bool IsReservedDeviceName(string value) => ReservedDeviceNames.Contains(Path.GetFileNameWithoutExtension(value));

    private static void EnsureXmlText(string value, int maximumLength, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximumLength || value.Any(char.IsControl))
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"{label} is missing or invalid.");
    }

    private static void EnsureDottedIdentifier(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 256 || !DottedIdentifier.IsMatch(value))
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"{label} must be a dotted CLR identifier.");
    }

    private static void RejectDuplicateJsonProperties(string json)
    {
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 32 });
        Inspect(document.RootElement);
        static void Inspect(JsonElement element)
        {
            if (element.ValueKind == JsonValueKind.Object)
            {
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var property in element.EnumerateObject())
                {
                    if (!names.Add(property.Name)) throw new InvalidDataException($"Duplicate JSON property '{property.Name}'.");
                    Inspect(property.Value);
                }
            }
            else if (element.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in element.EnumerateArray()) Inspect(item);
            }
        }
    }
}

public sealed class RevitAddinProfile
{
    public string Id { get; set; } = "";
    public string ManifestFileName { get; set; } = "";
    public string AssemblyPath { get; set; } = "";
    public string Type { get; set; } = "Application";
    public string Name { get; set; } = "";
    public string FullClassName { get; set; } = "";
    public string AddInId { get; set; } = "";
    public string VendorId { get; set; } = "";
    public string VendorDescription { get; set; } = "";
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
    public string? RevitAddinProfileId { get; set; }
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
    public int SchemaVersion { get; set; } = 2;
    public string CurrentRelease { get; set; } = "";
    public List<string> SuccessfulReleases { get; set; } = new();
    public string UpdatedAtUtc { get; set; } = "";
    public List<OwnedAddinManifest> OwnedAddinManifests { get; set; } = new();
}

public sealed class OwnedAddinManifest
{
    public string RevitYear { get; set; } = "";
    public string ProfileId { get; set; } = "";
    public string ManifestPath { get; set; } = "";
    public string ManifestFileName { get; set; } = "";
    public string AddInId { get; set; } = "";
    public string FullClassName { get; set; } = "";
    public string AssemblyPath { get; set; } = "";
    public string ManifestSha256 { get; set; } = "";
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

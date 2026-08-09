using System.Security.Cryptography;
using System.Text.Json;
using RevitOperator.DynamicRevitSdk;

namespace RevitOperator.DynamicRevit.RuntimePackaging;

public sealed class DynamicRuntimePackageManifest
{
    public const string CurrentSchema = "dynamic-revit-runtime-package/v1";

    public string Schema { get; set; } = CurrentSchema;
    public string PackageVersion { get; set; } = "";
    public string ProtocolVersion { get; set; } = "";
    public string SdkManifestHash { get; set; } = "";
    public PackageDirectoryIdentity Supervisor { get; set; } = new();
    public PackageDirectoryIdentity Worker { get; set; } = new();
    public PackageArtifactIdentity Sdk { get; set; } = new();
    public PackageArtifactIdentity SandboxPolicy { get; set; } = new();
    public string SandboxProfile { get; set; } = "";
    public string SandboxProfileVersion { get; set; } = "";
    public string HostCapabilitiesManifestSha256 { get; set; } = "";
    public RevitHostPackageIdentity[] Hosts { get; set; } = [];
}

public sealed class PackageArtifactIdentity
{
    public string RelativePath { get; set; } = "";
    public string Sha256 { get; set; } = "";
}

public sealed class PackageDirectoryIdentity
{
    public string RelativePath { get; set; } = "";
    public string Sha256 { get; set; } = "";
}

public sealed class RevitHostPackageIdentity
{
    public string RevitYear { get; set; } = "";
    public string TargetFramework { get; set; } = "";
    public PackageArtifactIdentity Artifact { get; set; } = new();
}

public sealed class RuntimePackageVerification
{
    public bool Ok => Errors.Count == 0;
    public List<string> Errors { get; } = [];
    public List<string> VerifiedArtifacts { get; } = [];
}

public static class RuntimePackageVerifier
{
    public static RuntimePackageVerification Verify(
        string packageRoot,
        DynamicRuntimePackageManifest package,
        string trustedHostCapabilitiesManifestPath,
        string expectedSdkManifestHash)
    {
        ArgumentNullException.ThrowIfNull(package);
        var result = new RuntimePackageVerification();
        RevitHostCapabilityManifest hostCapabilities;
        string capabilitiesHash;
        try
        {
            var capabilitiesPath = Path.GetFullPath(trustedHostCapabilitiesManifestPath);
            hostCapabilities = RevitHostCapabilityManifest.LoadTrusted(capabilitiesPath);
            capabilitiesHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(capabilitiesPath))).ToLowerInvariant();
        }
        catch (Exception ex)
        {
            result.Errors.Add("Trusted host-capability manifest is invalid: " + ex.Message);
            return result;
        }
        string root;
        try { root = Path.GetFullPath(packageRoot); }
        catch (Exception ex) { result.Errors.Add("Package root is invalid: " + ex.Message); return result; }

        if (!string.Equals(package.Schema, DynamicRuntimePackageManifest.CurrentSchema, StringComparison.Ordinal)) result.Errors.Add("Package schema is not dynamic-revit-runtime-package/v1.");
        if (string.IsNullOrWhiteSpace(package.PackageVersion)) result.Errors.Add("Package version is required.");
        if (!string.Equals(package.ProtocolVersion, hostCapabilities.ProtocolVersion, StringComparison.Ordinal)) result.Errors.Add("Package and host-capability protocol versions do not match.");
        if (!IsSdkManifestIdentity(package.SdkManifestHash) || !FixedEquals(package.SdkManifestHash, expectedSdkManifestHash)) result.Errors.Add("SDK manifest identity does not match the trusted SDK.");
        if (!IsSha256(package.HostCapabilitiesManifestSha256) || !FixedEquals(package.HostCapabilitiesManifestSha256, capabilitiesHash)) result.Errors.Add("Host-capability manifest identity does not match the trusted manifest.");
        if (string.IsNullOrWhiteSpace(package.SandboxProfile) || string.IsNullOrWhiteSpace(package.SandboxProfileVersion)) result.Errors.Add("Sandbox profile identity and version are required.");

        VerifyDirectory(root, "supervisor package", package.Supervisor, result);
        VerifyDirectory(root, "worker package", package.Worker, result);
        VerifyArtifact(root, "sdk", package.Sdk, result);
        VerifyArtifact(root, "sandbox policy", package.SandboxPolicy, result);
        VerifySandboxPolicy(root, package, result);
        foreach (var relativeCapabilitiesPath in new[] { "manifests/revit-host-capabilities.v1.json", "supervisor/manifests/revit-host-capabilities.v1.json" })
        {
            var packagedCapabilitiesPath = Path.Combine(root, relativeCapabilitiesPath.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(packagedCapabilitiesPath)) result.Errors.Add($"Packaged host-capability manifest is missing: {relativeCapabilitiesPath}");
            else if (ContainsReparsePoint(root, packagedCapabilitiesPath)) result.Errors.Add($"Packaged host-capability manifest may not use a reparse point: {relativeCapabilitiesPath}");
            else
            {
                var packagedCapabilitiesHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(packagedCapabilitiesPath))).ToLowerInvariant();
                if (!FixedEquals(packagedCapabilitiesHash, capabilitiesHash)) result.Errors.Add($"Packaged host-capability manifest differs from the trusted manifest: {relativeCapabilitiesPath}");
                else result.VerifiedArtifacts.Add(relativeCapabilitiesPath);
            }
        }

        var rawHosts = package.Hosts ?? [];
        if (rawHosts.Any(host => host is null)) result.Errors.Add("Package host entries may not be null.");
        var hosts = rawHosts.Where(host => host is not null).ToArray();
        var duplicateYears = hosts.GroupBy(host => host.RevitYear, StringComparer.Ordinal).Where(group => group.Count() != 1).Select(group => group.Key).ToArray();
        if (duplicateYears.Length > 0) result.Errors.Add("Duplicate packaged Revit host years: " + string.Join(", ", duplicateYears));
        foreach (var capability in hostCapabilities.Hosts)
        {
            var host = hosts.FirstOrDefault(candidate => string.Equals(candidate.RevitYear, capability.RevitYear, StringComparison.Ordinal));
            if (host is null) { result.Errors.Add($"Revit {capability.RevitYear} host artifact is missing."); continue; }
            if (!string.Equals(host.TargetFramework, capability.TargetFramework, StringComparison.Ordinal)) result.Errors.Add($"Revit {capability.RevitYear} target framework does not match its trusted capability entry.");
            if (host.Artifact is null) { result.Errors.Add($"Revit {capability.RevitYear} host artifact identity is missing."); continue; }
            if (!string.Equals(NormalizeRelativePath(host.Artifact.RelativePath), NormalizeRelativePath(capability.HostArtifactRelativePath), StringComparison.OrdinalIgnoreCase)) result.Errors.Add($"Revit {capability.RevitYear} host path does not match its trusted capability entry.");
            VerifyArtifact(root, "Revit " + capability.RevitYear + " host", host.Artifact, result);
        }
        foreach (var unexpected in hosts.Where(host => hostCapabilities.Hosts.All(capability => capability.RevitYear != host.RevitYear))) result.Errors.Add($"Unexpected Revit {unexpected.RevitYear} host artifact.");
        var artifactPaths = new[] { package.Sdk, package.SandboxPolicy }.Concat(hosts.Select(host => host.Artifact))
            .Where(artifact => artifact is not null).Select(artifact => NormalizeRelativePath(artifact.RelativePath))
            .Concat(new[] { NormalizeRelativePath(package.Supervisor?.RelativePath), NormalizeRelativePath(package.Worker?.RelativePath) })
            .ToArray();
        if (artifactPaths.Distinct(StringComparer.OrdinalIgnoreCase).Count() != artifactPaths.Length) result.Errors.Add("Package artifact paths must be unique.");
        return result;
    }

    internal static void ValidateSafeRelativePath(string relativePath, string name)
    {
        if (string.IsNullOrWhiteSpace(relativePath) || Path.IsPathRooted(relativePath)) throw new InvalidDataException($"{name} path must be relative.");
        var segments = relativePath.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0 || segments.Any(segment => segment is "." or "..")) throw new InvalidDataException($"{name} path may not traverse outside the package.");
    }

    private static void VerifyArtifact(string root, string name, PackageArtifactIdentity? artifact, RuntimePackageVerification result)
    {
        if (artifact is null) { result.Errors.Add($"{name} artifact identity is missing."); return; }
        try { ValidateSafeRelativePath(artifact.RelativePath, name); }
        catch (InvalidDataException ex) { result.Errors.Add(ex.Message); return; }
        if (!IsSha256(artifact.Sha256)) { result.Errors.Add($"{name} artifact hash is invalid."); return; }
        var path = Path.GetFullPath(Path.Combine(root, artifact.RelativePath));
        var relative = Path.GetRelativePath(root, path);
        if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)) { result.Errors.Add($"{name} artifact resolves outside the package."); return; }
        if (!File.Exists(path)) { result.Errors.Add($"{name} artifact is missing: {artifact.RelativePath}"); return; }
        if (ContainsReparsePoint(root, path)) { result.Errors.Add($"{name} artifact may not use a reparse point."); return; }
        var observed = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
        if (!FixedEquals(observed, artifact.Sha256)) { result.Errors.Add($"{name} artifact hash mismatch."); return; }
        result.VerifiedArtifacts.Add(NormalizeRelativePath(artifact.RelativePath));
    }

    private static void VerifyDirectory(string root, string name, PackageDirectoryIdentity? directory, RuntimePackageVerification result)
    {
        if (directory is null) { result.Errors.Add($"{name} identity is missing."); return; }
        try { ValidateSafeRelativePath(directory.RelativePath, name); }
        catch (InvalidDataException ex) { result.Errors.Add(ex.Message); return; }
        if (!IsDirectorySha256(directory.Sha256)) { result.Errors.Add($"{name} hash is invalid."); return; }
        var path = Path.GetFullPath(Path.Combine(root, directory.RelativePath));
        var relative = Path.GetRelativePath(root, path);
        if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)) { result.Errors.Add($"{name} resolves outside the package."); return; }
        if (!Directory.Exists(path)) { result.Errors.Add($"{name} is missing: {directory.RelativePath}"); return; }
        try
        {
            var observed = ComputeDirectorySha256(path);
            if (!FixedEquals(observed, directory.Sha256)) { result.Errors.Add($"{name} hash mismatch."); return; }
        }
        catch (InvalidDataException ex) { result.Errors.Add(ex.Message); return; }
        result.VerifiedArtifacts.Add(NormalizeRelativePath(directory.RelativePath) + "/");
    }

    public static string ComputeDirectorySha256(string directory)
    {
        return DynamicRuntimePackageDirectoryIdentity.Compute(directory);
    }

    private static void VerifySandboxPolicy(string root, DynamicRuntimePackageManifest package, RuntimePackageVerification result)
    {
        if (package.SandboxPolicy is null) return;
        try
        {
            ValidateSafeRelativePath(package.SandboxPolicy.RelativePath, "sandbox policy");
            var path = Path.GetFullPath(Path.Combine(root, package.SandboxPolicy.RelativePath));
            if (!File.Exists(path)) return;
            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            var policy = document.RootElement;
            if (policy.GetProperty("schema").GetString() != "dynamic-revit-sandbox-policy/v1"
                || policy.GetProperty("profile").GetString() != package.SandboxProfile
                || policy.GetProperty("profileVersion").GetString() != package.SandboxProfileVersion)
                result.Errors.Add("Sandbox policy content does not match the package sandbox identity.");
        }
        catch (Exception ex)
        {
            result.Errors.Add("Sandbox policy content is invalid: " + ex.Message);
        }
    }

    private static string NormalizeRelativePath(string? path) => (path ?? "").Replace('\\', '/').TrimStart('/');
    private static bool ContainsReparsePoint(string root, string path)
    {
        var rootWithSeparator = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var current = Path.GetFullPath(path);
        if (string.Equals(current, root, StringComparison.OrdinalIgnoreCase)) return (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0;
        while (current.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase))
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return true;
            var parent = Path.GetDirectoryName(current);
            if (string.IsNullOrEmpty(parent) || string.Equals(parent, root, StringComparison.OrdinalIgnoreCase)) break;
            current = parent;
        }
        return false;
    }
    private static bool IsSha256(string? value) => value is { Length: 64 } && value.All(character => Uri.IsHexDigit(character));
    private static bool IsDirectorySha256(string? value) => value is { Length: 71 } && value.StartsWith("sha256:", StringComparison.Ordinal) && value[7..].All(character => Uri.IsHexDigit(character));
    private static bool IsSdkManifestIdentity(string? value) => value is { Length: 71 } && value.StartsWith("sha256:", StringComparison.Ordinal) && value[7..].All(character => Uri.IsHexDigit(character));
    private static bool FixedEquals(string? left, string? right)
    {
        if (left is null || right is null) return false;
        var a = System.Text.Encoding.ASCII.GetBytes(left.ToLowerInvariant());
        var b = System.Text.Encoding.ASCII.GetBytes(right.ToLowerInvariant());
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }
}

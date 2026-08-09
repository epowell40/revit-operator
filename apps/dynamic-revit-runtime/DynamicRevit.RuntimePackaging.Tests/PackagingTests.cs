using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevitOperator.DynamicRevit.RuntimePackaging;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace RevitOperator.DynamicRevit.RuntimePackaging.Tests;

public sealed class PackagingTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "dynamic-runtime-packaging-tests", Guid.NewGuid().ToString("N"));

    [Theory]
    [InlineData("2023", "net48")]
    [InlineData("2024", "net48")]
    [InlineData("2025", "net8.0-windows")]
    public void Trusted_manifest_selects_exact_host_identity(string year, string framework)
    {
        var path = WriteCapabilitiesManifest();
        var selected = RevitHostCapabilityManifest.LoadTrusted(path).Select(year);

        Assert.Equal(framework, selected.TargetFramework);
        Assert.Equal(Path.GetFullPath(Path.Combine(_root, "Program Files", "Autodesk", "Revit " + year, "Revit.exe")), selected.ResolveExpectedExecutable(Path.Combine(_root, "Program Files")));
        Assert.Equal($"hosts/{year}/DynamicRevitHost.dll", selected.HostArtifactRelativePath);
    }

    [Fact]
    public void Trusted_manifest_fails_closed_for_unknown_year()
    {
        var manifest = RevitHostCapabilityManifest.LoadTrusted(WriteCapabilitiesManifest());
        var error = Assert.Throws<InvalidOperationException>(() => manifest.Select("2026"));
        Assert.Contains("not present", error.Message);
    }

    [Fact]
    public void Package_verifier_binds_all_runtime_and_year_artifacts()
    {
        var capabilitiesPath = WriteCapabilitiesManifest();
        var sdkManifestHash = "sha256:" + HashText("trusted-sdk-manifest");
        var package = WritePackage(capabilitiesPath, sdkManifestHash);

        var result = RuntimePackageVerifier.Verify(_root, package, capabilitiesPath, sdkManifestHash);

        Assert.True(result.Ok, string.Join(Environment.NewLine, result.Errors));
        Assert.Equal(9, result.VerifiedArtifacts.Count);
        Assert.Equal(DynamicRuntimePackageDirectoryIdentity.Compute(Path.Combine(_root, package.Supervisor.RelativePath)), package.Supervisor.Sha256);
    }

    [Fact]
    public void Package_verifier_rejects_tampering_and_path_escape()
    {
        var capabilitiesPath = WriteCapabilitiesManifest();
        var sdkManifestHash = "sha256:" + HashText("trusted-sdk-manifest");
        var package = WritePackage(capabilitiesPath, sdkManifestHash);
        File.AppendAllText(Path.Combine(_root, package.Worker.RelativePath, "DynamicRevitWorker.exe"), "tampered");
        package.Supervisor.RelativePath = "../outside.exe";

        var result = RuntimePackageVerifier.Verify(_root, package, capabilitiesPath, sdkManifestHash);

        Assert.False(result.Ok);
        Assert.Contains(result.Errors, error => error.Contains("supervisor package path may not traverse", StringComparison.Ordinal));
        Assert.Contains(result.Errors, error => error.Contains("worker package hash mismatch", StringComparison.Ordinal));
    }

    [Fact]
    public void Package_verifier_reports_duplicate_host_identity_without_throwing()
    {
        var capabilitiesPath = WriteCapabilitiesManifest();
        var sdkManifestHash = "sha256:" + HashText("trusted-sdk-manifest");
        var package = WritePackage(capabilitiesPath, sdkManifestHash);
        package.Hosts = package.Hosts.Append(package.Hosts[0]).ToArray();

        var result = RuntimePackageVerifier.Verify(_root, package, capabilitiesPath, sdkManifestHash);

        Assert.False(result.Ok);
        Assert.Contains(result.Errors, error => error.Contains("Duplicate packaged Revit host years: 2023", StringComparison.Ordinal));
    }

    private DynamicRuntimePackageManifest WritePackage(string capabilitiesPath, string sdkManifestHash)
    {
        PackageArtifactIdentity Artifact(string path, string content)
        {
            var fullPath = Path.Combine(_root, path.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
            File.WriteAllText(fullPath, content);
            return new PackageArtifactIdentity { RelativePath = path, Sha256 = HashFile(fullPath) };
        }

        PackageDirectoryIdentity DirectoryIdentity(string path) => new() { RelativePath = path, Sha256 = RuntimePackageVerifier.ComputeDirectorySha256(Path.Combine(_root, path)) };

        Artifact("supervisor/DynamicRevitSandboxSupervisor.exe", "supervisor");
        Artifact("worker/DynamicRevitWorker.exe", "worker");
        Artifact("worker/DynamicRevitSdk.dll", "sdk");

        return new DynamicRuntimePackageManifest
        {
            PackageVersion = "1.0.0-test",
            ProtocolVersion = "dynamic-revit-protocol/v0",
            SdkManifestHash = sdkManifestHash,
            Supervisor = DirectoryIdentity("supervisor"),
            Worker = DirectoryIdentity("worker"),
            Sdk = Artifact("worker/DynamicRevitSdk.dll", "sdk"),
            SandboxPolicy = Artifact("manifests/sandbox-policy.v1.json", "{\"schema\":\"dynamic-revit-sandbox-policy/v1\",\"profile\":\"windows-lpac-v1-zero-capabilities\",\"profileVersion\":\"1.0.0\"}"),
            SandboxProfile = "windows-lpac-v1-zero-capabilities",
            SandboxProfileVersion = "1.0.0",
            HostCapabilitiesManifestSha256 = HashFile(capabilitiesPath),
            Hosts =
            [
                new() { RevitYear = "2023", TargetFramework = "net48", Artifact = Artifact("hosts/2023/DynamicRevitHost.dll", "host-2023") },
                new() { RevitYear = "2024", TargetFramework = "net48", Artifact = Artifact("hosts/2024/DynamicRevitHost.dll", "host-2024") },
                new() { RevitYear = "2025", TargetFramework = "net8.0-windows", Artifact = Artifact("hosts/2025/DynamicRevitHost.dll", "host-2025") }
            ]
        };
    }

    private string WriteCapabilitiesManifest()
    {
        Directory.CreateDirectory(_root);
        var source = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "manifests", "revit-host-capabilities.v1.json"));
        var destination = Path.Combine(_root, "revit-host-capabilities.v1.json");
        File.Copy(source, destination, true);
        var packagedDestination = Path.Combine(_root, "manifests", "revit-host-capabilities.v1.json");
        Directory.CreateDirectory(Path.GetDirectoryName(packagedDestination)!);
        File.Copy(source, packagedDestination, true);
        var supervisorDestination = Path.Combine(_root, "supervisor", "manifests", "revit-host-capabilities.v1.json");
        Directory.CreateDirectory(Path.GetDirectoryName(supervisorDestination)!);
        File.Copy(source, supervisorDestination, true);
        return destination;
    }

    private static string HashText(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static string HashFile(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}

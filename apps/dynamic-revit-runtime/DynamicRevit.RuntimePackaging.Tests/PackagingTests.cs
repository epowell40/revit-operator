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
        Assert.Equal(15, result.VerifiedArtifacts.Count);
        Assert.Contains("manifests/dynamic-revit-annotation-operations.v1.json", result.VerifiedArtifacts);
        Assert.Contains("manifests/dynamic-revit-mep-mutations.v1.json", result.VerifiedArtifacts);
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
    public void Package_verifier_rejects_substituted_mep_descriptor_even_with_updated_artifact_hash()
    {
        var capabilitiesPath = WriteCapabilitiesManifest(); var sdkManifestHash = "sha256:" + HashText("trusted-sdk-manifest");
        var package = WritePackage(capabilitiesPath, sdkManifestHash);
        var path = Path.Combine(_root, package.MepMutationContract.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.WriteAllText(path, File.ReadAllText(path).Replace("\"outputs\": 1", "\"outputs\": 2", StringComparison.Ordinal));
        package.MepMutationContract.Sha256 = HashFile(path);

        var result = RuntimePackageVerifier.Verify(_root, package, capabilitiesPath, sdkManifestHash);

        Assert.False(result.Ok);
        Assert.Contains(result.Errors, error => error.Contains("MEP mutation contract manifest content is invalid", StringComparison.Ordinal));
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

    [Fact]
    public void Package_verifier_binds_observation_source_manifest_to_sdk_contract_identity()
    {
        var capabilitiesPath = WriteCapabilitiesManifest();
        var sdkManifestHash = "sha256:" + HashText("trusted-sdk-manifest");
        var package = WritePackage(capabilitiesPath, sdkManifestHash);
        var path = Path.Combine(_root, package.ObservationContract.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.WriteAllText(path, File.ReadAllText(path).Replace(DynamicObservationContractV1.ManifestHash, "sha256:" + new string('0', 64), StringComparison.Ordinal));
        package.ObservationContract.Sha256 = HashFile(path);

        var result = RuntimePackageVerifier.Verify(_root, package, capabilitiesPath, sdkManifestHash);

        Assert.False(result.Ok);
        Assert.Contains(result.Errors, error => error.Contains("Observation contract manifest content is invalid", StringComparison.Ordinal));
    }

    [Fact]
    public void Package_verifier_binds_core_operation_source_manifest_and_rotation()
    {
        var capabilitiesPath = WriteCapabilitiesManifest();
        var sdkManifestHash = "sha256:" + HashText("trusted-sdk-manifest");
        var package = WritePackage(capabilitiesPath, sdkManifestHash);
        var path = Path.Combine(_root, package.CoreOperationsContract.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.WriteAllText(path, File.ReadAllText(path).Replace(DynamicCoreOperationManifestV1.ManifestHash, "sha256:" + new string('0', 64), StringComparison.Ordinal));
        package.CoreOperationsContract.Sha256 = HashFile(path);

        var result = RuntimePackageVerifier.Verify(_root, package, capabilitiesPath, sdkManifestHash);

        Assert.False(result.Ok);
        Assert.Contains(result.Errors, error => error.Contains("Core operations contract manifest content is invalid", StringComparison.Ordinal));
    }

    [Fact]
    public void Package_verifier_binds_building_systems_manifest_to_sdk_surface()
    {
        var capabilitiesPath = WriteCapabilitiesManifest();
        var sdkManifestHash = "sha256:" + HashText("trusted-sdk-manifest");
        var package = WritePackage(capabilitiesPath, sdkManifestHash);
        var path = Path.Combine(_root, package.BuildingSystemsObservationContract.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.WriteAllText(path, File.ReadAllText(path).Replace(DynamicBuildingSystemsObservationContractV1.ContractSurfaceHash, "sha256:" + new string('0', 64), StringComparison.Ordinal));
        package.BuildingSystemsObservationContract.Sha256 = HashFile(path);

        var result = RuntimePackageVerifier.Verify(_root, package, capabilitiesPath, sdkManifestHash);

        Assert.False(result.Ok);
        Assert.Contains(result.Errors, error => error.Contains("Building-systems observation manifest content is invalid", StringComparison.Ordinal));
    }

    [Fact]
    public void Package_verifier_binds_result_reference_source_manifest_and_rotation()
    {
        var capabilitiesPath = WriteCapabilitiesManifest();
        var sdkManifestHash = "sha256:" + HashText("trusted-sdk-manifest");
        var package = WritePackage(capabilitiesPath, sdkManifestHash);
        var path = Path.Combine(_root, package.ResultReferenceContract.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.WriteAllText(path, File.ReadAllText(path).Replace(DynamicResultReferenceManifestV1.ManifestHash, "sha256:" + new string('0', 64), StringComparison.Ordinal));
        package.ResultReferenceContract.Sha256 = HashFile(path);

        var result = RuntimePackageVerifier.Verify(_root, package, capabilitiesPath, sdkManifestHash);

        Assert.False(result.Ok);
        Assert.Contains(result.Errors, error => error.Contains("Result-reference contract manifest content is invalid", StringComparison.Ordinal));
    }

    [Fact]
    public void Package_verifier_binds_annotation_operations_to_exact_sdk_surface()
    {
        var capabilitiesPath = WriteCapabilitiesManifest(); var sdkManifestHash = "sha256:" + HashText("trusted-sdk-manifest");
        var package = WritePackage(capabilitiesPath, sdkManifestHash);
        var path = Path.Combine(_root, package.AnnotationOperationsContract.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.WriteAllText(path, File.ReadAllText(path).Replace(DynamicAnnotationOperationManifestV1.ContractSurfaceHash, "sha256:" + new string('0', 64), StringComparison.Ordinal));
        package.AnnotationOperationsContract.Sha256 = HashFile(path);
        var result = RuntimePackageVerifier.Verify(_root, package, capabilitiesPath, sdkManifestHash);
        Assert.False(result.Ok);
        Assert.Contains(result.Errors, error => error.Contains("Annotation operations contract manifest content is invalid", StringComparison.Ordinal));
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
            ProtocolVersion = "dynamic-revit-protocol/v1",
            SdkManifestHash = sdkManifestHash,
            Supervisor = DirectoryIdentity("supervisor"),
            Worker = DirectoryIdentity("worker"),
            Sdk = Artifact("worker/DynamicRevitSdk.dll", "sdk"),
            SandboxPolicy = Artifact("manifests/sandbox-policy.v1.json", "{\"schema\":\"dynamic-revit-sandbox-policy/v1\",\"profile\":\"windows-lpac-v1-zero-capabilities\",\"profileVersion\":\"1.0.0\"}"),
            ObservationContract = Artifact("manifests/dynamic-revit-observations-core.v1.json", ObservationContractManifest()),
            BuildingSystemsObservationContract = Artifact("manifests/dynamic-revit-building-systems-observations.v1.json", BuildingSystemsObservationContractManifest()),
            CoreOperationsContract = Artifact("manifests/dynamic-revit-operations-core.v1.json", CoreOperationsContractManifest()),
            ResultReferenceContract = Artifact("manifests/dynamic-revit-result-reference-graph.v1.json", ResultReferenceContractManifest()),
            AnnotationOperationsContract = Artifact("manifests/dynamic-revit-annotation-operations.v1.json", AnnotationOperationsContractManifest()),
            MepMutationContract = Artifact("manifests/dynamic-revit-mep-mutations.v1.json", File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "manifests", "dynamic-revit-mep-mutations.v1.json")))),
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

    private static string ObservationContractManifest() => JsonSerializer.Serialize(new
    {
        schema = DynamicObservationContractV1.ManifestSchema,
        manifestVersion = "1.0.0",
        contractManifestHash = DynamicObservationContractV1.ManifestHash,
        selectorSchema = DynamicObservationContractV1.SelectorSchema,
        envelopeSchema = DynamicObservationContractV1.EnvelopeSchema,
        cursorSchema = DynamicObservationContractV1.CursorSchema,
        canonicalVersion = DynamicObservationContractV1.CanonicalVersion,
        readOnly = true,
        limits = new
        {
            maximumRequestBytes = DynamicObservationContractV1.MaximumRequestBytes,
            maximumPageSize = DynamicObservationContractV1.MaximumPageSize,
            maximumObservedElements = DynamicObservationContractV1.MaximumObservedElements,
            maximumElementSelectors = DynamicObservationContractV1.MaximumElementSelectors,
            maximumCategorySelectors = DynamicObservationContractV1.MaximumCategorySelectors,
            maximumOwnerViewSelectors = DynamicObservationContractV1.MaximumOwnerViewSelectors,
            maximumParameterSelectors = DynamicObservationContractV1.MaximumParameterSelectors,
            maximumParametersPerElement = DynamicObservationContractV1.MaximumParametersPerElement
        }
    });

    private static string CoreOperationsContractManifest() => JsonSerializer.Serialize(new
    {
        schema = DynamicCoreOperationsV1.ManifestSchema,
        manifestVersion = "1.0.0",
        contractManifestHash = DynamicCoreOperationManifestV1.ManifestHash,
        contractSurfaceHash = DynamicCoreOperationManifestV1.ContractSurfaceHash,
        primitiveManifestHash = DynamicPrimitiveManifestV1.ManifestHash,
        canonicalVersion = DynamicCoreOperationsV1.CanonicalVersion,
        maximumOperations = DynamicCoreOperationsV1.MaximumOperations,
        maximumAttributes = DynamicCoreOperationsV1.MaximumAttributes,
        productionExposed = false,
        primitives = DynamicCoreOperationManifestV1.All.Select(value => new { kind = value.Kind, version = value.PrimitiveVersion, preview = value.PreviewSupported, apply = value.ApplySupported })
    });

    private static string BuildingSystemsObservationContractManifest() => JsonSerializer.Serialize(new
    {
        schema = DynamicBuildingSystemsObservationContractV1.ManifestSchema,
        manifestVersion = "1.0.0",
        contractManifestHash = DynamicBuildingSystemsObservationContractV1.ManifestHash,
        contractSurfaceHash = DynamicBuildingSystemsObservationContractV1.ContractSurfaceHash,
        selectorSchema = DynamicBuildingSystemsObservationContractV1.SelectorSchema,
        envelopeSchema = DynamicBuildingSystemsObservationContractV1.EnvelopeSchema,
        cursorSchema = DynamicBuildingSystemsObservationContractV1.CursorSchema,
        canonicalVersion = DynamicBuildingSystemsObservationContractV1.CanonicalVersion,
        readOnly = true,
        productionExposed = false,
        limits = new
        {
            maximumRequestBytes = DynamicBuildingSystemsObservationContractV1.MaximumRequestBytes,
            maximumPageSize = DynamicBuildingSystemsObservationContractV1.MaximumPageSize,
            maximumObservedFacts = DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts,
            maximumElementSelectors = DynamicBuildingSystemsObservationContractV1.MaximumElementSelectors,
            maximumCategorySelectors = DynamicBuildingSystemsObservationContractV1.MaximumCategorySelectors,
            maximumKindSelectors = DynamicBuildingSystemsObservationContractV1.MaximumKindSelectors,
            maximumParameterSelectors = DynamicBuildingSystemsObservationContractV1.MaximumParameterSelectors,
            maximumParametersPerFact = DynamicBuildingSystemsObservationContractV1.MaximumParametersPerFact,
            maximumConnectorsPerFact = DynamicBuildingSystemsObservationContractV1.MaximumConnectorsPerFact,
            maximumConnectionsPerConnector = DynamicBuildingSystemsObservationContractV1.MaximumConnectionsPerConnector,
            maximumSystemMembers = DynamicBuildingSystemsObservationContractV1.MaximumSystemMembers
        }
    });

    private static string ResultReferenceContractManifest() => JsonSerializer.Serialize(new
    {
        schema = DynamicResultReferenceContractV1.ManifestSchema,
        manifestVersion = "1.0.0",
        contractManifestHash = DynamicResultReferenceManifestV1.ManifestHash,
        contractSurfaceHash = DynamicResultReferenceManifestV1.ContractSurfaceHash,
        graphSchema = DynamicResultReferenceContractV1.GraphSchema,
        outputFactSchema = DynamicResultReferenceContractV1.OutputFactSchema,
        receiptSchema = DynamicResultReferenceContractV1.ReceiptSchema,
        programResultSchema = DynamicResultReferenceContractV1.ProgramResultSchema,
        canonicalVersion = DynamicResultReferenceContractV1.CanonicalVersion,
        maximumNodes = DynamicResultReferenceContractV1.MaximumNodes,
        maximumOutputsPerNode = DynamicResultReferenceContractV1.MaximumOutputsPerNode,
        maximumReferencesPerNode = DynamicResultReferenceContractV1.MaximumReferencesPerNode,
        maximumAttributesPerNode = DynamicResultReferenceContractV1.MaximumAttributesPerNode,
        maximumBuildingSystemsPages = DynamicResultReferenceContractV1.MaximumBuildingSystemsPages,
        maximumTrustedExternalTargets = DynamicResultReferenceContractV1.MaximumTrustedExternalTargets,
        productionExposed = false
    });

    private static string AnnotationOperationsContractManifest() => JsonSerializer.Serialize(new
    {
        schema = DynamicAnnotationOperationsV1.ManifestSchema, manifestVersion = "1.0.0",
        contractManifestHash = DynamicAnnotationOperationManifestV1.ManifestHash, contractSurfaceHash = DynamicAnnotationOperationManifestV1.ContractSurfaceHash,
        resultReferenceManifestHash = DynamicResultReferenceManifestV1.ManifestHash, readbackSchema = DynamicAnnotationOperationsV1.ReadbackSchema,
        previewSchema = DynamicAnnotationOperationsV1.PreviewSchema, canonicalVersion = DynamicAnnotationOperationsV1.CanonicalVersion,
        maximumTextLength = DynamicAnnotationOperationsV1.MaximumTextLength, productionExposed = false,
        primitives = DynamicAnnotationOperationManifestV1.All.Select(value => new { kind = value.Kind, version = value.PrimitiveVersion, effectClass = value.EffectClass, externalTargetCount = value.ExternalTargetCount, outputCount = value.OutputCount, requiredAttributes = value.RequiredAttributes })
    });

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

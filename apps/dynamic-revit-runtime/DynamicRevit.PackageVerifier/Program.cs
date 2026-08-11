using System.Text.Json;
using System.Text.Json.Serialization;
using RevitOperator.DynamicRevit.RuntimePackaging;
using RevitOperator.DynamicRevitSdk;

if (args.Length == 1 && args[0] == "--sdk-manifest-hash")
{
    Console.WriteLine(DynamicRevitSdkProductionVersion.ManifestHash);
    return 0;
}
if (args.Length == 1 && args[0] == "--sdk-manifest-components")
{
    Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
    {
        production = DynamicRevitSdkProductionVersion.ManifestHash,
        productionSurface = DynamicRevitSdkProductionVersion.ContractSurfaceHash,
        primitives = DynamicPrimitiveManifestV1.ManifestHash,
        observations = DynamicObservationContractV1.ManifestHash,
        buildingSystems = DynamicBuildingSystemsObservationContractV1.ManifestHash,
        coreOperations = DynamicCoreOperationManifestV1.ManifestHash,
        resultReferences = DynamicResultReferenceManifestV1.ManifestHash,
        annotations = DynamicAnnotationOperationManifestV1.ManifestHash,
        annotationSurface = DynamicAnnotationOperationManifestV1.ContractSurfaceHash,
        mepMutations = DynamicMepMutationManifestV1.ManifestHash,
        mepMutationSurface = DynamicMepMutationManifestV1.ContractSurfaceHash
    }));
    return 0;
}

if (args.Length == 2 && args[0] == "--directory-hash")
{
    Console.WriteLine(RuntimePackageVerifier.ComputeDirectorySha256(args[1]));
    return 0;
}

if (args.Length != 4 || args[0] != "--verify")
{
    Console.Error.WriteLine("Usage: DynamicRevit.PackageVerifier --verify <package-root> <package-manifest.json> <trusted-host-capabilities.json>");
    Console.Error.WriteLine("       DynamicRevit.PackageVerifier --sdk-manifest-hash");
    Console.Error.WriteLine("       DynamicRevit.PackageVerifier --directory-hash <directory>");
    return 2;
}

try
{
    var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    var manifest = JsonSerializer.Deserialize<DynamicRuntimePackageManifest>(File.ReadAllText(args[2]), options)
        ?? throw new InvalidDataException("Package manifest is empty.");
    var result = RuntimePackageVerifier.Verify(args[1], manifest, args[3], DynamicRevitSdkProductionVersion.ManifestHash);
    foreach (var artifact in result.VerifiedArtifacts) Console.WriteLine("verified: " + artifact);
    foreach (var error in result.Errors) Console.Error.WriteLine("error: " + error);
    return result.Ok ? 0 : 1;
}
catch (Exception ex)
{
    Console.Error.WriteLine("error: " + ex.Message);
    return 1;
}

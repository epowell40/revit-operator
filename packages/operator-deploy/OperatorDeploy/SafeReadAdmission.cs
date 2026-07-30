using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RevitOperator.Deployment;

internal static class SafeReadAdmissionContracts
{
    internal const string ProfileId = "safe-read";
    internal const string ManifestFileName = "RevitOperator.SafeReadHost.addin";
    internal const string AddinType = "Application";
    internal const string AddinName = "Revit Operator Safe Read Host";
    internal const string FullClassName = "RevitOperator.SafeReadHost.App";
    internal const string AddInId = "AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E";
    internal const string VendorId = "BIMT";
    internal const string VendorDescription = "BIMTools Revit Operator Safe Read Host";
    internal const string MetadataSchema = "revit-operator.operator-deploy-safe-read.v1";
    internal const string ReceiptSchema = "revit-operator.safe-read-admission-receipt.v2";
    internal const string LayoutSchema = "revit-operator.operator-deploy-safe-read-layout.v1";
    internal const string InstalledBindingSchema = "revit-operator.installed-safe-read-admission.v1";
    internal const string PersistedReceiptRelativePath = ".operator-deploy/safe-read-admission.receipt.v2.json";
    internal const string HostRelativePath = "payload/RevitOperator.SafeReadHost.dll";
    internal const string ExecutorRelativePath = "payload/RevitOperator.SafeReadCertifiedExecution.dll";
    internal const string RuntimeAttestationRelativePath = "payload/safe_read_runtime_attestation.v1.json";
    internal const string RuntimeAttestationPinRelativePath = "payload/safe_read_runtime_attestation.v1.sha256";
    internal const string ManifestTemplateRelativePath = "manifest/RevitOperator.SafeReadHost.addin.template";
    internal const string ProofReceiptRelativePath = "proof/proof.receipt.json";
    internal const string EquivalenceReceiptRelativePath = "proof/artifact.equivalence.json";

    internal static bool CollidesWithReservedProfile(RevitAddinProfile profile)
    {
        var assemblyPath = profile.AssemblyPath.Replace('\\', '/');
        var collidesWithAddInId = Guid.TryParse(profile.AddInId, out var parsedAddInId) &&
                                  parsedAddInId == Guid.Parse(AddInId);
        return profile.ManifestFileName.Equals(ManifestFileName, StringComparison.OrdinalIgnoreCase) ||
               profile.FullClassName.Equals(FullClassName, StringComparison.OrdinalIgnoreCase) ||
               collidesWithAddInId ||
               assemblyPath.Equals(HostRelativePath, StringComparison.OrdinalIgnoreCase) ||
               Path.GetFileName(assemblyPath).Equals(Path.GetFileName(HostRelativePath), StringComparison.OrdinalIgnoreCase);
    }

    internal static bool IsCanonicalProtectedProfile(RevitAddinProfile profile)
        => profile.Id.Equals(ProfileId, StringComparison.Ordinal) &&
           profile.ManifestFileName.Equals(ManifestFileName, StringComparison.Ordinal) &&
           profile.AssemblyPath.Equals(HostRelativePath, StringComparison.Ordinal) &&
           profile.Type.Equals(AddinType, StringComparison.Ordinal) &&
           profile.Name.Equals(AddinName, StringComparison.Ordinal) &&
           profile.FullClassName.Equals(FullClassName, StringComparison.Ordinal) &&
           profile.AddInId.Equals(AddInId, StringComparison.Ordinal) &&
           profile.VendorId.Equals(VendorId, StringComparison.Ordinal) &&
           profile.VendorDescription.Equals(VendorDescription, StringComparison.Ordinal);
}

internal sealed record PreparedSafeReadAdmission(InstalledSafeReadAdmission Binding, byte[] ReceiptBytes);

internal static class SafeReadAdmissionVerifier
{
    internal static PreparedSafeReadAdmission? PrepareExternal(
        DeploymentContext context,
        DeploymentOptions options,
        string manifestPath,
        ReleaseManifest manifest,
        string finalReleaseRoot)
    {
        if (manifest.SafeReadAdmission == null)
        {
            if (options.HasAnySafeReadAdmissionInput)
                throw new DeploymentException(ExitCodes.InvalidArguments, "SafeRead admission inputs are not valid for a manifest without safeReadAdmission.");
            return null;
        }
        if (options.RevitVersion != null)
            throw new DeploymentException(
                ExitCodes.InvalidArguments,
                "--revit-version cannot partially activate an admission-bound SafeRead release; install the exact three-year set.");
        if (string.IsNullOrWhiteSpace(options.SafeReadAdmissionReceiptPath) ||
            string.IsNullOrWhiteSpace(options.SafeReadAdmissionReceiptSha256) ||
            string.IsNullOrWhiteSpace(options.SafeReadPackagePinSha256))
        {
            throw new DeploymentException(
                ExitCodes.InvalidArguments,
                "Schema-v3 SafeRead requires --safe-read-admission-receipt, --safe-read-admission-receipt-sha256, and --safe-read-package-pin-sha256 from an external trusted deployment channel.");
        }

        var receiptPin = RequireSha256(options.SafeReadAdmissionReceiptSha256, "--safe-read-admission-receipt-sha256");
        var packagePin = RequireSha256(options.SafeReadPackagePinSha256, "--safe-read-package-pin-sha256");
        var receiptPath = RequireExternalReceiptPath(context, options.SafeReadAdmissionReceiptPath, manifestPath, finalReleaseRoot);
        var receiptBytes = ReadStableExternalReceipt(context, receiptPath);
        if (!Sha256(receiptBytes).Equals(receiptPin, StringComparison.Ordinal))
            throw new DeploymentException(ExitCodes.HashMismatch, "SafeRead admission receipt does not match the externally supplied receipt hash.");
        using var receipt = ParseStrictJson(receiptBytes, "SafeRead admission receipt");

        var bundleRoot = Path.GetDirectoryName(Path.GetFullPath(manifestPath))!;
        var packageRoot = FileIntegrity.ResolveUnder(bundleRoot, manifest.SafeReadAdmission.PackageRoot);
        EnsureNoReparsePoints(context, bundleRoot, packageRoot, "SafeRead package root");
        AssertSourcePackageLayout(packageRoot, manifest);
        foreach (var component in SafeReadComponents(manifest))
            FileIntegrity.VerifyComponent(bundleRoot, component);

        var packagePinsPath = Path.Combine(packageRoot, "package-pins.json");
        if (!File.Exists(packagePinsPath) || !Sha256(File.ReadAllBytes(packagePinsPath)).Equals(packagePin, StringComparison.Ordinal))
            throw new DeploymentException(ExitCodes.HashMismatch, "SafeRead package pins do not match the externally supplied package trust pin.");

        var operatorManifestPin = Sha256(File.ReadAllBytes(manifestPath));
        var binding = VerifyReceiptPlan(
            receipt.RootElement,
            manifest,
            finalReleaseRoot,
            receiptPin,
            packagePin,
            operatorManifestPin);
        VerifyCandidateFacts(packageRoot, manifest, binding, receipt.RootElement, sourcePackage: true);
        return new PreparedSafeReadAdmission(binding, receiptBytes);
    }

    internal static void VerifyCandidate(
        DeploymentContext context,
        string candidateRoot,
        string finalReleaseRoot,
        ReleaseManifest manifest,
        InstalledSafeReadAdmission? binding,
        byte[]? expectedReceiptBytes = null)
    {
        if (manifest.SafeReadAdmission == null)
        {
            if (binding != null)
                throw new DeploymentException(ExitCodes.ValidationFailed, "Installed admission state is detached from a non-SafeRead release.");
            return;
        }
        if (binding == null)
            throw new DeploymentException(ExitCodes.ValidationFailed, "The production SafeRead release has no durable admission binding.");
        ValidateBinding(binding, manifest.ReleaseVersion);
        AssertManagedCandidateLayout(context, candidateRoot, finalReleaseRoot, manifest);

        var receiptPath = FileIntegrity.ResolveUnder(candidateRoot, binding.ReceiptRelativePath, ExitCodes.ValidationFailed);
        if (!File.Exists(receiptPath))
            throw new DeploymentException(ExitCodes.ValidationFailed, "The pinned SafeRead admission receipt is missing from the candidate release.");
        var receiptBytes = ReadExactUtf8(receiptPath, "installed SafeRead admission receipt");
        if (expectedReceiptBytes != null && !receiptBytes.AsSpan().SequenceEqual(expectedReceiptBytes))
            throw new DeploymentException(ExitCodes.ValidationFailed, "The staged SafeRead admission receipt differs from the externally pinned receipt bytes.");
        if (!Sha256(receiptBytes).Equals(binding.ReceiptSha256, StringComparison.Ordinal))
            throw new DeploymentException(ExitCodes.ValidationFailed, "The installed SafeRead admission receipt hash does not match durable state.");

        var manifestPath = Path.Combine(candidateRoot, "manifest.json");
        if (!File.Exists(manifestPath) || !Sha256(File.ReadAllBytes(manifestPath)).Equals(binding.OperatorManifestSha256, StringComparison.Ordinal))
            throw new DeploymentException(ExitCodes.ValidationFailed, "The candidate OperatorDeploy manifest differs from the externally admitted manifest bytes.");
        using var receipt = ParseStrictJson(receiptBytes, "installed SafeRead admission receipt");
        var expected = VerifyReceiptPlan(
            receipt.RootElement,
            manifest,
            finalReleaseRoot,
            binding.ReceiptSha256,
            binding.PackagePinSha256,
            binding.OperatorManifestSha256);
        AssertBindingsEqual(binding, expected);
        AssertCandidateComponentSets(candidateRoot, manifest);
        VerifyCandidateFacts(candidateRoot, manifest, binding, receipt.RootElement, sourcePackage: false);
        AssertManagedCandidateLayout(context, candidateRoot, finalReleaseRoot, manifest);
    }

    internal static void ValidateBinding(InstalledSafeReadAdmission binding, string expectedRelease)
    {
        if (!binding.Schema.Equals(SafeReadAdmissionContracts.InstalledBindingSchema, StringComparison.Ordinal) ||
            !binding.ReleaseVersion.Equals(expectedRelease, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(binding.ReleaseId) ||
            !binding.ReceiptRelativePath.Equals(SafeReadAdmissionContracts.PersistedReceiptRelativePath, StringComparison.Ordinal) ||
            !IsSha256(binding.ReceiptSha256) ||
            !IsSha256(binding.PackagePinSha256) ||
            !IsSha256(binding.OperatorManifestSha256) ||
            !IsSha256(binding.LayoutSha256))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Installed SafeRead admission binding is malformed or detached.");
        var years = binding.Targets.Select(target => target.RevitYear).ToHashSet(StringComparer.Ordinal);
        if (binding.Targets.Count != 3 || !years.SetEquals(new[] { "2023", "2024", "2025" }))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Installed SafeRead admission binding does not cover exactly Revit 2023, 2024, and 2025.");
        var components = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var target in binding.Targets)
        {
            ReleaseManifest.EnsureSafeBaseName(target.ComponentId, "installed SafeRead component id");
            if (!components.Add(target.ComponentId) || !Path.IsPathRooted(target.AssemblyPath) || !IsSha256(target.ManifestSha256))
                throw new DeploymentException(ExitCodes.ValidationFailed, "Installed SafeRead target binding is malformed or duplicated.");
        }
    }

    internal static InstalledSafeReadAdmission Clone(InstalledSafeReadAdmission source)
        => new()
        {
            Schema = source.Schema,
            ReleaseVersion = source.ReleaseVersion,
            ReleaseId = source.ReleaseId,
            ReceiptRelativePath = source.ReceiptRelativePath,
            ReceiptSha256 = source.ReceiptSha256,
            PackagePinSha256 = source.PackagePinSha256,
            OperatorManifestSha256 = source.OperatorManifestSha256,
            LayoutSha256 = source.LayoutSha256,
            Targets = source.Targets.Select(target => new InstalledSafeReadTarget
            {
                RevitYear = target.RevitYear,
                ComponentId = target.ComponentId,
                AssemblyPath = target.AssemblyPath,
                ManifestSha256 = target.ManifestSha256
            }).ToList()
        };

    private static InstalledSafeReadAdmission VerifyReceiptPlan(
        JsonElement receipt,
        ReleaseManifest manifest,
        string finalReleaseRoot,
        string receiptPin,
        string packagePin,
        string operatorManifestPin)
    {
        AssertExactProperties(receipt,
            "schema", "status", "releaseId", "releaseManifest", "packagePins", "source", "proof",
            "manifestAssemblyRoot", "operatorDeploy", "targets");
        if (String(receipt, "schema") != SafeReadAdmissionContracts.ReceiptSchema ||
            String(receipt, "status") != "verified")
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admission receipt schema/status is not the exact OperatorDeploy contract.");
        var releaseId = String(receipt, "releaseId");
        ReleaseManifest.EnsureSafeBaseName(releaseId, "SafeRead admission releaseId");
        if (!PathsEqual(String(receipt, "manifestAssemblyRoot"), finalReleaseRoot))
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admission receipt is stale or bound to the wrong final release root.");

        var releaseManifest = Object(receipt, "releaseManifest");
        AssertExactProperties(releaseManifest, "path", "sha256");
        if (String(releaseManifest, "path") != "release-manifest.json" || !IsSha256(String(releaseManifest, "sha256")))
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admission release-manifest binding is invalid.");
        var packagePins = Object(receipt, "packagePins");
        AssertExactProperties(packagePins, "path", "externalSha256");
        if (String(packagePins, "path") != "package-pins.json" ||
            String(packagePins, "externalSha256") != packagePin)
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admission receipt does not carry the externally supplied package pin.");

        var layout = Object(receipt, "operatorDeploy");
        AssertExactProperties(layout,
            "schema", "releaseVersion", "releaseManifestSha256", "packageRoot", "evidenceComponentId",
            "layoutSha256", "targets");
        var admission = manifest.SafeReadAdmission!;
        if (String(layout, "schema") != SafeReadAdmissionContracts.LayoutSchema ||
            String(layout, "releaseVersion") != manifest.ReleaseVersion ||
            String(layout, "releaseManifestSha256") != operatorManifestPin ||
            String(layout, "packageRoot") != admission.PackageRoot ||
            String(layout, "evidenceComponentId") != admission.EvidenceComponentId)
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admission receipt is detached from the exact OperatorDeploy manifest metadata.");

        var receiptTargets = Array(layout, "targets").EnumerateArray().ToList();
        var evidenceTargets = Array(receipt, "targets").EnumerateArray().ToList();
        if (receiptTargets.Count != 3 || evidenceTargets.Count != 3)
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admission receipt does not contain exactly three target bindings.");
        var profile = manifest.RevitAddinProfiles.Single(SafeReadAdmissionContracts.IsCanonicalProtectedProfile);
        var installedTargets = new List<InstalledSafeReadTarget>();
        foreach (var targetMetadata in admission.Targets.OrderBy(target => target.RevitYear, StringComparer.Ordinal))
        {
            var component = manifest.Components.Single(candidate => candidate.Id == targetMetadata.ComponentId);
            var assemblyRelativePath = $"{component.Id}/{profile.AssemblyPath.Replace('\\', '/')}";
            var assemblyPath = FileIntegrity.ResolveUnder(finalReleaseRoot, assemblyRelativePath, ExitCodes.ValidationFailed);
            var layoutTarget = SingleByYear(receiptTargets, targetMetadata.RevitYear, "operatorDeploy target");
            AssertExactProperties(layoutTarget, "revitYear", "componentId", "assemblyRelativePath", "assemblyPath");
            if (String(layoutTarget, "componentId") != component.Id ||
                String(layoutTarget, "assemblyRelativePath") != assemblyRelativePath ||
                !PathsEqual(String(layoutTarget, "assemblyPath"), assemblyPath))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead admission layout for Revit {targetMetadata.RevitYear} is stale or detached.");

            var targetEvidence = SingleByYear(evidenceTargets, targetMetadata.RevitYear, "receipt target");
            var rendered = Object(targetEvidence, "renderedManifest");
            AssertExactProperties(rendered, "fileName", "sha256", "sizeBytes", "encoding", "fields");
            var manifestBytes = DeploymentEngine.BuildAddinXmlBytes(profile, assemblyPath);
            var manifestPin = Sha256(manifestBytes);
            var renderedAddInId = Guid.Parse(profile.AddInId).ToString("D").ToUpperInvariant();
            if (String(rendered, "fileName") != profile.ManifestFileName ||
                String(rendered, "sha256") != manifestPin ||
                Int64(rendered, "sizeBytes") != manifestBytes.LongLength ||
                String(rendered, "encoding") != "utf-8-no-bom")
                throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead rendered manifest admission drifted for Revit {targetMetadata.RevitYear}.");
            var fields = Object(rendered, "fields");
            AssertExactProperties(fields, "name", "assembly", "fullClassName", "addInId", "vendorId", "vendorDescription");
            if (String(fields, "name") != profile.Name ||
                !PathsEqual(String(fields, "assembly"), assemblyPath) ||
                String(fields, "fullClassName") != profile.FullClassName ||
                String(fields, "addInId") != renderedAddInId ||
                String(fields, "vendorId") != profile.VendorId ||
                String(fields, "vendorDescription") != profile.VendorDescription)
                throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead rendered manifest fields drifted for Revit {targetMetadata.RevitYear}.");
            installedTargets.Add(new InstalledSafeReadTarget
            {
                RevitYear = targetMetadata.RevitYear,
                ComponentId = component.Id,
                AssemblyPath = assemblyPath,
                ManifestSha256 = manifestPin
            });
        }

        var layoutPin = ComputeLayoutSha256(
            manifest.ReleaseVersion,
            operatorManifestPin,
            admission.PackageRoot,
            admission.EvidenceComponentId,
            installedTargets);
        if (String(layout, "layoutSha256") != layoutPin)
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admission layout hash does not match the exact final component mapping.");
        return new InstalledSafeReadAdmission
        {
            ReleaseVersion = manifest.ReleaseVersion,
            ReleaseId = releaseId,
            ReceiptSha256 = receiptPin,
            PackagePinSha256 = packagePin,
            OperatorManifestSha256 = operatorManifestPin,
            LayoutSha256 = layoutPin,
            Targets = installedTargets
        };
    }

    private static void VerifyCandidateFacts(
        string root,
        ReleaseManifest manifest,
        InstalledSafeReadAdmission binding,
        JsonElement receipt,
        bool sourcePackage)
    {
        var admission = manifest.SafeReadAdmission!;
        string EvidencePath(string relative)
            => sourcePackage
                ? FileIntegrity.ResolveUnder(root, relative, ExitCodes.ValidationFailed)
                : FileIntegrity.ResolveUnder(Path.Combine(root, admission.EvidenceComponentId), relative, ExitCodes.ValidationFailed);
        string TargetPath(string year, string componentId, string relative)
            => sourcePackage
                ? FileIntegrity.ResolveUnder(Path.Combine(root, "targets", year), relative, ExitCodes.ValidationFailed)
                : FileIntegrity.ResolveUnder(Path.Combine(root, componentId), relative, ExitCodes.ValidationFailed);

        var releaseManifest = Object(receipt, "releaseManifest");
        var packagePins = Object(receipt, "packagePins");
        var source = Object(receipt, "source");
        AssertExactProperties(source, "path", "sha256", "commit", "proofTree", "hostTree", "archiveSha256");
        var releaseManifestPath = EvidencePath(String(releaseManifest, "path"));
        var packagePinsPath = EvidencePath(String(packagePins, "path"));
        var sourcePath = EvidencePath(String(source, "path"));
        AssertFileHash(releaseManifestPath, String(releaseManifest, "sha256"), "SafeRead release manifest");
        AssertFileHash(packagePinsPath, binding.PackagePinSha256, "SafeRead package pins");
        AssertFileHash(sourcePath, String(source, "sha256"), "SafeRead source receipt");

        using (var packageRelease = ParseStrictJson(ReadExactUtf8(releaseManifestPath, "SafeRead package release manifest"), "SafeRead package release manifest"))
        {
            if (String(packageRelease.RootElement, "releaseId") != binding.ReleaseId)
                throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead package release ID does not match the admitted receipt.");
            var releaseSource = Object(packageRelease.RootElement, "source");
            foreach (var name in new[] { "path", "sha256", "commit", "proofTree", "hostTree", "archiveSha256" })
            {
                if (String(releaseSource, name) != String(source, name))
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead source fact '{name}' differs from the admitted receipt.");
            }
        }

        var proof = Object(receipt, "proof");
        AssertExactProperties(proof,
            "targetPaths", "sha256", "proofKind", "manifestSha256", "verifierProfileId",
            "verifierProfileSha256", "verifierBundleSha256", "sourceLockSha256", "apiLockSha256", "sdkLockSha256");
        if (String(proof, "proofKind") != "revit-safe-read-certified-kernel/v1")
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admitted proof kind is invalid.");
        var proofTargetPaths = Array(proof, "targetPaths").EnumerateArray().Select(value => value.GetString()).ToArray();
        var expectedProofPaths = new[]
        {
            "targets/2023/proof/proof.receipt.json",
            "targets/2024/proof/proof.receipt.json",
            "targets/2025/proof/proof.receipt.json"
        };
        if (!proofTargetPaths.SequenceEqual(expectedProofPaths, StringComparer.Ordinal))
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admitted proof paths do not cover the exact three-year package.");

        var evidenceTargets = Array(receipt, "targets").EnumerateArray().ToList();
        foreach (var targetBinding in binding.Targets.OrderBy(target => target.RevitYear, StringComparer.Ordinal))
        {
            var target = SingleByYear(evidenceTargets, targetBinding.RevitYear, "receipt target");
            AssertExactProperties(target, "revitYear", "framework", "host", "executor", "runtimeAttestation", "renderedManifest");
            var host = Object(target, "host");
            AssertExactProperties(host, "path", "sha256", "sizeBytes", "mvid", "signerThumbprint");
            VerifyAssemblyFact(
                TargetPath(targetBinding.RevitYear, targetBinding.ComponentId, String(host, "path")),
                String(host, "sha256"),
                Int64(host, "sizeBytes"),
                String(host, "mvid"),
                $"SafeRead Revit {targetBinding.RevitYear} host");
            RequireThumbprint(String(host, "signerThumbprint"), $"SafeRead Revit {targetBinding.RevitYear} host signer");

            var executor = Object(target, "executor");
            AssertExactProperties(executor, "path", "sha256", "sizeBytes", "mvid", "signerThumbprint", "equivalence");
            VerifyAssemblyFact(
                TargetPath(targetBinding.RevitYear, targetBinding.ComponentId, String(executor, "path")),
                String(executor, "sha256"),
                Int64(executor, "sizeBytes"),
                String(executor, "mvid"),
                $"SafeRead Revit {targetBinding.RevitYear} executor");
            RequireThumbprint(String(executor, "signerThumbprint"), $"SafeRead Revit {targetBinding.RevitYear} executor signer");
            var equivalence = Object(executor, "equivalence");
            AssertExactProperties(equivalence, "path", "sha256", "unsignedSha256", "candidateSha256", "canonicalPeSha256");
            AssertFileHash(
                TargetPath(targetBinding.RevitYear, targetBinding.ComponentId, String(equivalence, "path")),
                String(equivalence, "sha256"),
                $"SafeRead Revit {targetBinding.RevitYear} equivalence receipt");
            if (String(equivalence, "candidateSha256") != String(executor, "sha256"))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead Revit {targetBinding.RevitYear} equivalence candidate is detached from the signed executor.");

            var targetProofPath = TargetPath(targetBinding.RevitYear, targetBinding.ComponentId, SafeReadAdmissionContracts.ProofReceiptRelativePath);
            AssertFileHash(targetProofPath, String(proof, "sha256"), $"SafeRead Revit {targetBinding.RevitYear} proof receipt");
            using (var proofReceipt = ParseStrictJson(ReadExactUtf8(targetProofPath, "SafeRead proof receipt"), "SafeRead proof receipt"))
            {
                foreach (var fact in new[] { "proofKind", "manifestSha256", "verifierProfileId", "verifierProfileSha256", "verifierBundleSha256", "sourceLockSha256", "apiLockSha256", "sdkLockSha256" })
                {
                    if (String(proofReceipt.RootElement, fact) != String(proof, fact))
                        throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead Revit {targetBinding.RevitYear} proof fact '{fact}' differs from admission.");
                }
            }

            var runtime = Object(target, "runtimeAttestation");
            AssertExactProperties(runtime,
                "path", "sha256", "sizeBytes", "state", "issuedAtUtc", "expiresAtUtc", "routeId",
                "routeContractSha256", "policySha256", "proofSha256", "executorId", "runtimeTuple");
            var runtimePath = TargetPath(targetBinding.RevitYear, targetBinding.ComponentId, String(runtime, "path"));
            AssertFileFact(runtimePath, String(runtime, "sha256"), Int64(runtime, "sizeBytes"), $"SafeRead Revit {targetBinding.RevitYear} runtime attestation");
            using var runtimeJson = ParseStrictJson(ReadExactUtf8(runtimePath, "SafeRead runtime attestation"), "SafeRead runtime attestation");
            CompareRuntimeFacts(runtimeJson.RootElement, runtime, targetBinding.RevitYear);
            var runtimePinPath = TargetPath(targetBinding.RevitYear, targetBinding.ComponentId, SafeReadAdmissionContracts.RuntimeAttestationPinRelativePath);
            var runtimePinText = File.ReadAllText(runtimePinPath, new UTF8Encoding(false, true)).Trim();
            if (runtimePinText != String(runtime, "sha256"))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead Revit {targetBinding.RevitYear} runtime-attestation external pin is stale.");
        }
    }

    private static void CompareRuntimeFacts(JsonElement actual, JsonElement admitted, string year)
    {
        var mappings = new[]
        {
            ("state", "state"),
            ("issued_at_utc", "issuedAtUtc"),
            ("expires_at_utc", "expiresAtUtc"),
            ("route_id", "routeId"),
            ("route_contract_sha256", "routeContractSha256"),
            ("policy_sha256", "policySha256"),
            ("proof_sha256", "proofSha256"),
            ("executor_id", "executorId")
        };
        foreach (var (actualName, admittedName) in mappings)
        {
            if (String(actual, actualName) != String(admitted, admittedName))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead Revit {year} runtime fact '{actualName}' differs from admission.");
        }
        var actualTuple = Object(actual, "runtime_tuple");
        var admittedTuple = Object(admitted, "runtimeTuple");
        var tupleMappings = new[]
        {
            ("host_content_sha256", "hostContentSha256"),
            ("host_mvid", "hostMvid"),
            ("revit_api_content_sha256", "revitApiContentSha256"),
            ("revit_api_mvid", "revitApiMvid"),
            ("revit_version", "revitVersion")
        };
        foreach (var (actualName, admittedName) in tupleMappings)
        {
            if (String(actualTuple, actualName) != String(admittedTuple, admittedName))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead Revit {year} runtime tuple '{actualName}' differs from admission.");
        }
        if (String(admittedTuple, "revitVersion") != year)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead runtime tuple is bound to the wrong Revit year {year}.");
    }

    private static void AssertSourcePackageLayout(string packageRoot, ReleaseManifest manifest)
    {
        var admission = manifest.SafeReadAdmission!;
        var evidence = manifest.Components.Single(component => component.Id == admission.EvidenceComponentId);
        AssertRelativeFileSet(
            Directory.GetFiles(packageRoot, "*", SearchOption.AllDirectories)
                .Select(path => Relative(packageRoot, path))
                .Where(path => !path.StartsWith("targets/", StringComparison.Ordinal)),
            evidence.Files.Select(file => file.Path),
            "SafeRead evidence package");
        foreach (var target in admission.Targets)
        {
            var targetRoot = Path.Combine(packageRoot, "targets", target.RevitYear);
            if (!Directory.Exists(targetRoot))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"SafeRead package target {target.RevitYear} is missing.");
            var component = manifest.Components.Single(candidate => candidate.Id == target.ComponentId);
            AssertRelativeFileSet(
                Directory.GetFiles(targetRoot, "*", SearchOption.AllDirectories).Select(path => Relative(targetRoot, path)),
                component.Files.Select(file => file.Path),
                $"SafeRead Revit {target.RevitYear} package target");
        }
        var targetDirectories = Directory.GetDirectories(Path.Combine(packageRoot, "targets"), "*", SearchOption.TopDirectoryOnly)
            .Select(Path.GetFileName).OrderBy(value => value, StringComparer.Ordinal).ToArray();
        if (!targetDirectories.SequenceEqual(new[] { "2023", "2024", "2025" }, StringComparer.Ordinal))
            throw new DeploymentException(ExitCodes.ManifestInvalid, "SafeRead package target tree is not the exact 2023/2024/2025 set.");
    }

    private static void AssertCandidateComponentSets(string candidateRoot, ReleaseManifest manifest)
    {
        foreach (var component in SafeReadComponents(manifest))
        {
            var componentRoot = Path.Combine(candidateRoot, component.Id);
            if (!Directory.Exists(componentRoot))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead candidate component is missing: {component.Id}");
            AssertRelativeFileSet(
                Directory.GetFiles(componentRoot, "*", SearchOption.AllDirectories).Select(path => Relative(componentRoot, path)),
                component.Files.Select(file => file.Path),
                $"SafeRead candidate component {component.Id}");
        }
    }

    private static void AssertManagedCandidateLayout(
        DeploymentContext context,
        string candidateRoot,
        string finalReleaseRoot,
        ReleaseManifest manifest)
    {
        var expectedFinalRoot = Path.Combine(context.ReleasesRoot, manifest.ReleaseVersion);
        if (!PathsEqual(finalReleaseRoot, expectedFinalRoot))
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead final release root is detached from the managed release identity.");

        var candidateFull = Path.GetFullPath(candidateRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var releasesFull = Path.GetFullPath(context.ReleasesRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!Path.GetDirectoryName(candidateFull)!.Equals(releasesFull, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead candidate release must be one direct child of the managed releases root.");
        if (!Directory.Exists(candidateFull))
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead candidate release root is missing.");

        EnsureNoReparsePoints(context, context.ProductRoot, candidateFull, "SafeRead candidate release root");
        EnsureNoReparsePoints(context, context.ProductRoot, expectedFinalRoot, "SafeRead final release root");

        var expectedFiles = new HashSet<string>(StringComparer.Ordinal)
        {
            "manifest.json",
            SafeReadAdmissionContracts.PersistedReceiptRelativePath
        };
        var expectedDirectories = new HashSet<string>(StringComparer.Ordinal);
        foreach (var component in manifest.Components)
        {
            expectedDirectories.Add(component.Id);
            foreach (var file in component.Files)
                expectedFiles.Add($"{component.Id}/{file.Path.Replace('\\', '/')}");
        }
        foreach (var file in expectedFiles)
        {
            var parts = file.Split('/');
            for (var length = 1; length < parts.Length; length++)
                expectedDirectories.Add(string.Join("/", parts.Take(length)));
        }

        var (actualFiles, actualDirectories) = EnumerateManagedCandidateTree(context, candidateFull);
        if (!actualFiles.SetEquals(expectedFiles) || !actualDirectories.SetEquals(expectedDirectories))
        {
            var extraFiles = actualFiles.Except(expectedFiles, StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal);
            var missingFiles = expectedFiles.Except(actualFiles, StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal);
            var extraDirectories = actualDirectories.Except(expectedDirectories, StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal);
            var missingDirectories = expectedDirectories.Except(actualDirectories, StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal);
            throw new DeploymentException(
                ExitCodes.ValidationFailed,
                $"SafeRead candidate whole-release layout is not exact. Extra files [{string.Join(", ", extraFiles)}]; missing files [{string.Join(", ", missingFiles)}]; extra directories [{string.Join(", ", extraDirectories)}]; missing directories [{string.Join(", ", missingDirectories)}].");
        }
    }

    private static (HashSet<string> Files, HashSet<string> Directories) EnumerateManagedCandidateTree(
        DeploymentContext context,
        string candidateRoot)
    {
        var files = new HashSet<string>(StringComparer.Ordinal);
        var directories = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Stack<string>();
        pending.Push(candidateRoot);
        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            if (context.IsReparsePoint(directory))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead candidate release contains a reparse point: {directory}");
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory, "*", SearchOption.TopDirectoryOnly))
            {
                if (context.IsReparsePoint(entry))
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead candidate release contains a reparse point: {entry}");
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead candidate release contains a reparse point: {entry}");
                var relative = Relative(candidateRoot, entry);
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    if (!directories.Add(relative))
                        throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead candidate repeats directory '{relative}'.");
                    pending.Push(entry);
                }
                else if (!files.Add(relative))
                {
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead candidate repeats file '{relative}'.");
                }
                if (files.Count + directories.Count > 100_000)
                    throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead candidate release contains too many entries to verify safely.");
            }
        }
        return (files, directories);
    }

    private static IEnumerable<ReleaseComponent> SafeReadComponents(ReleaseManifest manifest)
    {
        var admission = manifest.SafeReadAdmission!;
        var ids = admission.Targets.Select(target => target.ComponentId)
            .Append(admission.EvidenceComponentId)
            .ToHashSet(StringComparer.Ordinal);
        return manifest.Components.Where(component => ids.Contains(component.Id));
    }

    private static void AssertRelativeFileSet(IEnumerable<string> actualPaths, IEnumerable<string> expectedPaths, string label)
    {
        var actual = actualPaths.OrderBy(path => path, StringComparer.Ordinal).ToArray();
        var expected = expectedPaths.Select(path => path.Replace('\\', '/')).OrderBy(path => path, StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(expected, StringComparer.Ordinal))
            throw new DeploymentException(
                ExitCodes.ValidationFailed,
                $"{label} file set is not exact. Expected [{string.Join(", ", expected)}]; actual [{string.Join(", ", actual)}].");
    }

    private static void VerifyAssemblyFact(string path, string sha256, long size, string mvid, string label)
    {
        AssertFileFact(path, sha256, size, label);
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var pe = new PEReader(stream);
            if (!pe.HasMetadata) throw new InvalidDataException("PE has no CLR metadata.");
            var reader = pe.GetMetadataReader();
            var actualMvid = reader.GetGuid(reader.GetModuleDefinition().Mvid);
            if (!Guid.TryParse(mvid, out var expectedMvid) || actualMvid != expectedMvid)
                throw new InvalidDataException($"MVID {actualMvid:D} does not match {mvid}.");
        }
        catch (Exception ex)
        {
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} assembly identity is invalid: {ex.Message}", ex);
        }
    }

    private static void AssertFileFact(string path, string sha256, long size, string label)
    {
        if (!File.Exists(path) || new FileInfo(path).Length != size)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} is missing or has the wrong length.");
        AssertFileHash(path, sha256, label);
    }

    private static void AssertFileHash(string path, string sha256, string label)
    {
        if (!File.Exists(path) || !Sha256(File.ReadAllBytes(path)).Equals(sha256, StringComparison.Ordinal))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} does not match its admitted SHA-256.");
    }

    internal static string ComputeLayoutSha256(
        string releaseVersion,
        string operatorManifestSha256,
        string packageRoot,
        string evidenceComponentId,
        IEnumerable<InstalledSafeReadTarget> targets)
    {
        var lines = new List<string>
        {
            SafeReadAdmissionContracts.LayoutSchema,
            releaseVersion,
            operatorManifestSha256,
            packageRoot.Replace('\\', '/'),
            evidenceComponentId
        };
        lines.AddRange(targets.OrderBy(target => target.RevitYear, StringComparer.Ordinal)
            .Select(target =>
                $"{target.RevitYear}|{target.ComponentId}|{Path.GetRelativePath(Path.GetDirectoryName(Path.GetDirectoryName(target.AssemblyPath)!)!, target.AssemblyPath).Replace('\\', '/')}|{target.ManifestSha256}"));
        return Sha256(Encoding.UTF8.GetBytes(string.Join("\n", lines)));
    }

    private static void AssertBindingsEqual(InstalledSafeReadAdmission actual, InstalledSafeReadAdmission expected)
    {
        var actualJson = JsonSerializer.Serialize(actual, ReleaseManifest.JsonOptions);
        var expectedJson = JsonSerializer.Serialize(expected, ReleaseManifest.JsonOptions);
        if (!actualJson.Equals(expectedJson, StringComparison.Ordinal))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Durable SafeRead admission state differs from the pinned receipt and exact final layout.");
    }

    private static JsonElement SingleByYear(IReadOnlyCollection<JsonElement> values, string year, string label)
    {
        var matches = values.Where(value => String(value, "revitYear") == year).ToList();
        if (matches.Count != 1)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} does not contain one exact Revit {year} entry.");
        return matches[0];
    }

    private static string RequireExternalReceiptPath(
        DeploymentContext context,
        string value,
        string manifestPath,
        string finalReleaseRoot)
    {
        if (!Path.IsPathRooted(value))
            throw new DeploymentException(ExitCodes.InvalidArguments, "--safe-read-admission-receipt must be an absolute external path.");
        var full = Path.GetFullPath(value);
        if (!value.Equals(full, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.InvalidArguments, "--safe-read-admission-receipt must use one canonical absolute path without dot segments or aliases.");
        if (!File.Exists(full))
            throw new DeploymentException(ExitCodes.InvalidArguments, $"SafeRead admission receipt not found: {full}");
        var bundleRoot = Path.GetDirectoryName(Path.GetFullPath(manifestPath))!;
        var addinsRoot = Path.Combine(context.AppData, "Autodesk", "Revit", "Addins");
        if (PathWithin(full, bundleRoot) || PathWithin(full, context.ProductRoot) || PathWithin(full, finalReleaseRoot) || PathWithin(full, addinsRoot))
            throw new DeploymentException(ExitCodes.InvalidArguments, "SafeRead admission receipt must be external to the package, complete managed product/install tree, and Revit Addins tree.");
        EnsureNoReparsePoints(context, Path.GetPathRoot(full)!, full, "SafeRead admission receipt");
        return full;
    }

    private static byte[] ReadStableExternalReceipt(DeploymentContext context, string path)
    {
        EnsureNoReparsePoints(context, Path.GetPathRoot(path)!, path, "SafeRead admission receipt");
        byte[] bytes;
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.SequentialScan))
        {
            if (stream.Length > 16 * 1024 * 1024)
                throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admission receipt is too large to verify safely.");
            bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            EnsureNoReparsePoints(context, Path.GetPathRoot(path)!, path, "SafeRead admission receipt");
        }
        return ValidateExactUtf8(bytes, "SafeRead admission receipt");
    }

    private static void EnsureNoReparsePoints(DeploymentContext context, string allowedRoot, string path, string label)
    {
        var root = Path.GetFullPath(allowedRoot);
        var pathRoot = Path.GetPathRoot(root)!;
        if (!root.Equals(pathRoot, StringComparison.OrdinalIgnoreCase))
            root = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var full = Path.GetFullPath(path);
        var rootPrefix = root.EndsWith(Path.DirectorySeparatorChar) || root.EndsWith(Path.AltDirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;
        if (!full.Equals(root, StringComparison.OrdinalIgnoreCase) &&
            !full.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} escapes its allowed root.");
        var current = root;
        if (context.IsReparsePoint(current))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} root is a reparse point.");
        foreach (var segment in Path.GetRelativePath(root, full).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (segment is "" or ".") continue;
            current = Path.Combine(current, segment);
            if ((File.Exists(current) || Directory.Exists(current)) && context.IsReparsePoint(current))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} contains a reparse point: {current}");
        }
    }

    private static JsonDocument ParseStrictJson(byte[] bytes, string label)
    {
        try
        {
            var json = new UTF8Encoding(false, true).GetString(bytes);
            var document = JsonDocument.Parse(json, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 64
            });
            RejectDuplicateProperties(document.RootElement);
            return document;
        }
        catch (DeploymentException) { throw; }
        catch (Exception ex)
        {
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} is not strict canonical UTF-8 JSON: {ex.Message}", ex);
        }
    }

    private static byte[] ReadExactUtf8(string path, string label)
    {
        return ValidateExactUtf8(File.ReadAllBytes(path), label);
    }

    private static byte[] ValidateExactUtf8(byte[] bytes, string label)
    {
        if (bytes.Length >= 2 &&
            ((bytes[0] == 0xff && bytes[1] == 0xfe) || (bytes[0] == 0xfe && bytes[1] == 0xff)) ||
            bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf ||
            bytes.Length >= 4 &&
            ((bytes[0] == 0xff && bytes[1] == 0xfe && bytes[2] == 0 && bytes[3] == 0) ||
             (bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 0xfe && bytes[3] == 0xff)))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} must be strict UTF-8 without BOM.");
        try { _ = new UTF8Encoding(false, true).GetString(bytes); }
        catch (DecoderFallbackException ex)
        {
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} must be strict UTF-8 without BOM.", ex);
        }
        return bytes;
    }

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"Duplicate JSON property '{property.Name}' is forbidden.");
                RejectDuplicateProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var value in element.EnumerateArray()) RejectDuplicateProperties(value);
        }
    }

    private static void AssertExactProperties(JsonElement element, params string[] expected)
    {
        if (element.ValueKind != JsonValueKind.Object)
            throw new DeploymentException(ExitCodes.ValidationFailed, "SafeRead admission JSON object is missing.");
        var actual = element.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray();
        var orderedExpected = expected.OrderBy(name => name, StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(orderedExpected, StringComparer.Ordinal))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead admission JSON properties are not exact. Expected [{string.Join(", ", orderedExpected)}].");
    }

    private static JsonElement Object(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Object)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead admission property '{name}' must be an object.");
        return value;
    }

    private static JsonElement Array(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead admission property '{name}' must be an array.");
        return value;
    }

    private static string String(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead admission property '{name}' must be a string.");
        return value.GetString()!;
    }

    private static long Int64(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var result))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"SafeRead admission property '{name}' must be an exact integer.");
        return result;
    }

    private static void RequireThumbprint(string value, string label)
    {
        if (value.Length != 40 || value.Any(character => !Uri.IsHexDigit(character)) || value != value.ToUpperInvariant())
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} is not an exact uppercase SHA-1 certificate thumbprint.");
    }

    private static string RequireSha256(string? value, string label)
    {
        if (value == null || !IsSha256(value))
            throw new DeploymentException(ExitCodes.InvalidArguments, $"{label} must be lowercase sha256:<64 lowercase hex>.");
        return value;
    }

    private static bool IsSha256(string value)
        => value.Length == 71 &&
           value.StartsWith("sha256:", StringComparison.Ordinal) &&
           value.AsSpan(7).ToString().All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static string Sha256(byte[] bytes)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string Relative(string root, string path)
        => Path.GetRelativePath(root, path).Replace('\\', '/');

    private static bool PathsEqual(string left, string right)
        => Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .Equals(Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);

    private static bool PathWithin(string path, string root)
    {
        var full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return full.Equals(fullRoot, StringComparison.OrdinalIgnoreCase) ||
               full.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }
}

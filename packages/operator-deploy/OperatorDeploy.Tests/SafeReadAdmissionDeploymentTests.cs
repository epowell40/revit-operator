using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevitOperator.Deployment;
using Xunit;

namespace OperatorDeploy.Tests;

public sealed class SafeReadAdmissionDeploymentTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "OperatorDeploySafeReadAdmissionTests", Guid.NewGuid().ToString("N"));
    private Action<string> _checkpoint = _ => { };

    [Fact]
    public void Production_identity_requires_schema_v3_and_all_external_inputs()
    {
        var fixture = CreateAdmittedBundle("1.0.0");
        var manifest = ReleaseManifest.Load(fixture.ManifestPath);
        manifest.SchemaVersion = 2;
        manifest.SafeReadAdmission = null;
        manifest.Components.RemoveAll(component => component.Kind == "safe-read-evidence");
        Assert.Equal(ExitCodes.ManifestInvalid, Assert.Throws<DeploymentException>(() => manifest.Validate()).ExitCode);

        AssertFailure(
            Run("update", fixture, omitReceiptPath: true),
            ExitCodes.InvalidArguments,
            "--safe-read-admission-receipt");
        AssertFailure(
            Run("update", fixture, omitReceiptPin: true),
            ExitCodes.InvalidArguments,
            "--safe-read-admission-receipt");
        AssertFailure(
            Run("update", fixture, omitPackagePin: true),
            ExitCodes.InvalidArguments,
            "--safe-read-package-pin-sha256");
        Assert.False(File.Exists(Context().StatePath));
    }

    [Theory]
    [InlineData("id")]
    [InlineData("manifestFileName")]
    [InlineData("assemblyPath")]
    [InlineData("type")]
    [InlineData("name")]
    [InlineData("fullClassName")]
    [InlineData("addInId")]
    [InlineData("vendorId")]
    [InlineData("vendorDescription")]
    public void Every_one_field_or_case_only_SafeRead_profile_variation_is_rejected(string field)
    {
        var manifest = DowngradedManifestWithoutAdmission(CreateAdmittedBundle($"identity-drift-{field}"));
        var profile = Assert.Single(manifest.RevitAddinProfiles);
        switch (field)
        {
            case "id":
                profile.Id = "Safe-Read";
                foreach (var component in manifest.Components.Where(component => component.Kind == "revit-addin"))
                    component.RevitAddinProfileId = profile.Id;
                break;
            case "manifestFileName": profile.ManifestFileName = "revitoperator.safereadhost.addin"; break;
            case "assemblyPath": profile.AssemblyPath = "Payload/RevitOperator.SafeReadHost.dll"; break;
            case "type": profile.Type = "application"; break;
            case "name": profile.Name = "Revit operator Safe Read Host"; break;
            case "fullClassName": profile.FullClassName = "revitoperator.safereadhost.app"; break;
            case "addInId": profile.AddInId = SafeReadAdmissionContracts.AddInId.ToLowerInvariant(); break;
            case "vendorId": profile.VendorId = "bimt"; break;
            case "vendorDescription": profile.VendorDescription = "BIMTools Revit operator Safe Read Host"; break;
            default: throw new InvalidOperationException($"Unknown profile field: {field}");
        }

        var failure = Assert.Throws<DeploymentException>(() => manifest.Validate());
        Assert.Equal(ExitCodes.ManifestInvalid, failure.ExitCode);
    }

    [Theory]
    [InlineData("manifestFileName")]
    [InlineData("addInId")]
    [InlineData("fullClassName")]
    [InlineData("assemblyPath")]
    [InlineData("assemblyBaseName")]
    public void Every_reserved_SafeRead_marker_independently_requires_the_canonical_profile(string marker)
    {
        var manifest = DowngradedManifestWithoutAdmission(CreateAdmittedBundle($"identity-marker-{marker}"));
        var profile = Assert.Single(manifest.RevitAddinProfiles);
        profile.Id = "generic-profile";
        profile.ManifestFileName = "Generic.addin";
        profile.AssemblyPath = "payload/Generic.dll";
        profile.Type = "Application";
        profile.Name = "Generic add-in";
        profile.FullClassName = "Example.Generic.App";
        profile.AddInId = "11111111-2222-3333-4444-555555555555";
        profile.VendorId = "TEST";
        profile.VendorDescription = "Generic test add-in";
        foreach (var component in manifest.Components.Where(component => component.Kind == "revit-addin"))
            component.RevitAddinProfileId = profile.Id;

        switch (marker)
        {
            case "manifestFileName": profile.ManifestFileName = SafeReadAdmissionContracts.ManifestFileName.ToLowerInvariant(); break;
            case "addInId": profile.AddInId = SafeReadAdmissionContracts.AddInId.ToLowerInvariant(); break;
            case "fullClassName": profile.FullClassName = SafeReadAdmissionContracts.FullClassName.ToLowerInvariant(); break;
            case "assemblyPath": profile.AssemblyPath = SafeReadAdmissionContracts.HostRelativePath.ToUpperInvariant(); break;
            case "assemblyBaseName": profile.AssemblyPath = $"other/{Path.GetFileName(SafeReadAdmissionContracts.HostRelativePath)}"; break;
            default: throw new InvalidOperationException($"Unknown reserved marker: {marker}");
        }

        var failure = Assert.Throws<DeploymentException>(() => manifest.Validate());
        Assert.Equal(ExitCodes.ManifestInvalid, failure.ExitCode);
        Assert.Contains("reserved production SafeRead identity", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Generic_schema_v2_profile_without_a_reserved_marker_remains_compatible()
    {
        var manifest = DowngradedManifestWithoutAdmission(CreateAdmittedBundle("generic-schema-v2"));
        var profile = Assert.Single(manifest.RevitAddinProfiles);
        profile.Id = "generic-profile";
        profile.ManifestFileName = "Generic.addin";
        profile.AssemblyPath = "payload/Generic.dll";
        profile.Name = "Generic add-in";
        profile.FullClassName = "Example.Generic.App";
        profile.AddInId = "11111111-2222-3333-4444-555555555555";
        profile.VendorId = "TEST";
        profile.VendorDescription = "Generic test add-in";
        foreach (var component in manifest.Components.Where(component => component.Kind == "revit-addin"))
            component.RevitAddinProfileId = profile.Id;

        manifest.Validate();
    }

    [Fact]
    public void Exact_three_year_package_installs_persists_and_revalidates_admission()
    {
        var fixture = CreateAdmittedBundle("1.0.0");
        var install = Run("update", fixture);
        Assert.True(install.Ok, install.Message);

        var state = State();
        Assert.Equal(3, state.SchemaVersion);
        var admission = Assert.Single(state.SafeReadAdmissions);
        Assert.Equal(fixture.ReceiptSha256, admission.ReceiptSha256);
        Assert.Equal(fixture.PackagePinSha256, admission.PackagePinSha256);
        Assert.Equal(new[] { "2023", "2024", "2025" }, admission.Targets.Select(target => target.RevitYear).Order().ToArray());
        foreach (var year in new[] { "2023", "2024", "2025" })
        {
            var manifestPath = AddinPath(year);
            Assert.True(File.Exists(manifestPath));
            Assert.Contains(
                Path.Combine(Context().ReleasesRoot, "1.0.0", $"safe-read-{year}", "payload", "RevitOperator.SafeReadHost.dll"),
                File.ReadAllText(manifestPath),
                StringComparison.OrdinalIgnoreCase);
        }
        var persistedReceipt = Path.Combine(
            Context().ReleasesRoot,
            "1.0.0",
            SafeReadAdmissionContracts.PersistedReceiptRelativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.Equal(File.ReadAllBytes(fixture.ReceiptPath), File.ReadAllBytes(persistedReceipt));
        Assert.True(Run("validate").Ok);
    }

    [Fact]
    public void External_pin_wrong_root_year_manifest_and_copied_tree_mismatches_fail_closed()
    {
        var wrongReceiptPin = CreateAdmittedBundle("wrong-receipt-pin");
        AssertFailure(
            Run("update", wrongReceiptPin, receiptPinOverride: Hash("not the receipt")),
            ExitCodes.HashMismatch,
            "externally supplied receipt hash");

        var wrongPackagePin = CreateAdmittedBundle("wrong-package-pin");
        AssertFailure(
            Run("update", wrongPackagePin, packagePinOverride: Hash("not package pins")),
            ExitCodes.HashMismatch,
            "package trust pin");

        var wrongRoot = CreateAdmittedBundle("wrong-root");
        RewriteReceipt(wrongRoot, root =>
        {
            root["manifestAssemblyRoot"] = Path.Combine(_root, "detached", "release");
            return root;
        });
        AssertFailure(Run("update", wrongRoot), ExitCodes.ValidationFailed, "wrong final release root");

        var wrongYear = CreateAdmittedBundle("wrong-year");
        RewriteReceipt(wrongYear, root =>
        {
            var targets = root["operatorDeploy"]!["targets"]!.AsArray();
            targets[0]!["revitYear"] = "2024";
            return root;
        });
        AssertFailure(Run("update", wrongYear), ExitCodes.ValidationFailed, "Revit 2023");

        var copiedTree = CreateAdmittedBundle("copied-tree");
        File.WriteAllText(
            Path.Combine(copiedTree.PackageRoot, "targets", "2024", "payload", "copied-foreign.dll"),
            "not admitted");
        AssertFailure(Run("update", copiedTree), ExitCodes.ValidationFailed, "file set is not exact");

        var detachedManifest = CreateAdmittedBundle("detached-manifest");
        var manifest = ReleaseManifest.Load(detachedManifest.ManifestPath);
        manifest.GeneratedAtUtc = "2035-01-01T00:00:00Z";
        File.WriteAllText(detachedManifest.ManifestPath, JsonSerializer.Serialize(manifest, ReleaseManifest.JsonOptions), new UTF8Encoding(false));
        AssertFailure(Run("update", detachedManifest), ExitCodes.ValidationFailed, "OperatorDeploy manifest metadata");
        Assert.False(File.Exists(Context().StatePath));
    }

    [Fact]
    public void Validate_and_repair_recheck_persisted_receipt_component_and_manifest_bytes()
    {
        var fixture = CreateAdmittedBundle("1.0.0");
        Assert.True(Run("update", fixture).Ok);
        var releaseRoot = Path.Combine(Context().ReleasesRoot, "1.0.0");
        var persistedReceipt = Path.Combine(releaseRoot, SafeReadAdmissionContracts.PersistedReceiptRelativePath.Replace('/', Path.DirectorySeparatorChar));

        File.AppendAllText(persistedReceipt, " ");
        AssertFailure(Run("validate"), ExitCodes.ValidationFailed, "receipt hash");
        var repairedReceipt = Run("repair", fixture);
        Assert.True(repairedReceipt.Ok, repairedReceipt.Message);

        var host = Path.Combine(releaseRoot, "safe-read-2024", SafeReadAdmissionContracts.HostRelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.AppendAllText(host, "tamper");
        AssertFailure(Run("validate"), ExitCodes.ValidationFailed, "host is missing or has the wrong length");
        var repairedHost = Run("repair", fixture);
        Assert.True(repairedHost.Ok, repairedHost.Message);

        File.AppendAllText(Path.Combine(releaseRoot, "manifest.json"), " ");
        AssertFailure(Run("validate"), ExitCodes.ValidationFailed, "OperatorDeploy manifest");
    }

    [Fact]
    public void Rollback_reverifies_target_admission_and_rejects_tampered_history()
    {
        var first = CreateAdmittedBundle("1.0.0");
        var second = CreateAdmittedBundle("2.0.0");
        Assert.True(Run("update", first).Ok);
        Assert.True(Run("update", second).Ok);
        var firstReceipt = Path.Combine(
            Context().ReleasesRoot,
            "1.0.0",
            SafeReadAdmissionContracts.PersistedReceiptRelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.AppendAllText(firstReceipt, "tamper");

        var blocked = Run("rollback");
        AssertFailure(blocked, ExitCodes.ValidationFailed, "receipt hash");
        Assert.Equal("2.0.0", State().CurrentRelease);

        File.WriteAllBytes(firstReceipt, File.ReadAllBytes(first.ReceiptPath));
        var rollback = Run("rollback");
        Assert.True(rollback.Ok, rollback.Message);
        Assert.Equal("1.0.0", State().CurrentRelease);
        Assert.True(Run("validate").Ok);
    }

    [Theory]
    [InlineData("after-release-root-placement")]
    [InlineData("after-target:2024:safe-read")]
    [InlineData("before-state-commit")]
    public void Crash_recovery_revalidates_admission_and_restores_exact_previous_release(string killPoint)
    {
        var first = CreateAdmittedBundle("1.0.0");
        var second = CreateAdmittedBundle("2.0.0");
        Assert.True(Run("update", first).Ok);
        var beforeState = File.ReadAllBytes(Context().StatePath);
        var beforeManifests = new[] { "2023", "2024", "2025" }.ToDictionary(year => year, year => File.ReadAllBytes(AddinPath(year)));

        Assert.Equal(137, RunCrash("update", second, killPoint));
        Assert.True(File.Exists(Context().ActivationJournalPath));
        Assert.Equal(0, RunCrash("status", null, "no-kill"));

        Assert.Equal(beforeState, File.ReadAllBytes(Context().StatePath));
        foreach (var pair in beforeManifests) Assert.Equal(pair.Value, File.ReadAllBytes(AddinPath(pair.Key)));
        Assert.Equal("1.0.0", State().CurrentRelease);
        Assert.True(Run("validate").Ok);
        Assert.False(File.Exists(Context().ActivationJournalPath));
    }

    public static IEnumerable<object[]> RejectedAdmissionCrashCases()
    {
        foreach (var scenario in new[] { "first-install", "version-update", "same-version-repair" })
        {
            foreach (var checkpoint in new[]
                     {
                         "after-target:2023:safe-read",
                         "after-target:2024:safe-read",
                         "after-target:2025:safe-read",
                         "before-state-commit",
                         "after-state-commit"
                     })
                yield return new object[] { scenario, checkpoint };
        }
    }

    [Theory]
    [MemberData(nameof(RejectedAdmissionCrashCases))]
    public void Tampered_crash_candidate_disables_live_controls_before_quarantine(string scenario, string killPoint)
    {
        var first = CreateAdmittedBundle("1.0.0");
        AdmissionFixture candidate;
        string operation;
        if (scenario == "first-install")
        {
            candidate = first;
            operation = "update";
        }
        else
        {
            Assert.True(Run("update", first).Ok);
            candidate = scenario == "version-update" ? CreateAdmittedBundle("2.0.0") : first;
            operation = scenario == "same-version-repair" ? "repair" : "update";
        }

        var beforeState = File.Exists(Context().StatePath) ? File.ReadAllBytes(Context().StatePath) : null;
        var beforeManifests = new[] { "2023", "2024", "2025" }
            .ToDictionary(
                year => year,
                year => File.Exists(AddinPath(year)) ? File.ReadAllBytes(AddinPath(year)) : null);
        var originalHost = File.ReadAllBytes(Path.Combine(
            candidate.PackageRoot,
            "targets",
            "2024",
            SafeReadAdmissionContracts.HostRelativePath.Replace('/', Path.DirectorySeparatorChar)));

        Assert.Equal(137, RunCrash(operation, candidate, killPoint));
        var candidateHost = Path.Combine(
            Context().ReleasesRoot,
            candidate.ReleaseVersion,
            "safe-read-2024",
            SafeReadAdmissionContracts.HostRelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.AppendAllText(candidateHost, "concurrent tamper");
        var tampered = File.ReadAllBytes(candidateHost);

        Assert.NotEqual(0, RunCrash("status", null, "no-kill"));
        Assert.Equal(tampered, File.ReadAllBytes(candidateHost));
        Assert.False(File.Exists(Context().ActivationJournalPath));
        Assert.Single(Directory.GetFiles(Context().DeploymentRoot, "activation-journal.quarantine-*.json"));

        if (scenario == "same-version-repair")
        {
            Assert.False(File.Exists(Context().StatePath));
            foreach (var year in beforeManifests.Keys) Assert.False(File.Exists(AddinPath(year)));
            var displaced = Assert.Single(Directory.GetDirectories(Context().ReleasesRoot, ".1.0.0.replaced-*"));
            Assert.Equal(originalHost, File.ReadAllBytes(Path.Combine(
                displaced,
                "safe-read-2024",
                SafeReadAdmissionContracts.HostRelativePath.Replace('/', Path.DirectorySeparatorChar))));
        }
        else
        {
            if (beforeState == null) Assert.False(File.Exists(Context().StatePath));
            else Assert.Equal(beforeState, File.ReadAllBytes(Context().StatePath));
            foreach (var pair in beforeManifests)
            {
                if (pair.Value == null) Assert.False(File.Exists(AddinPath(pair.Key)));
                else Assert.Equal(pair.Value, File.ReadAllBytes(AddinPath(pair.Key)));
            }
        }
    }

    [Fact]
    public void Rejected_admission_preserves_a_foreign_live_control_while_restoring_other_owned_controls()
    {
        var first = CreateAdmittedBundle("1.0.0");
        var second = CreateAdmittedBundle("2.0.0");
        Assert.True(Run("update", first).Ok);
        var beforeState = File.ReadAllBytes(Context().StatePath);
        var before2025 = File.ReadAllBytes(AddinPath("2025"));

        Assert.Equal(137, RunCrash("update", second, "after-target:2024:safe-read"));
        var candidateHost = Path.Combine(
            Context().ReleasesRoot,
            "2.0.0",
            "safe-read-2024",
            SafeReadAdmissionContracts.HostRelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.AppendAllText(candidateHost, "concurrent tamper");
        var foreignControl = new UTF8Encoding(false).GetBytes("<foreign-control />");
        File.WriteAllBytes(AddinPath("2023"), foreignControl);

        Assert.NotEqual(0, RunCrash("status", null, "no-kill"));
        Assert.Equal(foreignControl, File.ReadAllBytes(AddinPath("2023")));
        Assert.Equal(before2025, File.ReadAllBytes(AddinPath("2025")));
        Assert.Equal(beforeState, File.ReadAllBytes(Context().StatePath));
        Assert.Single(Directory.GetFiles(Context().DeploymentRoot, "activation-journal.quarantine-*.json"));
    }

    [Fact]
    public void Test_root_mutex_is_shared_cross_process_without_contending_on_the_production_mutex()
    {
        using (var lease = DeploymentMutex.TryAcquireForTestRoot(Context().LocalAppData))
        {
            Assert.NotNull(lease);
            Assert.Equal(ExitCodes.InstallFailed, RunCrash("status", null, "no-kill"));
        }

        Assert.Equal(ExitCodes.NoInstalledRelease, RunCrash("status", null, "no-kill"));
    }

    private AdmissionFixture CreateAdmittedBundle(string version)
    {
        var bundleRoot = Path.Combine(_root, "bundles", version);
        var packageRoot = Path.Combine(bundleRoot, "safe-read-package");
        var coordination = Path.Combine(_root, "coordination");
        Directory.CreateDirectory(packageRoot);
        Directory.CreateDirectory(coordination);

        var sourceReceipt = new Dictionary<string, object?>
        {
            ["schemaVersion"] = 1,
            ["commit"] = new string('a', 40),
            ["proofTree"] = new string('b', 40),
            ["hostTree"] = new string('c', 40),
            ["archiveSha256"] = "sha256:" + new string('d', 64)
        };
        WriteJson(Path.Combine(packageRoot, "source.snapshot.receipt.json"), sourceReceipt);
        var sourceSha = HashFile(Path.Combine(packageRoot, "source.snapshot.receipt.json"));

        var assemblySource = typeof(ReleaseManifest).Assembly.Location;
        var assemblyMvid = typeof(ReleaseManifest).Assembly.ManifestModule.ModuleVersionId.ToString("D");
        var proofFacts = new Dictionary<string, object?>
        {
            ["proofKind"] = "revit-safe-read-certified-kernel/v1",
            ["manifestSha256"] = new string('1', 64),
            ["verifierProfileId"] = "revit-safe-read-sheet-count-kernel/v1",
            ["verifierProfileSha256"] = new string('2', 64),
            ["verifierBundleSha256"] = new string('3', 64),
            ["sourceLockSha256"] = new string('4', 64),
            ["apiLockSha256"] = new string('5', 64),
            ["sdkLockSha256"] = new string('6', 64)
        };
        var runtimeFactsByYear = new Dictionary<string, Dictionary<string, object?>>(StringComparer.Ordinal);
        foreach (var year in new[] { "2023", "2024", "2025" })
        {
            var targetRoot = Path.Combine(packageRoot, "targets", year);
            Directory.CreateDirectory(Path.Combine(targetRoot, "payload"));
            Directory.CreateDirectory(Path.Combine(targetRoot, "manifest"));
            Directory.CreateDirectory(Path.Combine(targetRoot, "proof"));
            File.Copy(assemblySource, Path.Combine(targetRoot, SafeReadAdmissionContracts.HostRelativePath.Replace('/', Path.DirectorySeparatorChar)));
            File.Copy(assemblySource, Path.Combine(targetRoot, SafeReadAdmissionContracts.ExecutorRelativePath.Replace('/', Path.DirectorySeparatorChar)));
            File.WriteAllText(
                Path.Combine(targetRoot, SafeReadAdmissionContracts.ManifestTemplateRelativePath.Replace('/', Path.DirectorySeparatorChar)),
                """
                <?xml version="1.0" encoding="utf-8"?>
                <RevitAddIns>
                  <AddIn Type="Application">
                    <Name>Revit Operator Safe Read Host</Name>
                    <Assembly>{{ASSEMBLY_PATH}}</Assembly>
                    <FullClassName>RevitOperator.SafeReadHost.App</FullClassName>
                    <AddInId>AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E</AddInId>
                    <VendorId>BIMT</VendorId>
                    <VendorDescription>BIMTools Revit Operator Safe Read Host</VendorDescription>
                  </AddIn>
                </RevitAddIns>
                """,
                new UTF8Encoding(false));
            var proofReceipt = new Dictionary<string, object?>(proofFacts)
            {
                ["schemaVersion"] = 1,
                ["mode"] = "check",
                ["status"] = "verified",
                ["certified"] = true
            };
            WriteJson(Path.Combine(targetRoot, SafeReadAdmissionContracts.ProofReceiptRelativePath.Replace('/', Path.DirectorySeparatorChar)), proofReceipt);
            var executorSha = HashFile(Path.Combine(targetRoot, SafeReadAdmissionContracts.ExecutorRelativePath.Replace('/', Path.DirectorySeparatorChar)));
            var equivalence = new Dictionary<string, object?>
            {
                ["schemaVersion"] = 1,
                ["status"] = "verified",
                ["equivalent"] = true,
                ["candidateSha256"] = executorSha[7..],
                ["issues"] = Array.Empty<object>()
            };
            WriteJson(Path.Combine(targetRoot, SafeReadAdmissionContracts.EquivalenceReceiptRelativePath.Replace('/', Path.DirectorySeparatorChar)), equivalence);

            var runtime = new Dictionary<string, object?>
            {
                ["schema"] = "revit-operator.safe-read-runtime-attestation.v1",
                ["state"] = "active",
                ["issued_at_utc"] = "2030-01-01T00:00:00.000Z",
                ["expires_at_utc"] = "2030-01-01T00:05:00.000Z",
                ["route_id"] = "safe_read.sheet_count.v1",
                ["route_contract_sha256"] = "sha256:" + new string('7', 64),
                ["policy_sha256"] = "sha256:" + new string('8', 64),
                ["proof_sha256"] = HashFile(Path.Combine(targetRoot, SafeReadAdmissionContracts.ProofReceiptRelativePath.Replace('/', Path.DirectorySeparatorChar))),
                ["executor_id"] = "revit-operator.safe-read-host.v1",
                ["runtime_tuple"] = new Dictionary<string, object?>
                {
                    ["host_content_sha256"] = executorSha,
                    ["host_mvid"] = assemblyMvid,
                    ["revit_api_content_sha256"] = "sha256:" + new string('9', 64),
                    ["revit_api_mvid"] = Guid.Parse($"00000000-0000-0000-0000-00000000{year}").ToString("D"),
                    ["revit_version"] = year
                }
            };
            var runtimePath = Path.Combine(targetRoot, SafeReadAdmissionContracts.RuntimeAttestationRelativePath.Replace('/', Path.DirectorySeparatorChar));
            WriteJson(runtimePath, runtime);
            var runtimePin = HashFile(runtimePath);
            File.WriteAllText(
                Path.Combine(targetRoot, SafeReadAdmissionContracts.RuntimeAttestationPinRelativePath.Replace('/', Path.DirectorySeparatorChar)),
                runtimePin + "\n",
                new UTF8Encoding(false));
            runtimeFactsByYear[year] = runtime;
        }

        var releaseManifest = new Dictionary<string, object?>
        {
            ["schemaVersion"] = "revit-operator.safe-read-package-release.v3",
            ["releaseId"] = $"safe-read-{version}",
            ["source"] = new Dictionary<string, object?>
            {
                ["path"] = "source.snapshot.receipt.json",
                ["sha256"] = sourceSha,
                ["commit"] = sourceReceipt["commit"],
                ["proofTree"] = sourceReceipt["proofTree"],
                ["hostTree"] = sourceReceipt["hostTree"],
                ["archiveSha256"] = sourceReceipt["archiveSha256"]
            },
            ["targets"] = new[] { "2023", "2024", "2025" }
        };
        WriteJson(Path.Combine(packageRoot, "release-manifest.json"), releaseManifest);
        WriteJson(Path.Combine(packageRoot, "package-pins.json"), new Dictionary<string, object?>
        {
            ["schemaVersion"] = "revit-operator.safe-read-package-pins.v3",
            ["releaseId"] = $"safe-read-{version}"
        });

        var profile = SafeReadProfile();
        var manifest = new ReleaseManifest
        {
            SchemaVersion = 3,
            ReleaseVersion = version,
            GeneratedAtUtc = "2026-07-29T12:00:00Z",
            SourceRevision = "test-" + version,
            SafeReadAdmission = new SafeReadAdmissionMetadata
            {
                Schema = SafeReadAdmissionContracts.MetadataSchema,
                ProfileId = profile.Id,
                PackageRoot = "safe-read-package",
                EvidenceComponentId = "safe-read-evidence",
                Targets = new[] { "2023", "2024", "2025" }
                    .Select(year => new SafeReadAdmissionTarget { RevitYear = year, ComponentId = $"safe-read-{year}" })
                    .ToList()
            }
        };
        manifest.RevitAddinProfiles.Add(profile);
        manifest.Components.Add(Component(
            "safe-read-evidence",
            "safe-read-evidence",
            "safe-read-package",
            packageRoot,
            files: Directory.GetFiles(packageRoot, "*", SearchOption.TopDirectoryOnly)));
        foreach (var year in new[] { "2023", "2024", "2025" })
        {
            var targetRoot = Path.Combine(packageRoot, "targets", year);
            manifest.Components.Add(Component(
                $"safe-read-{year}",
                "revit-addin",
                $"safe-read-package/targets/{year}",
                targetRoot,
                year,
                profile.Id,
                Directory.GetFiles(targetRoot, "*", SearchOption.AllDirectories)));
        }
        manifest.Validate();
        var manifestPath = Path.Combine(bundleRoot, "manifest.json");
        File.WriteAllText(manifestPath, JsonSerializer.Serialize(manifest, ReleaseManifest.JsonOptions), new UTF8Encoding(false));
        var operatorManifestSha = HashFile(manifestPath);
        var packagePin = HashFile(Path.Combine(packageRoot, "package-pins.json"));
        var finalRoot = Path.Combine(Context().ReleasesRoot, version);
        var receiptTargets = new List<Dictionary<string, object?>>();
        var installedTargets = new List<InstalledSafeReadTarget>();
        foreach (var year in new[] { "2023", "2024", "2025" })
        {
            var targetRoot = Path.Combine(packageRoot, "targets", year);
            var componentId = $"safe-read-{year}";
            var hostPath = Path.Combine(targetRoot, SafeReadAdmissionContracts.HostRelativePath.Replace('/', Path.DirectorySeparatorChar));
            var executorPath = Path.Combine(targetRoot, SafeReadAdmissionContracts.ExecutorRelativePath.Replace('/', Path.DirectorySeparatorChar));
            var equivalencePath = Path.Combine(targetRoot, SafeReadAdmissionContracts.EquivalenceReceiptRelativePath.Replace('/', Path.DirectorySeparatorChar));
            var proofPath = Path.Combine(targetRoot, SafeReadAdmissionContracts.ProofReceiptRelativePath.Replace('/', Path.DirectorySeparatorChar));
            var runtimePath = Path.Combine(targetRoot, SafeReadAdmissionContracts.RuntimeAttestationRelativePath.Replace('/', Path.DirectorySeparatorChar));
            var assemblyPath = Path.Combine(finalRoot, componentId, SafeReadAdmissionContracts.HostRelativePath.Replace('/', Path.DirectorySeparatorChar));
            var manifestBytes = DeploymentEngine.BuildAddinXmlBytes(profile, assemblyPath);
            var manifestPin = Hash(manifestBytes);
            installedTargets.Add(new InstalledSafeReadTarget
            {
                RevitYear = year,
                ComponentId = componentId,
                AssemblyPath = assemblyPath,
                ManifestSha256 = manifestPin
            });
            var runtime = runtimeFactsByYear[year];
            var tuple = (Dictionary<string, object?>)runtime["runtime_tuple"]!;
            receiptTargets.Add(new Dictionary<string, object?>
            {
                ["revitYear"] = year,
                ["framework"] = year == "2025" ? "net8.0-windows" : "net48",
                ["host"] = new Dictionary<string, object?>
                {
                    ["path"] = SafeReadAdmissionContracts.HostRelativePath,
                    ["sha256"] = HashFile(hostPath),
                    ["sizeBytes"] = new FileInfo(hostPath).Length,
                    ["mvid"] = assemblyMvid,
                    ["signerThumbprint"] = new string('A', 40)
                },
                ["executor"] = new Dictionary<string, object?>
                {
                    ["path"] = SafeReadAdmissionContracts.ExecutorRelativePath,
                    ["sha256"] = HashFile(executorPath),
                    ["sizeBytes"] = new FileInfo(executorPath).Length,
                    ["mvid"] = assemblyMvid,
                    ["signerThumbprint"] = new string('A', 40),
                    ["equivalence"] = new Dictionary<string, object?>
                    {
                        ["path"] = SafeReadAdmissionContracts.EquivalenceReceiptRelativePath,
                        ["sha256"] = HashFile(equivalencePath),
                        ["unsignedSha256"] = "sha256:" + new string('a', 64),
                        ["candidateSha256"] = HashFile(executorPath),
                        ["canonicalPeSha256"] = new string('b', 64)
                    }
                },
                ["runtimeAttestation"] = new Dictionary<string, object?>
                {
                    ["path"] = SafeReadAdmissionContracts.RuntimeAttestationRelativePath,
                    ["sha256"] = HashFile(runtimePath),
                    ["sizeBytes"] = new FileInfo(runtimePath).Length,
                    ["state"] = runtime["state"],
                    ["issuedAtUtc"] = runtime["issued_at_utc"],
                    ["expiresAtUtc"] = runtime["expires_at_utc"],
                    ["routeId"] = runtime["route_id"],
                    ["routeContractSha256"] = runtime["route_contract_sha256"],
                    ["policySha256"] = runtime["policy_sha256"],
                    ["proofSha256"] = runtime["proof_sha256"],
                    ["executorId"] = runtime["executor_id"],
                    ["runtimeTuple"] = new Dictionary<string, object?>
                    {
                        ["hostContentSha256"] = tuple["host_content_sha256"],
                        ["hostMvid"] = tuple["host_mvid"],
                        ["revitApiContentSha256"] = tuple["revit_api_content_sha256"],
                        ["revitApiMvid"] = tuple["revit_api_mvid"],
                        ["revitVersion"] = tuple["revit_version"]
                    }
                },
                ["renderedManifest"] = new Dictionary<string, object?>
                {
                    ["fileName"] = profile.ManifestFileName,
                    ["sha256"] = manifestPin,
                    ["sizeBytes"] = manifestBytes.LongLength,
                    ["encoding"] = "utf-8-no-bom",
                    ["fields"] = new Dictionary<string, object?>
                    {
                        ["name"] = profile.Name,
                        ["assembly"] = assemblyPath,
                        ["fullClassName"] = profile.FullClassName,
                        ["addInId"] = profile.AddInId,
                        ["vendorId"] = profile.VendorId,
                        ["vendorDescription"] = profile.VendorDescription
                    }
                }
            });
        }
        var layoutSha = SafeReadAdmissionVerifier.ComputeLayoutSha256(
            version,
            operatorManifestSha,
            "safe-read-package",
            "safe-read-evidence",
            installedTargets);
        var proofPath2023 = Path.Combine(packageRoot, "targets", "2023", SafeReadAdmissionContracts.ProofReceiptRelativePath.Replace('/', Path.DirectorySeparatorChar));
        var receipt = new Dictionary<string, object?>
        {
            ["schema"] = SafeReadAdmissionContracts.ReceiptSchema,
            ["status"] = "verified",
            ["releaseId"] = $"safe-read-{version}",
            ["releaseManifest"] = new Dictionary<string, object?>
            {
                ["path"] = "release-manifest.json",
                ["sha256"] = HashFile(Path.Combine(packageRoot, "release-manifest.json"))
            },
            ["packagePins"] = new Dictionary<string, object?>
            {
                ["path"] = "package-pins.json",
                ["externalSha256"] = packagePin
            },
            ["source"] = ((Dictionary<string, object?>)releaseManifest["source"]!),
            ["proof"] = new Dictionary<string, object?>(proofFacts)
            {
                ["targetPaths"] = new[]
                {
                    "targets/2023/proof/proof.receipt.json",
                    "targets/2024/proof/proof.receipt.json",
                    "targets/2025/proof/proof.receipt.json"
                },
                ["sha256"] = HashFile(proofPath2023)
            },
            ["manifestAssemblyRoot"] = finalRoot,
            ["operatorDeploy"] = new Dictionary<string, object?>
            {
                ["schema"] = SafeReadAdmissionContracts.LayoutSchema,
                ["releaseVersion"] = version,
                ["releaseManifestSha256"] = operatorManifestSha,
                ["packageRoot"] = "safe-read-package",
                ["evidenceComponentId"] = "safe-read-evidence",
                ["layoutSha256"] = layoutSha,
                ["targets"] = installedTargets.Select(target => new Dictionary<string, object?>
                {
                    ["revitYear"] = target.RevitYear,
                    ["componentId"] = target.ComponentId,
                    ["assemblyRelativePath"] = $"{target.ComponentId}/{SafeReadAdmissionContracts.HostRelativePath}",
                    ["assemblyPath"] = target.AssemblyPath
                }).ToList()
            },
            ["targets"] = receiptTargets
        };
        var receiptPath = Path.Combine(coordination, $"{version}.admission.receipt.v2.json");
        WriteJson(receiptPath, receipt);
        return new AdmissionFixture(
            bundleRoot,
            packageRoot,
            manifestPath,
            receiptPath,
            HashFile(receiptPath),
            packagePin);
    }

    private static ReleaseManifest DowngradedManifestWithoutAdmission(AdmissionFixture fixture)
    {
        var manifest = ReleaseManifest.Load(fixture.ManifestPath);
        manifest.SchemaVersion = 2;
        manifest.SafeReadAdmission = null;
        manifest.Components.RemoveAll(component => component.Kind == "safe-read-evidence");
        return manifest;
    }

    private OperationResult Run(
        string operation,
        AdmissionFixture? fixture = null,
        bool omitReceiptPath = false,
        bool omitReceiptPin = false,
        bool omitPackagePin = false,
        string? receiptPinOverride = null,
        string? packagePinOverride = null)
    {
        var options = new DeploymentOptions
        {
            Operation = operation,
            ManifestPath = fixture?.ManifestPath,
            SafeReadAdmissionReceiptPath = fixture == null || omitReceiptPath ? null : fixture.ReceiptPath,
            SafeReadAdmissionReceiptSha256 = fixture == null || omitReceiptPin ? null : receiptPinOverride ?? fixture.ReceiptSha256,
            SafeReadPackagePinSha256 = fixture == null || omitPackagePin ? null : packagePinOverride ?? fixture.PackagePinSha256,
            Quiet = true
        };
        return new DeploymentEngine(Context(), options, TextWriter.Null).Execute();
    }

    private int RunCrash(string operation, AdmissionFixture? fixture, string killPoint)
    {
        var configuration = new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name;
        var harness = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            "..",
            "..",
            "..",
            "CrashHarness",
            "bin",
            configuration,
            "net8.0-windows",
            "win-x64",
            "OperatorDeploy.CrashHarness.dll"));
        Assert.True(File.Exists(harness), $"Crash harness was not built: {harness}");
        var context = Context();
        var input = new
        {
            context.LocalAppData,
            context.AppData,
            context.Desktop,
            context.ProgramFiles,
            context.CommonAppData,
            Operation = operation,
            ManifestPath = fixture?.ManifestPath,
            SafeReadAdmissionReceiptPath = fixture?.ReceiptPath,
            SafeReadAdmissionReceiptSha256 = fixture?.ReceiptSha256,
            SafeReadPackagePinSha256 = fixture?.PackagePinSha256,
            BundleOnly = false,
            KillPoint = killPoint
        };
        var encoded = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(input));
        var start = new ProcessStartInfo("dotnet")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add(harness);
        start.ArgumentList.Add(encoded);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Crash harness did not start.");
        Assert.True(process.WaitForExit(30_000), "Crash harness did not exit within 30 seconds.");
        return process.ExitCode;
    }

    private DeploymentContext Context()
        => new()
        {
            LocalAppData = Path.Combine(_root, "profile", "local"),
            AppData = Path.Combine(_root, "profile", "roaming"),
            Desktop = Path.Combine(_root, "profile", "desktop"),
            ProgramFiles = Path.Combine(_root, "program-files"),
            CommonAppData = Path.Combine(_root, "program-data"),
            WindowsVersion = new Version(10, 0, 19045),
            IsRevitRunning = () => false,
            UtcNow = () => new DateTimeOffset(2026, 7, 29, 12, 0, 0, TimeSpan.Zero),
            GetEnvironmentVariable = _ => null,
            TryAcquireDeploymentMutex = () => DeploymentMutex.TryAcquireForTestRoot(Path.Combine(_root, "profile", "local")),
            ActivationCheckpoint = point => _checkpoint(point),
            DesktopShortcuts = new NoopDesktopShortcutManager()
        };

    private InstalledState State()
        => JsonSerializer.Deserialize<InstalledState>(File.ReadAllText(Context().StatePath), ReleaseManifest.JsonOptions)!;

    private string AddinPath(string year)
        => Path.Combine(Context().AppData, "Autodesk", "Revit", "Addins", year, "RevitOperator.SafeReadHost.addin");

    private static RevitAddinProfile SafeReadProfile() => new()
    {
        Id = "safe-read",
        ManifestFileName = "RevitOperator.SafeReadHost.addin",
        AssemblyPath = SafeReadAdmissionContracts.HostRelativePath,
        Name = "Revit Operator Safe Read Host",
        FullClassName = "RevitOperator.SafeReadHost.App",
        AddInId = "AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E",
        VendorId = "BIMT",
        VendorDescription = "BIMTools Revit Operator Safe Read Host"
    };

    private static ReleaseComponent Component(
        string id,
        string kind,
        string payloadPath,
        string payloadRoot,
        string? year = null,
        string? profileId = null,
        IEnumerable<string>? files = null)
        => new()
        {
            Id = id,
            Kind = kind,
            Version = "test",
            Required = true,
            PayloadPath = payloadPath,
            RevitYear = year,
            RevitAddinProfileId = profileId,
            Files = (files ?? Array.Empty<string>()).Select(path => new ReleaseFile
            {
                Path = Path.GetRelativePath(payloadRoot, path).Replace('\\', '/'),
                Size = new FileInfo(path).Length,
                Sha256 = HashFile(path)[7..]
            }).OrderBy(file => file.Path, StringComparer.Ordinal).ToList()
        };

    private static void RewriteReceipt(
        AdmissionFixture fixture,
        Func<System.Text.Json.Nodes.JsonObject, System.Text.Json.Nodes.JsonObject> rewrite)
    {
        var root = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(fixture.ReceiptPath))!.AsObject();
        var rewritten = rewrite(root);
        File.WriteAllText(fixture.ReceiptPath, rewritten.ToJsonString(ReleaseManifest.JsonOptions), new UTF8Encoding(false));
        fixture.ReceiptSha256 = HashFile(fixture.ReceiptPath);
    }

    private static void AssertFailure(OperationResult result, int exitCode, string message)
    {
        Assert.False(result.Ok);
        Assert.Equal(exitCode, result.ExitCode);
        Assert.Contains(message, result.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static void WriteJson(string path, object value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(value, ReleaseManifest.JsonOptions), new UTF8Encoding(false));
    }

    private static string HashFile(string path) => Hash(File.ReadAllBytes(path));
    private static string Hash(string value) => Hash(Encoding.UTF8.GetBytes(value));
    private static string Hash(byte[] value) => "sha256:" + Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private sealed record AdmissionFixture(
        string BundleRoot,
        string PackageRoot,
        string ManifestPath,
        string ReceiptPath,
        string InitialReceiptSha256,
        string PackagePinSha256)
    {
        public string ReleaseVersion => Path.GetFileName(BundleRoot);
        public string ReceiptSha256 { get; set; } = InitialReceiptSha256;
    }

    private sealed class NoopDesktopShortcutManager : IDesktopShortcutManager
    {
        public bool IsSupported => false;
        public void CreateOrUpdate(string shortcutPath, DesktopShortcutInfo shortcut) { }
        public DesktopShortcutInfo? Read(string shortcutPath) => null;
    }
}

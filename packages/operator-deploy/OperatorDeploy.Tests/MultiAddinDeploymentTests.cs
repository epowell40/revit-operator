using System.Text.Json;
using RevitOperator.Deployment;
using Xunit;

namespace OperatorDeploy.Tests;

public sealed class MultiAddinDeploymentTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "OperatorDeployMultiAddinTests", Guid.NewGuid().ToString("N"));
    private readonly TestDesktopShortcutManager _shortcuts = new();
    private Func<IDisposable?> _mutex = () => new Lease();

    [Fact]
    public void Schema_v2_rejects_duplicate_or_unsafe_profile_identity()
    {
        var bundle = CreateBundle("1.0.0", new[] { "2023" });
        var manifest = ReleaseManifest.Load(Path.Combine(bundle, "manifest.json"));
        manifest.RevitAddinProfiles[1].ManifestFileName = manifest.RevitAddinProfiles[0].ManifestFileName;
        Assert.Equal(ExitCodes.ManifestInvalid, Assert.Throws<DeploymentException>(() => manifest.Validate()).ExitCode);

        manifest = ReleaseManifest.Load(Path.Combine(bundle, "manifest.json"));
        manifest.RevitAddinProfiles[1].AddInId = manifest.RevitAddinProfiles[0].AddInId;
        Assert.Equal(ExitCodes.ManifestInvalid, Assert.Throws<DeploymentException>(() => manifest.Validate()).ExitCode);

        manifest = ReleaseManifest.Load(Path.Combine(bundle, "manifest.json"));
        manifest.RevitAddinProfiles[1].AssemblyPath = "../foreign.dll";
        Assert.Equal(ExitCodes.ManifestInvalid, Assert.Throws<DeploymentException>(() => manifest.Validate()).ExitCode);
    }

    [Fact]
    public void Schema_v2_rejects_incomplete_year_sets_unknown_and_duplicate_json_properties()
    {
        var bundle = CreateBundle("1.0.0", new[] { "2023" });
        var path = Path.Combine(bundle, "manifest.json");
        var manifest = ReleaseManifest.Load(path);
        manifest.Components.RemoveAll(component => component.RevitAddinProfileId == "safe-read");
        Assert.Equal(ExitCodes.ManifestInvalid, Assert.Throws<DeploymentException>(() => manifest.Validate()).ExitCode);

        var json = File.ReadAllText(path);
        File.WriteAllText(path, json.Replace("\"sourceRevision\": \"test\"", "\"sourceRevision\": \"test\",\n  \"unexpectedAuthority\": true"));
        Assert.Equal(ExitCodes.ManifestInvalid, Assert.Throws<DeploymentException>(() => ReleaseManifest.Load(path)).ExitCode);

        File.WriteAllText(path, json.Replace("\"releaseVersion\": \"1.0.0\"", "\"releaseVersion\": \"1.0.0\",\n  \"ReleaseVersion\": \"evil\""));
        Assert.Equal(ExitCodes.ManifestInvalid, Assert.Throws<DeploymentException>(() => ReleaseManifest.Load(path)).ExitCode);
    }

    [Fact]
    public void Install_activates_primary_and_safe_read_as_complete_sets_for_all_supported_years()
    {
        var result = Run("update", CreateBundle("1.0.0", Years));
        Assert.True(result.Ok, result.Message);

        var state = State();
        Assert.Equal(2, state.SchemaVersion);
        Assert.Equal(6, state.OwnedAddinManifests.Count);
        foreach (var year in Years)
        {
            AssertManifest(year, "RevitBridge.addin", "B2883307-2852-4740-9833-281048674F77", "RevitBridge.App", "RevitBridge.dll");
            AssertManifest(year, "RevitOperator.SafeReadHost.addin", "AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E", "RevitOperator.SafeReadHost.App", "RevitOperator.SafeReadHost.dll");
        }
        Assert.True(Run("validate").Ok);
    }

    [Fact]
    public void Revit_version_filter_activates_every_profile_for_only_the_requested_year()
    {
        var result = Run("update", CreateBundle("1.0.0", Years), revitVersion: "2024");
        Assert.True(result.Ok, result.Message);
        Assert.Equal(2, State().OwnedAddinManifests.Count);
        Assert.True(File.Exists(AddinPath("2024", "RevitBridge.addin")));
        Assert.True(File.Exists(AddinPath("2024", "RevitOperator.SafeReadHost.addin")));
        Assert.False(File.Exists(AddinPath("2023", "RevitBridge.addin")));
        Assert.False(File.Exists(AddinPath("2025", "RevitOperator.SafeReadHost.addin")));
    }

    [Fact]
    public void Revit_version_update_preserves_other_owned_years_and_switches_the_complete_requested_set()
    {
        Assert.True(Run("update", CreateBundle("1.0.0", Years)).Ok);
        var old2023 = File.ReadAllText(AddinPath("2023", "RevitBridge.addin"));
        var old2025 = File.ReadAllText(AddinPath("2025", "RevitOperator.SafeReadHost.addin"));

        var result = Run("update", CreateBundle("2.0.0", Years), revitVersion: "2024");
        Assert.True(result.Ok, result.Message);
        Assert.Equal(6, State().OwnedAddinManifests.Count);
        Assert.Equal(old2023, File.ReadAllText(AddinPath("2023", "RevitBridge.addin")));
        Assert.Equal(old2025, File.ReadAllText(AddinPath("2025", "RevitOperator.SafeReadHost.addin")));
        Assert.Contains(Path.Combine("2.0.0", "primary-2024"), File.ReadAllText(AddinPath("2024", "RevitBridge.addin")), StringComparison.OrdinalIgnoreCase);
        Assert.Contains(Path.Combine("2.0.0", "safe-read-2024"), File.ReadAllText(AddinPath("2024", "RevitOperator.SafeReadHost.addin")), StringComparison.OrdinalIgnoreCase);
        Assert.True(Run("validate").Ok);
    }

    [Fact]
    public void Revit_version_filter_rejects_an_absent_or_invalid_year_without_writes()
    {
        var bundle = CreateBundle("1.0.0", Years);
        Assert.False(Run("update", bundle, revitVersion: "2026").Ok);
        Assert.False(Run("update", bundle, revitVersion: "24").Ok);
        Assert.False(File.Exists(Context().StatePath));
    }

    [Fact]
    public void Schema_v1_state_migrates_to_v2_ownership_without_displacing_primary()
    {
        Assert.True(Run("update", CreateLegacyBundle("1.0.0", "2024")).Ok);
        var oldState = State();
        oldState.SchemaVersion = 1;
        oldState.OwnedAddinManifests.Clear();
        File.WriteAllText(Context().StatePath, JsonSerializer.Serialize(oldState, ReleaseManifest.JsonOptions));

        var result = Run("update", CreateBundle("2.0.0", new[] { "2024" }));
        Assert.True(result.Ok, result.Message);
        var migrated = State();
        Assert.Equal(2, migrated.SchemaVersion);
        Assert.Equal(2, migrated.OwnedAddinManifests.Count);
        AssertManifest("2024", "RevitBridge.addin", "B2883307-2852-4740-9833-281048674F77", "RevitBridge.App", "RevitBridge.dll");
        AssertManifest("2024", "RevitOperator.SafeReadHost.addin", "AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E", "RevitOperator.SafeReadHost.App", "RevitOperator.SafeReadHost.dll");
    }

    [Fact]
    public void Update_removes_only_exactly_owned_obsolete_manifests_and_validates_absence()
    {
        Assert.True(Run("update", CreateBundle("1.0.0", Years)).Ok);
        var result = Run("update", CreateBundle("2.0.0", Years, primaryOnly: true));
        Assert.True(result.Ok, result.Message);
        Assert.Equal(3, State().OwnedAddinManifests.Count);
        foreach (var year in Years)
        {
            Assert.True(File.Exists(AddinPath(year, "RevitBridge.addin")));
            Assert.False(File.Exists(AddinPath(year, "RevitOperator.SafeReadHost.addin")));
        }
    }

    [Fact]
    public void Modified_owned_obsolete_manifest_blocks_the_whole_activation_without_deletion()
    {
        Assert.True(Run("update", CreateBundle("1.0.0", Years)).Ok);
        var stateBytes = File.ReadAllBytes(Context().StatePath);
        var primaryBytes = Years.ToDictionary(year => year, year => File.ReadAllBytes(AddinPath(year, "RevitBridge.addin")));
        var foreign = AddinPath("2024", "RevitOperator.SafeReadHost.addin");
        File.AppendAllText(foreign, "<!-- foreign modification -->");

        var result = Run("update", CreateBundle("2.0.0", Years, primaryOnly: true));
        Assert.False(result.Ok);
        Assert.Contains("modified", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.True(File.Exists(foreign));
        Assert.Equal(stateBytes, File.ReadAllBytes(Context().StatePath));
        foreach (var year in Years) Assert.Equal(primaryBytes[year], File.ReadAllBytes(AddinPath(year, "RevitBridge.addin")));
    }

    [Fact]
    public void Repair_recreates_a_missing_owned_manifest_but_never_overwrites_a_modified_one()
    {
        var bundle = CreateBundle("1.0.0", new[] { "2023" });
        Assert.True(Run("update", bundle).Ok);
        var safeRead = AddinPath("2023", "RevitOperator.SafeReadHost.addin");
        File.Delete(safeRead);
        Assert.True(Run("repair", bundle).Ok);
        Assert.True(File.Exists(safeRead));

        File.AppendAllText(safeRead, "<!-- modified -->");
        var before = File.ReadAllBytes(safeRead);
        var blocked = Run("repair", bundle);
        Assert.False(blocked.Ok);
        Assert.Equal(before, File.ReadAllBytes(safeRead));
    }

    [Fact]
    public void Unowned_target_manifest_is_never_overwritten()
    {
        var foreign = AddinPath("2023", "RevitOperator.SafeReadHost.addin");
        Directory.CreateDirectory(Path.GetDirectoryName(foreign)!);
        File.WriteAllText(foreign, "<foreign>keep me</foreign>");
        var before = File.ReadAllBytes(foreign);

        var result = Run("update", CreateBundle("1.0.0", new[] { "2023" }));
        Assert.False(result.Ok);
        Assert.Contains("unowned", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(before, File.ReadAllBytes(foreign));
        Assert.False(File.Exists(AddinPath("2023", "RevitBridge.addin")));
        Assert.False(File.Exists(Context().StatePath));
    }

    [Fact]
    public void Activation_failure_restores_all_six_controls_and_commits_no_state()
    {
        Assert.True(Run("update", CreateBundle("1.0.0", Years, includeDesktop: true)).Ok);
        var context = Context();
        var controls = State().OwnedAddinManifests.Select(control => control.ManifestPath)
            .Append(context.StatePath).Append(context.StableDesktopLauncherPath).Append(context.DesktopCommandPath).Append(context.DesktopShortcutPath)
            .ToDictionary(path => path, File.ReadAllBytes, StringComparer.OrdinalIgnoreCase);
        _shortcuts.FailAfterWrite = true;

        var result = Run("update", CreateBundle("2.0.0", Years, includeDesktop: true));
        Assert.False(result.Ok);
        foreach (var pair in controls) Assert.Equal(pair.Value, File.ReadAllBytes(pair.Key));
        Assert.Equal("1.0.0", State().CurrentRelease);
    }

    [Fact]
    public void Rollback_snapshots_union_and_restores_removed_safe_read_set()
    {
        Assert.True(Run("update", CreateBundle("1.0.0", Years)).Ok);
        Assert.True(Run("update", CreateBundle("2.0.0", Years, primaryOnly: true)).Ok);
        foreach (var year in Years) Assert.False(File.Exists(AddinPath(year, "RevitOperator.SafeReadHost.addin")));

        var rollback = Run("rollback");
        Assert.True(rollback.Ok, rollback.Message);
        Assert.Equal("1.0.0", State().CurrentRelease);
        Assert.Equal(6, State().OwnedAddinManifests.Count);
        foreach (var year in Years) Assert.True(File.Exists(AddinPath(year, "RevitOperator.SafeReadHost.addin")));
    }

    [Fact]
    public void Dry_run_and_busy_mutex_leave_every_control_untouched()
    {
        var bundle = CreateBundle("1.0.0", Years);
        var dryRun = Run("update", bundle, dryRun: true);
        Assert.True(dryRun.Ok, dryRun.Message);
        Assert.False(File.Exists(Context().StatePath));
        foreach (var year in Years) Assert.False(File.Exists(AddinPath(year, "RevitBridge.addin")));

        var foreign = AddinPath("2025", "RevitOperator.SafeReadHost.addin");
        Directory.CreateDirectory(Path.GetDirectoryName(foreign)!);
        File.WriteAllText(foreign, "foreign");
        var blockedPlan = Run("update", bundle, dryRun: true);
        Assert.False(blockedPlan.Ok);
        Assert.Equal("foreign", File.ReadAllText(foreign));

        _mutex = () => null;
        var busy = Run("update", bundle);
        Assert.False(busy.Ok);
        Assert.Contains("already in progress", busy.Message);
        Assert.False(File.Exists(Context().StatePath));
    }

    [Fact]
    public void Foreign_duplicate_identity_is_reported_but_never_deleted()
    {
        Assert.True(Run("update", CreateBundle("1.0.0", new[] { "2025" })).Ok);
        var foreign = Path.Combine(Context().CommonAppData, "Autodesk", "Revit", "Addins", "2025", "Foreign.addin");
        Directory.CreateDirectory(Path.GetDirectoryName(foreign)!);
        File.WriteAllText(foreign, "<RevitAddIns><AddIn><AddInId>AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E</AddInId></AddIn></RevitAddIns>");
        var before = File.ReadAllBytes(foreign);

        var validation = Run("validate");
        Assert.False(validation.Ok);
        Assert.Contains("Conflicting", validation.Message);
        Assert.Equal(before, File.ReadAllBytes(foreign));
    }

    private static readonly string[] Years = { "2023", "2024", "2025" };

    private OperationResult Run(string operation, string? bundle = null, string? revitVersion = null, bool dryRun = false)
        => new DeploymentEngine(Context(), new DeploymentOptions
        {
            Operation = operation,
            ManifestPath = bundle == null ? null : Path.Combine(bundle, "manifest.json"),
            RevitVersion = revitVersion,
            DryRun = dryRun,
            Quiet = true
        }, TextWriter.Null).Execute();

    private DeploymentContext Context() => new()
    {
        LocalAppData = Path.Combine(_root, "local"),
        AppData = Path.Combine(_root, "roaming"),
        Desktop = Path.Combine(_root, "desktop"),
        ProgramFiles = Path.Combine(_root, "program-files"),
        CommonAppData = Path.Combine(_root, "program-data"),
        WindowsVersion = new Version(10, 0, 19045),
        IsRevitRunning = () => false,
        UtcNow = () => new DateTimeOffset(2026, 7, 29, 12, 0, 0, TimeSpan.Zero),
        GetEnvironmentVariable = _ => null,
        DesktopShortcuts = _shortcuts,
        TryAcquireDeploymentMutex = () => _mutex()
    };

    private string AddinPath(string year, string fileName)
        => Path.Combine(Context().AppData, "Autodesk", "Revit", "Addins", year, fileName);

    private InstalledState State() => JsonSerializer.Deserialize<InstalledState>(File.ReadAllText(Context().StatePath), ReleaseManifest.JsonOptions)!;

    private void AssertManifest(string year, string fileName, string addInId, string fullClassName, string assemblyName)
    {
        var text = File.ReadAllText(AddinPath(year, fileName));
        Assert.Contains(addInId, text, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(fullClassName, text, StringComparison.Ordinal);
        Assert.Contains(assemblyName, text, StringComparison.OrdinalIgnoreCase);
    }

    private string CreateBundle(string version, IEnumerable<string> years, bool primaryOnly = false, bool includeDesktop = false)
    {
        var bundle = Path.Combine(_root, "bundles", $"v2-{version}-{string.Join('-', years)}-{primaryOnly}-{includeDesktop}");
        Directory.CreateDirectory(bundle);
        var manifest = new ReleaseManifest
        {
            SchemaVersion = 2,
            ReleaseVersion = version,
            GeneratedAtUtc = "2026-07-29T12:00:00Z",
            SourceRevision = "test"
        };
        manifest.RevitAddinProfiles.Add(PrimaryProfile());
        if (!primaryOnly) manifest.RevitAddinProfiles.Add(SafeReadProfile());
        foreach (var year in years)
        {
            manifest.Components.Add(AddinComponent(bundle, version, year, PrimaryProfile()));
            if (!primaryOnly) manifest.Components.Add(AddinComponent(bundle, version, year, SafeReadProfile()));
        }
        if (includeDesktop) manifest.Components.Add(DesktopComponent(bundle, version));
        manifest.Validate();
        File.WriteAllText(Path.Combine(bundle, "manifest.json"), JsonSerializer.Serialize(manifest, ReleaseManifest.JsonOptions));
        return bundle;
    }

    private string CreateLegacyBundle(string version, string year)
    {
        var bundle = Path.Combine(_root, "bundles", $"v1-{version}-{year}");
        var payload = Path.Combine(bundle, "revit");
        Directory.CreateDirectory(payload);
        File.WriteAllText(Path.Combine(payload, "RevitBridge.dll"), $"legacy-{version}-{year}");
        var manifest = new ReleaseManifest
        {
            SchemaVersion = 1,
            ReleaseVersion = version,
            GeneratedAtUtc = "2026-07-29T12:00:00Z",
            SourceRevision = "test",
            Components = { Component($"revit-operator-{year}", "revit-addin", "revit", payload, year) }
        };
        File.WriteAllText(Path.Combine(bundle, "manifest.json"), JsonSerializer.Serialize(manifest, ReleaseManifest.JsonOptions));
        return bundle;
    }

    private static RevitAddinProfile PrimaryProfile() => new()
    {
        Id = "primary",
        ManifestFileName = "RevitBridge.addin",
        AssemblyPath = "RevitBridge.dll",
        Name = "RevitOperator",
        FullClassName = "RevitBridge.App",
        AddInId = "B2883307-2852-4740-9833-281048674F77",
        VendorId = "com.revitoperator",
        VendorDescription = "Revit Operator"
    };

    private static RevitAddinProfile SafeReadProfile() => new()
    {
        Id = "safe-read",
        ManifestFileName = "RevitOperator.SafeReadHost.addin",
        AssemblyPath = "RevitOperator.SafeReadHost.dll",
        Name = "Revit Operator Safe Read Host",
        FullClassName = "RevitOperator.SafeReadHost.App",
        AddInId = "AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E",
        VendorId = "BIMT",
        VendorDescription = "BIMTools Revit Operator Safe Read Host"
    };

    private static ReleaseComponent AddinComponent(string bundle, string version, string year, RevitAddinProfile profile)
    {
        var relative = $"revit-{year}-{profile.Id}";
        var payload = Path.Combine(bundle, relative);
        Directory.CreateDirectory(payload);
        File.WriteAllText(Path.Combine(payload, profile.AssemblyPath), $"{profile.Id}-{version}-{year}");
        return Component($"{profile.Id}-{year}", "revit-addin", relative, payload, year, profile.Id);
    }

    private static ReleaseComponent DesktopComponent(string bundle, string version)
    {
        var payload = Path.Combine(bundle, "desktop");
        Directory.CreateDirectory(Path.Combine(payload, "scripts"));
        Directory.CreateDirectory(Path.Combine(payload, "runtime"));
        File.WriteAllText(Path.Combine(payload, "server.js"), version);
        File.WriteAllText(Path.Combine(payload, "scripts", "launch_operator_desktop.ps1"), "Write-Host start");
        File.WriteAllText(Path.Combine(payload, "runtime", "node.exe"), "node");
        return Component("operator-desktop", "operator-desktop", "desktop", payload);
    }

    private static ReleaseComponent Component(string id, string kind, string payloadPath, string payloadRoot, string? year = null, string? profileId = null)
        => new()
        {
            Id = id,
            Kind = kind,
            Version = "test",
            Required = true,
            PayloadPath = payloadPath,
            RevitYear = year,
            RevitAddinProfileId = profileId,
            Files = Directory.GetFiles(payloadRoot, "*", SearchOption.AllDirectories).Select(path => new ReleaseFile
            {
                Path = Path.GetRelativePath(payloadRoot, path).Replace('\\', '/'),
                Size = new FileInfo(path).Length,
                Sha256 = FileIntegrity.Sha256(path)
            }).ToList()
        };

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private sealed class Lease : IDisposable { public void Dispose() { } }

    private sealed class TestDesktopShortcutManager : IDesktopShortcutManager
    {
        public bool IsSupported => true;
        public bool FailAfterWrite { get; set; }
        public void CreateOrUpdate(string shortcutPath, DesktopShortcutInfo shortcut)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath)!);
            File.WriteAllText(shortcutPath, JsonSerializer.Serialize(shortcut));
            if (!FailAfterWrite) return;
            FailAfterWrite = false;
            throw new IOException("Injected shortcut failure.");
        }
        public DesktopShortcutInfo? Read(string shortcutPath)
            => File.Exists(shortcutPath) ? JsonSerializer.Deserialize<DesktopShortcutInfo>(File.ReadAllText(shortcutPath)) : null;
    }
}

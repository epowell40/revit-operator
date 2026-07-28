using System.IO.Compression;
using System.Text.Json;
using RevitOperator.Deployment;
using Xunit;

namespace OperatorDeploy.Tests;

public sealed class DeploymentEngineTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "operator-deploy-tests", Guid.NewGuid().ToString("N"));
    private readonly TestDesktopShortcutManager _shortcuts = new();
    private string? _launcherOverride;

    [Fact]
    public void Manifest_rejects_unknown_schema()
    {
        var bundle = CreateBundle("1.0.0");
        var manifest = ReleaseManifest.Load(Path.Combine(bundle, "manifest.json"));
        manifest.SchemaVersion = 99;
        var ex = Assert.Throws<DeploymentException>(() => manifest.Validate());
        Assert.Equal(ExitCodes.ManifestInvalid, ex.ExitCode);
    }

    [Fact]
    public void Manifest_rejects_path_traversal()
    {
        var manifest = new ReleaseManifest
        {
            SchemaVersion = 1,
            ReleaseVersion = "1.0.0",
            Components = { new ReleaseComponent { Id = "bad", Kind = "config-default", Required = true, PayloadPath = "../escape", Files = { new ReleaseFile { Path = "x", Size = 1, Sha256 = new string('A', 64) } } } }
        };
        Assert.Throws<DeploymentException>(() => manifest.Validate());
    }

    [Fact]
    public void Bundle_validation_fails_closed_on_hash_mismatch()
    {
        var bundle = CreateBundle("1.0.0");
        File.AppendAllText(Path.Combine(bundle, "revit", "RevitBridge.dll"), "tampered");
        var result = Run("validate", bundle, bundleOnly: true);
        Assert.False(result.Ok);
        Assert.Equal(ExitCodes.HashMismatch, result.ExitCode);
    }

    [Fact]
    public void Bundle_validation_does_not_create_installed_state()
    {
        var bundle = CreateBundle("1.0.0");
        var result = Run("validate", bundle, bundleOnly: true);
        Assert.True(result.Ok, result.Message);
        Assert.False(File.Exists(Context().StatePath));
    }

    [Fact]
    public void Install_and_validate_use_versioned_release_and_addin_pointer()
    {
        var bundle = CreateBundle("1.0.0");
        var install = Run("update", bundle);
        Assert.True(install.Ok, install.Message);

        var context = Context();
        Assert.True(File.Exists(Path.Combine(context.ReleasesRoot, "1.0.0", "revit-operator-2023", "RevitBridge.dll")));
        var addin = File.ReadAllText(Path.Combine(context.AppData, "Autodesk", "Revit", "Addins", "2023", "RevitBridge.addin"));
        Assert.Contains(Path.Combine(context.ReleasesRoot, "1.0.0"), addin, StringComparison.OrdinalIgnoreCase);
        Assert.True(Run("validate").Ok);
    }

    [Fact]
    public void Install_manages_both_command_wrappers_and_stable_desktop_shortcut()
    {
        var bundle = CreateBundle("1.0.0");
        var context = Context();

        var install = new DeploymentEngine(context, Options("update", bundle), TextWriter.Null).Execute();

        Assert.True(install.Ok, install.Message);
        AssertManagedDesktopControls(context, "1.0.0");
        var shortcut = _shortcuts.Read(context.DesktopShortcutPath)!;
        Assert.DoesNotContain("releases", shortcut.TargetPath, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("scripts", shortcut.TargetPath, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(bundle, shortcut.TargetPath, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Update_refreshes_wrappers_without_changing_stable_shortcut_target()
    {
        var context = Context();
        Assert.True(new DeploymentEngine(context, Options("update", CreateBundle("1.0.0")), TextWriter.Null).Execute().Ok);
        var originalTarget = _shortcuts.Read(context.DesktopShortcutPath)!.TargetPath;

        var update = new DeploymentEngine(context, Options("update", CreateBundle("2.0.0")), TextWriter.Null).Execute();

        Assert.True(update.Ok, update.Message);
        AssertManagedDesktopControls(context, "2.0.0");
        Assert.Equal(originalTarget, _shortcuts.Read(context.DesktopShortcutPath)!.TargetPath);
    }

    [Fact]
    public void Same_release_year_specific_update_merges_components_without_removing_prior_year()
    {
        var release2023 = CreateBundle("1.0.0", "2023");
        Assert.True(Run("update", release2023, revitVersion: "2023").Ok);

        var release2024 = CreateBundle("1.0.0", "2024");
        var update = Run("update", release2024, revitVersion: "2024");
        Assert.True(update.Ok, update.Message);

        var context = Context();
        var releaseRoot = Path.Combine(context.ReleasesRoot, "1.0.0");
        Assert.True(File.Exists(Path.Combine(releaseRoot, "revit-operator-2023", "RevitBridge.dll")));
        Assert.True(File.Exists(Path.Combine(releaseRoot, "revit-operator-2024", "RevitBridge.dll")));

        var manifest = ReleaseManifest.Load(Path.Combine(releaseRoot, "manifest.json"));
        Assert.Contains(manifest.Components, component => component.Id == "revit-operator-2023");
        Assert.Contains(manifest.Components, component => component.Id == "revit-operator-2024");

        var addin2023 = File.ReadAllText(Path.Combine(context.AppData, "Autodesk", "Revit", "Addins", "2023", "RevitBridge.addin"));
        var addin2024 = File.ReadAllText(Path.Combine(context.AppData, "Autodesk", "Revit", "Addins", "2024", "RevitBridge.addin"));
        Assert.Contains(releaseRoot, addin2023, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(releaseRoot, addin2024, StringComparison.OrdinalIgnoreCase);
        Assert.True(Run("validate").Ok);
    }

    [Fact]
    public void Update_preserves_existing_machine_configuration()
    {
        var context = Context();
        Directory.CreateDirectory(context.ConfigRoot);
        var configPath = Path.Combine(context.ConfigRoot, "operator-client.json");
        File.WriteAllText(configPath, "{\"backend_url\":\"https://custom.example/\"}");
        Assert.True(Run("update", CreateBundle("1.0.0")).Ok);
        Assert.Contains("custom.example", File.ReadAllText(configPath));
    }

    [Fact]
    public void Running_revit_blocks_update_before_any_state_change()
    {
        var result = Run("update", CreateBundle("1.0.0"), revitRunning: true);
        Assert.False(result.Ok);
        Assert.Equal(ExitCodes.BlockedProcess, result.ExitCode);
        Assert.False(File.Exists(Context().StatePath));
    }

    [Fact]
    public void Unsupported_windows_version_is_rejected()
    {
        var bundle = CreateBundle("1.0.0");
        var context = Context(windowsVersion: new Version(6, 3, 9600));
        var result = new DeploymentEngine(context, Options("update", bundle), TextWriter.Null).Execute();
        Assert.False(result.Ok);
        Assert.Equal(ExitCodes.Unsupported, result.ExitCode);
    }

    [Fact]
    public void Failed_new_release_does_not_replace_current_state()
    {
        Assert.True(Run("update", CreateBundle("1.0.0")).Ok);
        var bad = CreateBundle("2.0.0");
        File.AppendAllText(Path.Combine(bad, "desktop", "server.js"), "bad");
        var update = Run("update", bad);
        Assert.False(update.Ok);
        var state = JsonSerializer.Deserialize<InstalledState>(File.ReadAllText(Context().StatePath), ReleaseManifest.JsonOptions)!;
        Assert.Equal("1.0.0", state.CurrentRelease);
    }

    [Fact]
    public void Failed_shortcut_activation_restores_all_control_files()
    {
        var context = Context();
        Assert.True(new DeploymentEngine(context, Options("update", CreateBundle("1.0.0")), TextWriter.Null).Execute().Ok);
        var paths = new[] { context.StableDesktopLauncherPath, context.DesktopCommandPath, context.DesktopShortcutPath, context.StatePath };
        var before = paths.ToDictionary(path => path, File.ReadAllBytes);
        _shortcuts.FailAfterWrite = true;

        var update = new DeploymentEngine(context, Options("update", CreateBundle("2.0.0")), TextWriter.Null).Execute();

        Assert.False(update.Ok);
        foreach (var path in paths) Assert.Equal(before[path], File.ReadAllBytes(path));
        var state = JsonSerializer.Deserialize<InstalledState>(File.ReadAllText(context.StatePath), ReleaseManifest.JsonOptions)!;
        Assert.Equal("1.0.0", state.CurrentRelease);
    }

    [Fact]
    public void Restore_is_best_effort_and_preserves_original_activation_failure()
    {
        var context = Context();
        Assert.True(new DeploymentEngine(context, Options("update", CreateBundle("1.0.0")), TextWriter.Null).Execute().Ok);
        var desktopCommandBefore = File.ReadAllBytes(context.DesktopCommandPath);
        var shortcutBefore = File.ReadAllBytes(context.DesktopShortcutPath);
        var stateBefore = File.ReadAllBytes(context.StatePath);
        _shortcuts.BeforeInjectedFailure = () =>
        {
            File.Delete(context.StableDesktopLauncherPath);
            Directory.CreateDirectory(context.StableDesktopLauncherPath);
        };
        _shortcuts.FailAfterWrite = true;

        var update = new DeploymentEngine(context, Options("update", CreateBundle("2.0.0")), TextWriter.Null).Execute();

        Assert.False(update.Ok);
        Assert.Equal(ExitCodes.InstallFailed, update.ExitCode);
        Assert.Contains("Injected shortcut activation failure", update.Message);
        Assert.Contains("Recovery also reported 1 failure", update.Message);
        Assert.Equal(desktopCommandBefore, File.ReadAllBytes(context.DesktopCommandPath));
        Assert.Equal(shortcutBefore, File.ReadAllBytes(context.DesktopShortcutPath));
        Assert.Equal(stateBefore, File.ReadAllBytes(context.StatePath));
        Assert.Empty(Directory.GetFiles(context.ProductRoot, "*.tmp-*", SearchOption.TopDirectoryOnly));
    }

    [Fact]
    public void Rollback_reactivates_previous_successful_release()
    {
        Assert.True(Run("update", CreateBundle("1.0.0")).Ok);
        Assert.True(Run("update", CreateBundle("2.0.0")).Ok);
        var rollback = Run("rollback");
        Assert.True(rollback.Ok, rollback.Message);
        Assert.Equal("1.0.0", rollback.ReleaseVersion);
        var addin = File.ReadAllText(Path.Combine(Context().AppData, "Autodesk", "Revit", "Addins", "2023", "RevitBridge.addin"));
        Assert.Contains("1.0.0", addin);
        AssertManagedDesktopControls(Context(), "1.0.0");
    }

    [Fact]
    public void Failed_shortcut_activation_during_rollback_restores_current_controls()
    {
        var context = Context();
        Assert.True(new DeploymentEngine(context, Options("update", CreateBundle("1.0.0")), TextWriter.Null).Execute().Ok);
        Assert.True(new DeploymentEngine(context, Options("update", CreateBundle("2.0.0")), TextWriter.Null).Execute().Ok);
        var paths = new[] { context.StableDesktopLauncherPath, context.DesktopCommandPath, context.DesktopShortcutPath, context.StatePath };
        var before = paths.ToDictionary(path => path, File.ReadAllBytes);
        _shortcuts.FailAfterWrite = true;

        var rollback = new DeploymentEngine(context, Options("rollback", null), TextWriter.Null).Execute();

        Assert.False(rollback.Ok);
        foreach (var path in paths) Assert.Equal(before[path], File.ReadAllBytes(path));
        AssertManagedDesktopControls(context, "2.0.0");
    }

    [Fact]
    public void Fast_update_rejects_nonthrowing_bad_shortcut_before_state_commit()
    {
        var context = Context();
        var bundle = CreateBundle("1.0.0");
        Assert.True(new DeploymentEngine(context, Options("update", bundle), TextWriter.Null).Execute().Ok);
        var staleTarget = Path.Combine(_root, "stale source", "launcher.cmd");
        _shortcuts.CreateOrUpdate(context.DesktopShortcutPath, new DesktopShortcutInfo(staleTarget, "", context.ProductRoot));
        _shortcuts.IgnoreWrites = true;
        var stateBefore = File.ReadAllBytes(context.StatePath);

        var refresh = new DeploymentEngine(context, Options("update", bundle), TextWriter.Null).Execute();

        Assert.False(refresh.Ok);
        Assert.Equal(ExitCodes.ValidationFailed, refresh.ExitCode);
        Assert.Equal(stateBefore, File.ReadAllBytes(context.StatePath));
        Assert.Equal(staleTarget, _shortcuts.Read(context.DesktopShortcutPath)!.TargetPath);
    }

    [Fact]
    public void Rollback_rejects_nonthrowing_bad_shortcut_before_state_commit()
    {
        var context = Context();
        Assert.True(new DeploymentEngine(context, Options("update", CreateBundle("1.0.0")), TextWriter.Null).Execute().Ok);
        Assert.True(new DeploymentEngine(context, Options("update", CreateBundle("2.0.0")), TextWriter.Null).Execute().Ok);
        var staleTarget = Path.Combine(_root, "stale source", "launcher.cmd");
        _shortcuts.CreateOrUpdate(context.DesktopShortcutPath, new DesktopShortcutInfo(staleTarget, "", context.ProductRoot));
        _shortcuts.IgnoreWrites = true;
        var stateBefore = File.ReadAllBytes(context.StatePath);

        var rollback = new DeploymentEngine(context, Options("rollback", null), TextWriter.Null).Execute();

        Assert.False(rollback.Ok);
        Assert.Equal(ExitCodes.ValidationFailed, rollback.ExitCode);
        Assert.Equal(stateBefore, File.ReadAllBytes(context.StatePath));
        Assert.Contains("2.0.0", File.ReadAllText(context.StableDesktopLauncherPath));
        Assert.Equal(staleTarget, _shortcuts.Read(context.DesktopShortcutPath)!.TargetPath);
    }

    [Fact]
    public void Rollback_conflicting_override_blocks_dry_run_and_real_before_control_changes()
    {
        AssertRollbackOverridePreflight(Path.Combine(_root, "source checkout", "Operator Desktop.cmd"), "conflict");
    }

    [Fact]
    public void Rollback_invalid_override_blocks_dry_run_and_real_before_control_changes()
    {
        AssertRollbackOverridePreflight("invalid\0launcher", "invalid");
    }

    [Fact]
    public void Managed_shortcut_supports_profile_paths_with_spaces()
    {
        var context = Context(profileRoot: Path.Combine(_root, "profile with spaces"));

        var install = new DeploymentEngine(context, Options("update", CreateBundle("1.0.0")), TextWriter.Null).Execute();

        Assert.True(install.Ok, install.Message);
        AssertManagedDesktopControls(context, "1.0.0");
        Assert.Contains("profile with spaces", _shortcuts.Read(context.DesktopShortcutPath)!.TargetPath);
    }

    [Fact]
    public void Windows_shortcut_manager_creates_replaces_reads_paths_with_spaces_without_temp_files()
    {
        if (!OperatingSystem.IsWindows()) return;
        var manager = DesktopShortcutManager.CreateDefault();
        Assert.True(manager.IsSupported);
        var root = Path.Combine(_root, "real shortcut contract with spaces");
        var shortcutPath = Path.Combine(root, "Operator Desktop.lnk");
        var firstTarget = Path.Combine(root, "first target.cmd");
        var secondTarget = Path.Combine(root, "second target.cmd");
        Directory.CreateDirectory(root);
        File.WriteAllText(firstTarget, "@echo off");
        File.WriteAllText(secondTarget, "@echo off");

        manager.CreateOrUpdate(shortcutPath, new DesktopShortcutInfo(firstTarget, "", root));
        Assert.Equal(Path.GetFullPath(firstTarget), Path.GetFullPath(manager.Read(shortcutPath)!.TargetPath), ignoreCase: true);

        manager.CreateOrUpdate(shortcutPath, new DesktopShortcutInfo(secondTarget, "--path-with-spaces", root));
        var replaced = manager.Read(shortcutPath)!;
        Assert.Equal(Path.GetFullPath(secondTarget), Path.GetFullPath(replaced.TargetPath), ignoreCase: true);
        Assert.Equal("--path-with-spaces", replaced.Arguments);
        Assert.Equal(Path.GetFullPath(root), Path.GetFullPath(replaced.WorkingDirectory), ignoreCase: true);
        Assert.Empty(Directory.GetFiles(root, "*.tmp-*.lnk", SearchOption.TopDirectoryOnly));
    }

    [Fact]
    public void Update_replaces_existing_stale_shortcut_target()
    {
        var context = Context();
        Directory.CreateDirectory(context.Desktop);
        _shortcuts.CreateOrUpdate(
            context.DesktopShortcutPath,
            new DesktopShortcutInfo(Path.Combine(_root, "source checkout", "operator-desktop", "scripts", "launch.cmd"), "--stale", _root));

        var install = new DeploymentEngine(context, Options("update", CreateBundle("1.0.0")), TextWriter.Null).Execute();

        Assert.True(install.Ok, install.Message);
        AssertManagedDesktopControls(context, "1.0.0");
    }

    [Fact]
    public void Validation_rejects_stale_shortcut_target()
    {
        var context = Context();
        Assert.True(new DeploymentEngine(context, Options("update", CreateBundle("1.0.0")), TextWriter.Null).Execute().Ok);
        _shortcuts.CreateOrUpdate(
            context.DesktopShortcutPath,
            new DesktopShortcutInfo(Path.Combine(_root, "old release", "launch.cmd"), "", context.ProductRoot));

        var validation = new DeploymentEngine(context, Options("validate", null), TextWriter.Null).Execute();

        Assert.False(validation.Ok);
        Assert.Equal(ExitCodes.ValidationFailed, validation.ExitCode);
        Assert.Contains("shortcut target is stale or unmanaged", validation.Message);
    }

    [Fact]
    public void Validation_rejects_conflicting_launcher_override()
    {
        Assert.True(Run("update", CreateBundle("1.0.0")).Ok);
        _launcherOverride = Path.Combine(_root, "source checkout", "Operator Desktop.cmd");

        var validation = Run("validate");

        Assert.False(validation.Ok);
        Assert.Equal(ExitCodes.ValidationFailed, validation.ExitCode);
        Assert.Contains("OPERATOR_DESKTOP_LAUNCHER_PATH is conflict", validation.Message);
        Assert.Contains("OperatorDeploy did not change the environment", validation.Message);
    }

    [Fact]
    public void Update_rejects_conflicting_launcher_override_before_control_changes()
    {
        var context = Context();
        _launcherOverride = Path.Combine(_root, "source checkout", "Operator Desktop.cmd");

        var update = new DeploymentEngine(context, Options("update", CreateBundle("1.0.0")), TextWriter.Null).Execute();

        Assert.False(update.Ok);
        Assert.Equal(ExitCodes.ValidationFailed, update.ExitCode);
        Assert.Contains("Point it to %LOCALAPPDATA%", update.Message);
        Assert.False(File.Exists(context.StatePath));
        Assert.False(File.Exists(context.StableDesktopLauncherPath));
        Assert.False(File.Exists(context.DesktopCommandPath));
        Assert.False(File.Exists(context.DesktopShortcutPath));
    }

    [Fact]
    public void Diagnostics_redact_token_values()
    {
        Assert.True(Run("update", CreateBundle("1.0.0")).Ok);
        var context = Context();
        var config = Path.Combine(context.ConfigRoot, "operator-client.json");
        File.WriteAllText(config, "{\"backend_url\":\"https://example/\",\"operator_token\":\"do-not-leak\"}");
        var staleTarget = Path.Combine(_root, "stale", "private-launcher.cmd");
        const string privateArguments = "--private-launcher-arguments";
        _shortcuts.CreateOrUpdate(context.DesktopShortcutPath, new DesktopShortcutInfo(staleTarget, privateArguments, _root));
        Assert.False(Run("validate").Ok);
        var overrideValue = Path.Combine(_root, "source", "private-override.cmd");
        _launcherOverride = overrideValue;
        var result = Run("diagnostics");
        Assert.False(result.Ok);
        Assert.Equal(ExitCodes.ValidationFailed, result.ExitCode);
        Assert.Contains("OperatorDeploy did not change the environment", result.Message);
        using var zip = ZipFile.OpenRead(result.Details.Single());
        var entry = zip.GetEntry("config/operator-client.sanitized.json")!;
        using var reader = new StreamReader(entry.Open());
        var text = reader.ReadToEnd();
        Assert.DoesNotContain("do-not-leak", text);
        Assert.Contains("[REDACTED]", text);

        using var diagnosticsReader = new StreamReader(zip.GetEntry("system.txt")!.Open());
        var diagnostics = diagnosticsReader.ReadToEnd();
        Assert.Contains("OperatorDesktopShortcut=stale", diagnostics);
        Assert.Contains("Arguments=present", diagnostics);
        Assert.Contains("OperatorDesktopLauncherOverride=conflict", diagnostics);
        Assert.DoesNotContain(staleTarget, diagnostics);
        Assert.DoesNotContain(privateArguments, diagnostics);
        Assert.DoesNotContain(overrideValue, diagnostics);

        foreach (var diagnosticEntry in zip.Entries.Where(entry => entry.FullName.EndsWith(".txt") || entry.FullName.EndsWith(".log") || entry.FullName.EndsWith(".json")))
        {
            using var diagnosticEntryReader = new StreamReader(diagnosticEntry.Open());
            var archivedText = diagnosticEntryReader.ReadToEnd();
            Assert.DoesNotContain(staleTarget, archivedText);
            Assert.DoesNotContain(privateArguments, archivedText);
            Assert.DoesNotContain(overrideValue, archivedText);
        }
    }

    [Fact]
    public void Validation_fails_when_duplicate_addin_id_is_registered()
    {
        Assert.True(Run("update", CreateBundle("1.0.0")).Ok);
        var conflict = Path.Combine(Context().AppData, "Autodesk", "Revit", "Addins", "2023", "Duplicate.addin");
        File.WriteAllText(conflict, "<AddInId>B2883307-2852-4740-9833-281048674F77</AddInId>");
        var result = Run("validate");
        Assert.False(result.Ok);
        Assert.Contains("Conflicting", result.Message);
    }

    [Fact]
    public void Machine_scope_fails_with_actionable_error()
    {
        var bundle = CreateBundle("1.0.0");
        var options = new DeploymentOptions
        {
            Operation = "update",
            ManifestPath = Path.Combine(bundle, "manifest.json"),
            InstallScope = "machine",
            Quiet = true
        };
        var result = new DeploymentEngine(Context(), options, TextWriter.Null).Execute();
        Assert.Equal(ExitCodes.Unsupported, result.ExitCode);
    }

    private OperationResult Run(string operation, string? bundle = null, bool bundleOnly = false, bool revitRunning = false, string? revitVersion = null)
    {
        var options = Options(operation, bundle, bundleOnly, revitVersion);
        var context = Context(revitRunning);
        return new DeploymentEngine(context, options, TextWriter.Null).Execute();
    }

    private DeploymentOptions Options(string operation, string? bundle, bool bundleOnly = false, string? revitVersion = null, bool dryRun = false)
        => new()
        {
            Operation = operation,
            ManifestPath = bundle == null ? null : Path.Combine(bundle, "manifest.json"),
            BundleOnly = bundleOnly,
            RevitVersion = revitVersion,
            DryRun = dryRun,
            Quiet = true
        };

    private DeploymentContext Context(bool revitRunning = false, Version? windowsVersion = null, string? profileRoot = null)
    {
        var root = profileRoot ?? _root;
        return new()
        {
            LocalAppData = Path.Combine(root, "local"),
            AppData = Path.Combine(root, "roaming"),
            Desktop = Path.Combine(root, "desktop"),
            ProgramFiles = Path.Combine(root, "program-files"),
            CommonAppData = Path.Combine(root, "program-data"),
            WindowsVersion = windowsVersion ?? new Version(10, 0, 19045),
            IsRevitRunning = () => revitRunning,
            UtcNow = () => new DateTimeOffset(2026, 7, 23, 12, 0, 0, TimeSpan.Zero),
            GetEnvironmentVariable = name => name == "OPERATOR_DESKTOP_LAUNCHER_PATH" ? _launcherOverride : null,
            DesktopShortcuts = _shortcuts
        };
    }

    private void AssertManagedDesktopControls(DeploymentContext context, string releaseVersion)
    {
        var expectedScript = Path.Combine(context.ReleasesRoot, releaseVersion, "operator-desktop", "scripts", "launch_operator_desktop.ps1");
        Assert.Contains(expectedScript, File.ReadAllText(context.StableDesktopLauncherPath));
        Assert.Contains(expectedScript, File.ReadAllText(context.DesktopCommandPath));
        var shortcut = _shortcuts.Read(context.DesktopShortcutPath);
        Assert.NotNull(shortcut);
        Assert.Equal(Path.GetFullPath(context.StableDesktopLauncherPath), Path.GetFullPath(shortcut.TargetPath), ignoreCase: true);
        Assert.Equal("", shortcut.Arguments);
        Assert.Equal(Path.GetFullPath(context.ProductRoot), Path.GetFullPath(shortcut.WorkingDirectory), ignoreCase: true);
    }

    private void AssertRollbackOverridePreflight(string overrideValue, string expectedStatus)
    {
        var context = Context();
        Assert.True(new DeploymentEngine(context, Options("update", CreateBundle("1.0.0")), TextWriter.Null).Execute().Ok);
        Assert.True(new DeploymentEngine(context, Options("update", CreateBundle("2.0.0")), TextWriter.Null).Execute().Ok);
        var addinManifest = Path.Combine(context.AppData, "Autodesk", "Revit", "Addins", "2023", "RevitBridge.addin");
        var controlPaths = new[]
        {
            addinManifest,
            context.StableDesktopLauncherPath,
            context.DesktopCommandPath,
            context.DesktopShortcutPath,
            context.StatePath
        };
        var before = controlPaths.ToDictionary(path => path, File.ReadAllBytes);
        _launcherOverride = overrideValue;

        var dryRun = new DeploymentEngine(context, Options("rollback", null, dryRun: true), TextWriter.Null).Execute();
        var rollback = new DeploymentEngine(context, Options("rollback", null), TextWriter.Null).Execute();

        Assert.False(dryRun.Ok);
        Assert.False(rollback.Ok);
        Assert.Equal(ExitCodes.ValidationFailed, dryRun.ExitCode);
        Assert.Equal(dryRun.ExitCode, rollback.ExitCode);
        Assert.Equal(dryRun.Message, rollback.Message);
        Assert.Contains($"OPERATOR_DESKTOP_LAUNCHER_PATH is {expectedStatus}", rollback.Message);
        Assert.Contains("OperatorDeploy did not change the environment", rollback.Message);
        foreach (var path in controlPaths) Assert.Equal(before[path], File.ReadAllBytes(path));
    }

    private string CreateBundle(string version, string revitYear = "2023")
    {
        var bundle = Path.Combine(_root, "bundles", $"{version}-{revitYear}");
        var revit = Path.Combine(bundle, "revit");
        var desktop = Path.Combine(bundle, "desktop");
        var config = Path.Combine(bundle, "config");
        Directory.CreateDirectory(revit);
        Directory.CreateDirectory(Path.Combine(desktop, "scripts"));
        Directory.CreateDirectory(Path.Combine(desktop, "runtime"));
        Directory.CreateDirectory(config);
        File.WriteAllText(Path.Combine(revit, "RevitBridge.dll"), $"bridge-{version}-{revitYear}");
        File.WriteAllText(Path.Combine(desktop, "server.js"), $"server-{version}");
        File.WriteAllText(Path.Combine(desktop, "scripts", "launch_operator_desktop.ps1"), "Write-Host start");
        File.WriteAllText(Path.Combine(desktop, "runtime", "node.exe"), "node");
        File.WriteAllText(Path.Combine(config, "operator-client.json"), "{\"backend_url\":\"https://operator.example/\"}");

        var manifest = new ReleaseManifest
        {
            SchemaVersion = 1,
            ReleaseVersion = version,
            GeneratedAtUtc = "2026-07-23T12:00:00Z",
            SourceRevision = "test",
            BackendUrl = "",
            Components =
            {
                Component($"revit-operator-{revitYear}", "revit-addin", "revit", revit, required: true, revitYear: revitYear),
                Component("operator-desktop", "operator-desktop", "desktop", desktop, required: true),
                Component("client-config-default", "config-default", "config", config, required: false, preserveExisting: true)
            }
        };
        File.WriteAllText(Path.Combine(bundle, "manifest.json"), JsonSerializer.Serialize(manifest, ReleaseManifest.JsonOptions));
        return bundle;
    }

    private static ReleaseComponent Component(string id, string kind, string payload, string root, bool required, string? revitYear = null, bool preserveExisting = false)
        => new()
        {
            Id = id,
            Kind = kind,
            Version = "test",
            Required = required,
            PayloadPath = payload,
            RevitYear = revitYear,
            PreserveExisting = preserveExisting,
            Files = Directory.GetFiles(root, "*", SearchOption.AllDirectories).Select(path => new ReleaseFile
            {
                Path = Path.GetRelativePath(root, path).Replace('\\', '/'),
                Size = new FileInfo(path).Length,
                Sha256 = FileIntegrity.Sha256(path)
            }).ToList()
        };

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private sealed class TestDesktopShortcutManager : IDesktopShortcutManager
    {
        public bool IsSupported => true;
        public bool FailAfterWrite { get; set; }
        public bool IgnoreWrites { get; set; }
        public Action? BeforeInjectedFailure { get; set; }

        public void CreateOrUpdate(string shortcutPath, DesktopShortcutInfo shortcut)
        {
            if (IgnoreWrites) return;
            Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath)!);
            File.WriteAllText(shortcutPath, JsonSerializer.Serialize(shortcut));
            if (!FailAfterWrite) return;
            FailAfterWrite = false;
            BeforeInjectedFailure?.Invoke();
            BeforeInjectedFailure = null;
            throw new IOException("Injected shortcut activation failure.");
        }

        public DesktopShortcutInfo? Read(string shortcutPath)
            => File.Exists(shortcutPath)
                ? JsonSerializer.Deserialize<DesktopShortcutInfo>(File.ReadAllText(shortcutPath))
                : null;
    }
}

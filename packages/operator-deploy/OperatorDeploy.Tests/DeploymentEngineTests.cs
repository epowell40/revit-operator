using System.IO.Compression;
using System.Text.Json;
using RevitOperator.Deployment;
using Xunit;

namespace OperatorDeploy.Tests;

public sealed class DeploymentEngineTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "operator-deploy-tests", Guid.NewGuid().ToString("N"));

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
    public void Rollback_reactivates_previous_successful_release()
    {
        Assert.True(Run("update", CreateBundle("1.0.0")).Ok);
        Assert.True(Run("update", CreateBundle("2.0.0")).Ok);
        var rollback = Run("rollback");
        Assert.True(rollback.Ok, rollback.Message);
        Assert.Equal("1.0.0", rollback.ReleaseVersion);
        var addin = File.ReadAllText(Path.Combine(Context().AppData, "Autodesk", "Revit", "Addins", "2023", "RevitBridge.addin"));
        Assert.Contains("1.0.0", addin);
    }

    [Fact]
    public void Diagnostics_redact_token_values()
    {
        Assert.True(Run("update", CreateBundle("1.0.0")).Ok);
        var config = Path.Combine(Context().ConfigRoot, "operator-client.json");
        File.WriteAllText(config, "{\"backend_url\":\"https://example/\",\"operator_token\":\"do-not-leak\"}");
        var result = Run("diagnostics");
        Assert.True(result.Ok, result.Message);
        using var zip = ZipFile.OpenRead(result.Details.Single());
        var entry = zip.GetEntry("config/operator-client.sanitized.json")!;
        using var reader = new StreamReader(entry.Open());
        var text = reader.ReadToEnd();
        Assert.DoesNotContain("do-not-leak", text);
        Assert.Contains("[REDACTED]", text);
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

    private OperationResult Run(string operation, string? bundle = null, bool bundleOnly = false, bool revitRunning = false)
    {
        var options = Options(operation, bundle, bundleOnly);
        var context = Context(revitRunning);
        return new DeploymentEngine(context, options, TextWriter.Null).Execute();
    }

    private DeploymentOptions Options(string operation, string? bundle, bool bundleOnly = false)
        => new()
        {
            Operation = operation,
            ManifestPath = bundle == null ? null : Path.Combine(bundle, "manifest.json"),
            BundleOnly = bundleOnly,
            Quiet = true
        };

    private DeploymentContext Context(bool revitRunning = false, Version? windowsVersion = null)
        => new()
        {
            LocalAppData = Path.Combine(_root, "local"),
            AppData = Path.Combine(_root, "roaming"),
            Desktop = Path.Combine(_root, "desktop"),
            ProgramFiles = Path.Combine(_root, "program-files"),
            CommonAppData = Path.Combine(_root, "program-data"),
            WindowsVersion = windowsVersion ?? new Version(10, 0, 19045),
            IsRevitRunning = () => revitRunning,
            UtcNow = () => new DateTimeOffset(2026, 7, 23, 12, 0, 0, TimeSpan.Zero)
        };

    private string CreateBundle(string version)
    {
        var bundle = Path.Combine(_root, "bundles", version);
        var revit = Path.Combine(bundle, "revit");
        var desktop = Path.Combine(bundle, "desktop");
        var config = Path.Combine(bundle, "config");
        Directory.CreateDirectory(revit);
        Directory.CreateDirectory(Path.Combine(desktop, "scripts"));
        Directory.CreateDirectory(Path.Combine(desktop, "runtime"));
        Directory.CreateDirectory(config);
        File.WriteAllText(Path.Combine(revit, "RevitBridge.dll"), $"bridge-{version}");
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
                Component("revit-operator-2023", "revit-addin", "revit", revit, required: true, revitYear: "2023"),
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
}

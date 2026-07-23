using System.IO.Compression;
using System.Net;
using System.Security;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RevitOperator.Deployment;

public sealed class DeploymentEngine
{
    private readonly DeploymentContext _context;
    private readonly DeploymentOptions _options;
    private readonly TextWriter _output;
    private readonly string _logPath;

    public DeploymentEngine(DeploymentContext context, DeploymentOptions options, TextWriter? output = null)
    {
        _context = context;
        _options = options;
        _output = output ?? Console.Out;
        _logPath = options.LogPath ?? (options.BundleOnly
            ? Path.Combine(Path.GetTempPath(), "RevitOperator", $"OperatorDeploy-bundle-validation-{_context.UtcNow():yyyyMMdd-HHmmss}.log")
            : Path.Combine(_context.LogsRoot, $"OperatorDeploy-{_context.UtcNow():yyyyMMdd-HHmmss}.log"));
    }

    public OperationResult Execute()
    {
        try
        {
            Log($"Starting {_options.Operation} (dryRun={_options.DryRun}, scope={_options.InstallScope}).");
            var result = _options.Operation switch
            {
                "install" or "update" => InstallOrUpdate(forceReplace: false),
                "repair" => InstallOrUpdate(forceReplace: true),
                "validate" => Validate(),
                "rollback" => Rollback(),
                "status" => Status(),
                "diagnostics" => Diagnostics(),
                "uninstall" => Unsupported("Uninstall is intentionally deferred until signed release activation and IT-managed retention rules are finalized."),
                _ => throw new DeploymentException(ExitCodes.InvalidArguments, $"Unknown operation '{_options.Operation}'.")
            };
            result.LogPath = _logPath;
            PersistResult(result);
            return result;
        }
        catch (DeploymentException ex)
        {
            Log($"FAILED [{ex.ExitCode}]: {ex.Message}");
            var result = new OperationResult { Ok = false, Operation = _options.Operation, ExitCode = ex.ExitCode, Message = ex.Message, LogPath = _logPath };
            PersistResult(result);
            return result;
        }
        catch (UnauthorizedAccessException ex)
        {
            Log($"FAILED [{ExitCodes.PermissionDenied}]: {ex}");
            var result = new OperationResult { Ok = false, Operation = _options.Operation, ExitCode = ExitCodes.PermissionDenied, Message = ex.Message, LogPath = _logPath };
            PersistResult(result);
            return result;
        }
        catch (Exception ex)
        {
            Log($"FAILED [{ExitCodes.InstallFailed}]: {ex}");
            var result = new OperationResult { Ok = false, Operation = _options.Operation, ExitCode = ExitCodes.InstallFailed, Message = ex.Message, LogPath = _logPath };
            PersistResult(result);
            return result;
        }
    }

    private OperationResult InstallOrUpdate(bool forceReplace)
    {
        if (!_options.InstallScope.Equals("user", StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.Unsupported, "This portable updater supports per-user installation only. Use the future MSI/IT channel for machine scope.");
        if (string.IsNullOrWhiteSpace(_options.ManifestPath))
            throw new DeploymentException(ExitCodes.InvalidArguments, "--manifest is required for install, update, and repair.");
        if (_context.IsRevitRunning())
            throw new DeploymentException(ExitCodes.BlockedProcess, "Revit is running. Save your work and close every Revit window before updating the add-in.");

        var manifestPath = Path.GetFullPath(_options.ManifestPath);
        var bundleRoot = Path.GetDirectoryName(manifestPath)!;
        var manifest = ReleaseManifest.Load(manifestPath);
        var applicable = ApplicableComponents(manifest).ToList();
        if (applicable.Count == 0) throw new DeploymentException(ExitCodes.ManifestInvalid, "No manifest components apply to this workstation or requested Revit version.");
        foreach (var component in applicable) FileIntegrity.VerifyComponent(bundleRoot, component);

        var result = new OperationResult
        {
            Ok = true,
            Operation = _options.Operation,
            ExitCode = ExitCodes.Success,
            Message = _options.DryRun ? "Deployment plan and payload hashes are valid; no files were changed." : "Revit Operator was updated successfully.",
            ReleaseVersion = manifest.ReleaseVersion,
            Details = applicable.Select(c => $"{c.Id} ({c.Kind}, {c.Files.Count} files)").ToList()
        };
        if (_options.DryRun) return result;

        Directory.CreateDirectory(_context.ReleasesRoot);
        Directory.CreateDirectory(_context.DeploymentRoot);
        var finalReleaseRoot = Path.Combine(_context.ReleasesRoot, manifest.ReleaseVersion);
        var stagingRoot = Path.Combine(_context.ReleasesRoot, $".{manifest.ReleaseVersion}.staging-{Guid.NewGuid():N}");
        var displacedRoot = Path.Combine(_context.ReleasesRoot, $".{manifest.ReleaseVersion}.replaced-{_context.UtcNow():yyyyMMddHHmmss}");
        var controlSnapshot = CaptureControlFiles(manifest);
        var movedExisting = false;

        try
        {
            StageRelease(bundleRoot, stagingRoot, manifest, applicable);
            VerifyInstalledTree(stagingRoot, manifest, applicable);

            if (Directory.Exists(finalReleaseRoot))
            {
                try
                {
                    VerifyInstalledTree(finalReleaseRoot, manifest, applicable);
                    if (!forceReplace)
                    {
                        Directory.Delete(stagingRoot, recursive: true);
                        ActivateRelease(finalReleaseRoot, manifest, applicable);
                        SaveSuccessfulState(manifest.ReleaseVersion);
                        result.Message = "The requested release was already present and valid; activation was refreshed.";
                        return result;
                    }
                }
                catch (DeploymentException) when (forceReplace)
                {
                    // Repair replaces the damaged release after staging has already passed verification.
                }

                Directory.Move(finalReleaseRoot, displacedRoot);
                movedExisting = true;
            }

            Directory.Move(stagingRoot, finalReleaseRoot);
            ActivateRelease(finalReleaseRoot, manifest, applicable);
            var validation = ValidateInstalledRelease(finalReleaseRoot, manifest, applicable, includeNetwork: false);
            if (!validation.Ok) throw new DeploymentException(ExitCodes.ValidationFailed, validation.Message);
            SaveSuccessfulState(manifest.ReleaseVersion);
            if (movedExisting) result.Warnings.Add($"The replaced release was retained for recovery at {displacedRoot}.");
            return result;
        }
        catch
        {
            RestoreControlFiles(controlSnapshot);
            if (Directory.Exists(stagingRoot)) Directory.Delete(stagingRoot, recursive: true);
            if (movedExisting && Directory.Exists(displacedRoot))
            {
                if (Directory.Exists(finalReleaseRoot))
                {
                    var failedRoot = Path.Combine(_context.ReleasesRoot, $".{manifest.ReleaseVersion}.failed-{_context.UtcNow():yyyyMMddHHmmss}");
                    Directory.Move(finalReleaseRoot, failedRoot);
                }
                Directory.Move(displacedRoot, finalReleaseRoot);
            }
            throw;
        }
    }

    private OperationResult Validate()
    {
        if (_options.BundleOnly)
        {
            if (string.IsNullOrWhiteSpace(_options.ManifestPath)) throw new DeploymentException(ExitCodes.InvalidArguments, "--manifest is required with --bundle-only.");
            var manifestPath = Path.GetFullPath(_options.ManifestPath);
            var manifest = ReleaseManifest.Load(manifestPath);
            var root = Path.GetDirectoryName(manifestPath)!;
            foreach (var component in ApplicableComponents(manifest)) FileIntegrity.VerifyComponent(root, component);
            return new OperationResult { Ok = true, Operation = "validate", ExitCode = 0, ReleaseVersion = manifest.ReleaseVersion, Message = "Release manifest and bundled payload hashes are valid." };
        }

        var state = LoadState(required: true)!;
        var releaseRoot = Path.Combine(_context.ReleasesRoot, state.CurrentRelease);
        var manifestPathInstalled = Path.Combine(releaseRoot, "manifest.json");
        var manifestInstalled = ReleaseManifest.Load(manifestPathInstalled);
        var result = ValidateInstalledRelease(releaseRoot, manifestInstalled, ApplicableComponents(manifestInstalled).ToList(), includeNetwork: true);
        result.Operation = "validate";
        result.ReleaseVersion = state.CurrentRelease;
        return result;
    }

    private OperationResult ValidateInstalledRelease(string releaseRoot, ReleaseManifest manifest, IReadOnlyCollection<ReleaseComponent> components, bool includeNetwork)
    {
        var result = new OperationResult { Ok = true, ExitCode = 0, Message = "Installed release validation passed." };
        try
        {
            VerifyInstalledTree(releaseRoot, manifest, components);
            foreach (var addin in components.Where(c => c.Kind == "revit-addin"))
            {
                var addinPath = AddinManifestPath(addin.RevitYear!);
                if (!File.Exists(addinPath)) throw new DeploymentException(ExitCodes.ValidationFailed, $"Revit {addin.RevitYear} add-in manifest is missing: {addinPath}");
                var expectedDll = Path.Combine(releaseRoot, addin.Id, "RevitBridge.dll");
                var xml = File.ReadAllText(addinPath);
                if (!xml.Contains(expectedDll, StringComparison.OrdinalIgnoreCase))
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"Revit {addin.RevitYear} add-in manifest does not reference the active release DLL.");
            }

            var desktop = components.FirstOrDefault(c => c.Kind == "operator-desktop");
            if (desktop != null)
            {
                var launcher = Path.Combine(releaseRoot, desktop.Id, "scripts", "launch_operator_desktop.ps1");
                var server = Path.Combine(releaseRoot, desktop.Id, "server.js");
                var runtime = Path.Combine(releaseRoot, desktop.Id, "runtime", "node.exe");
                if (!File.Exists(launcher) || !File.Exists(server) || !File.Exists(runtime))
                    throw new DeploymentException(ExitCodes.ValidationFailed, "Operator Desktop launcher, server, or bundled Node runtime is missing.");
            }

            var configPath = Path.Combine(_context.ConfigRoot, "operator-client.json");
            if (File.Exists(configPath)) JsonDocument.Parse(File.ReadAllText(configPath)).Dispose();
            else result.Warnings.Add($"Operator client configuration has not been created yet: {configPath}");
        }
        catch (DeploymentException ex)
        {
            result.Ok = false;
            result.ExitCode = ex.ExitCode;
            result.Message = ex.Message;
            return result;
        }
        catch (Exception ex)
        {
            result.Ok = false;
            result.ExitCode = ExitCodes.ValidationFailed;
            result.Message = ex.Message;
            return result;
        }

        if (includeNetwork && !string.IsNullOrWhiteSpace(manifest.BackendUrl)) CheckBackend(manifest.BackendUrl!, result);
        return result;
    }

    private OperationResult Rollback()
    {
        if (_context.IsRevitRunning()) throw new DeploymentException(ExitCodes.BlockedProcess, "Revit is running. Close every Revit window before rollback.");
        var state = LoadState(required: true)!;
        var target = state.SuccessfulReleases.LastOrDefault(x => !x.Equals(state.CurrentRelease, StringComparison.OrdinalIgnoreCase));
        if (target == null) throw new DeploymentException(ExitCodes.RollbackFailed, "No previous successful release is available for rollback.");
        var releaseRoot = Path.Combine(_context.ReleasesRoot, target);
        var manifest = ReleaseManifest.Load(Path.Combine(releaseRoot, "manifest.json"));
        var components = ApplicableComponents(manifest).ToList();
        VerifyInstalledTree(releaseRoot, manifest, components);
        if (_options.DryRun)
            return new OperationResult { Ok = true, Operation = "rollback", ExitCode = 0, ReleaseVersion = target, Message = $"Rollback target {target} is valid; no files were changed." };

        var snapshot = CaptureControlFiles(manifest);
        try
        {
            ActivateRelease(releaseRoot, manifest, components);
            state.CurrentRelease = target;
            state.UpdatedAtUtc = _context.UtcNow().ToString("O");
            SaveState(state);
        }
        catch
        {
            RestoreControlFiles(snapshot);
            throw;
        }
        return new OperationResult { Ok = true, Operation = "rollback", ExitCode = 0, ReleaseVersion = target, Message = $"Rolled back to {target}." };
    }

    private OperationResult Status()
    {
        var state = LoadState(required: false);
        if (state == null)
            return new OperationResult { Ok = false, Operation = "status", ExitCode = ExitCodes.NoInstalledRelease, Message = "Revit Operator has not been installed by OperatorDeploy on this profile." };
        var result = new OperationResult { Ok = true, Operation = "status", ExitCode = 0, ReleaseVersion = state.CurrentRelease, Message = $"Current release: {state.CurrentRelease}" };
        result.Details.AddRange(state.SuccessfulReleases.Select(x => x == state.CurrentRelease ? $"{x} (current)" : x));
        return result;
    }

    private OperationResult Diagnostics()
    {
        Directory.CreateDirectory(_context.DeploymentRoot);
        var stamp = _context.UtcNow().ToString("yyyyMMdd-HHmmss");
        var zipPath = Path.Combine(_context.DeploymentRoot, $"OperatorDeploy-diagnostics-{stamp}.zip");
        using var archive = ZipFile.Open(zipPath, ZipArchiveMode.Create);
        AddIfExists(archive, _context.StatePath, "state.json");
        foreach (var log in Directory.Exists(_context.LogsRoot) ? Directory.GetFiles(_context.LogsRoot, "*.log").TakeLast(20) : Array.Empty<string>())
            AddIfExists(archive, log, $"logs/{Path.GetFileName(log)}");

        var configPath = Path.Combine(_context.ConfigRoot, "operator-client.json");
        if (File.Exists(configPath))
        {
            var sanitized = SanitizeJson(File.ReadAllText(configPath));
            var entry = archive.CreateEntry("config/operator-client.sanitized.json");
            using var writer = new StreamWriter(entry.Open());
            writer.Write(sanitized);
        }
        var summary = archive.CreateEntry("system.txt");
        using (var writer = new StreamWriter(summary.Open()))
        {
            writer.WriteLine($"GeneratedUtc={_context.UtcNow():O}");
            writer.WriteLine($"OS={Environment.OSVersion}");
            writer.WriteLine($"Is64BitOS={Environment.Is64BitOperatingSystem}");
            writer.WriteLine($"RevitRunning={_context.IsRevitRunning()}");
            foreach (var year in new[] { "2023", "2024", "2025", "2026" }) writer.WriteLine($"Revit{year}Installed={_context.IsRevitInstalled(year)}");
        }
        return new OperationResult { Ok = true, Operation = "diagnostics", ExitCode = 0, Message = $"Diagnostics created: {zipPath}", Details = { zipPath } };
    }

    private IEnumerable<ReleaseComponent> ApplicableComponents(ReleaseManifest manifest)
    {
        foreach (var component in manifest.Components)
        {
            if (component.Kind == "revit-addin")
            {
                if (_options.RevitVersion != null && component.RevitYear != _options.RevitVersion) continue;
                if (_options.RevitVersion == null && !component.InstallWhenRevitMissing && !_context.IsRevitInstalled(component.RevitYear!)) continue;
            }
            yield return component;
        }
    }

    private void StageRelease(string bundleRoot, string stagingRoot, ReleaseManifest manifest, IReadOnlyCollection<ReleaseComponent> components)
    {
        Directory.CreateDirectory(stagingRoot);
        foreach (var component in components)
        {
            var sourceRoot = FileIntegrity.ResolveUnder(bundleRoot, component.PayloadPath);
            var destinationRoot = Path.Combine(stagingRoot, component.Id);
            foreach (var file in component.Files)
            {
                var source = FileIntegrity.ResolveUnder(sourceRoot, file.Path);
                var destination = FileIntegrity.ResolveUnder(destinationRoot, file.Path);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                File.Copy(source, destination, overwrite: false);
            }
        }
        File.WriteAllText(Path.Combine(stagingRoot, "manifest.json"), JsonSerializer.Serialize(manifest, ReleaseManifest.JsonOptions));
        Log($"Staged release {manifest.ReleaseVersion} at {stagingRoot}.");
    }

    private static void VerifyInstalledTree(string releaseRoot, ReleaseManifest manifest, IEnumerable<ReleaseComponent> components)
    {
        foreach (var component in components)
        {
            var root = Path.Combine(releaseRoot, component.Id);
            foreach (var file in component.Files)
            {
                var path = FileIntegrity.ResolveUnder(root, file.Path, ExitCodes.ValidationFailed);
                if (!File.Exists(path) || new FileInfo(path).Length != file.Size || !FileIntegrity.Sha256(path).Equals(file.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"Installed file validation failed: {component.Id}/{file.Path}");
            }
        }
    }

    private void ActivateRelease(string releaseRoot, ReleaseManifest manifest, IReadOnlyCollection<ReleaseComponent> components)
    {
        foreach (var addin in components.Where(c => c.Kind == "revit-addin"))
        {
            var dll = Path.Combine(releaseRoot, addin.Id, "RevitBridge.dll");
            if (!File.Exists(dll)) throw new DeploymentException(ExitCodes.ValidationFailed, $"RevitBridge.dll is missing from component {addin.Id}.");
            var xml = $"""
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>RevitOperator</Name>
    <Assembly>{SecurityElement.Escape(dll)}</Assembly>
    <FullClassName>RevitBridge.App</FullClassName>
    <AddInId>B2883307-2852-4740-9833-281048674F77</AddInId>
    <VendorId>com.revitoperator</VendorId>
    <VendorDescription>Revit Operator</VendorDescription>
  </AddIn>
</RevitAddIns>
""";
            WriteAtomic(AddinManifestPath(addin.RevitYear!), xml);
        }

        var desktop = components.FirstOrDefault(c => c.Kind == "operator-desktop");
        if (desktop != null)
        {
            var script = Path.Combine(releaseRoot, desktop.Id, "scripts", "launch_operator_desktop.ps1");
            var command = $"@echo off\r\n\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"{script}\" %*\r\n";
            WriteAtomic(Path.Combine(_context.ProductRoot, "Operator Desktop.cmd"), command);
            if (!string.IsNullOrWhiteSpace(_context.Desktop)) WriteAtomic(Path.Combine(_context.Desktop, "Operator Desktop.cmd"), command);
        }

        foreach (var config in components.Where(c => c.Kind == "config-default"))
        {
            var sourceRoot = Path.Combine(releaseRoot, config.Id);
            foreach (var file in config.Files)
            {
                var destination = FileIntegrity.ResolveUnder(_context.ConfigRoot, file.Path);
                if (config.PreserveExisting && File.Exists(destination)) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                File.Copy(FileIntegrity.ResolveUnder(sourceRoot, file.Path), destination, overwrite: true);
            }
        }
        Log($"Activated release {manifest.ReleaseVersion}.");
    }

    private string AddinManifestPath(string year)
        => Path.Combine(_context.AppData, "Autodesk", "Revit", "Addins", year, "RevitBridge.addin");

    private Dictionary<string, byte[]?> CaptureControlFiles(ReleaseManifest manifest)
    {
        var paths = manifest.Components.Where(c => c.Kind == "revit-addin" && c.RevitYear != null).Select(c => AddinManifestPath(c.RevitYear!)).ToList();
        paths.Add(Path.Combine(_context.ProductRoot, "Operator Desktop.cmd"));
        if (!string.IsNullOrWhiteSpace(_context.Desktop)) paths.Add(Path.Combine(_context.Desktop, "Operator Desktop.cmd"));
        paths.Add(_context.StatePath);
        return paths.Distinct(StringComparer.OrdinalIgnoreCase).ToDictionary(path => path, path => File.Exists(path) ? File.ReadAllBytes(path) : null, StringComparer.OrdinalIgnoreCase);
    }

    private static void RestoreControlFiles(Dictionary<string, byte[]?> snapshot)
    {
        foreach (var pair in snapshot)
        {
            if (pair.Value == null)
            {
                if (File.Exists(pair.Key)) File.Delete(pair.Key);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(pair.Key)!);
            File.WriteAllBytes(pair.Key, pair.Value);
        }
    }

    private void SaveSuccessfulState(string releaseVersion)
    {
        var state = LoadState(required: false) ?? new InstalledState();
        state.SuccessfulReleases.RemoveAll(x => x.Equals(releaseVersion, StringComparison.OrdinalIgnoreCase));
        state.SuccessfulReleases.Add(releaseVersion);
        state.CurrentRelease = releaseVersion;
        state.UpdatedAtUtc = _context.UtcNow().ToString("O");
        SaveState(state);
    }

    private InstalledState? LoadState(bool required)
    {
        if (!File.Exists(_context.StatePath))
        {
            if (required) throw new DeploymentException(ExitCodes.NoInstalledRelease, "No OperatorDeploy installation state was found.");
            return null;
        }
        try
        {
            return JsonSerializer.Deserialize<InstalledState>(File.ReadAllText(_context.StatePath), ReleaseManifest.JsonOptions)
                ?? throw new InvalidDataException("State was empty.");
        }
        catch (Exception ex) { throw new DeploymentException(ExitCodes.ValidationFailed, $"Installed state is invalid: {ex.Message}", ex); }
    }

    private void SaveState(InstalledState state)
        => WriteAtomic(_context.StatePath, JsonSerializer.Serialize(state, ReleaseManifest.JsonOptions));

    private static void WriteAtomic(string path, string contents)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + $".tmp-{Guid.NewGuid():N}";
        File.WriteAllText(temp, contents, new UTF8Encoding(false));
        File.Move(temp, path, overwrite: true);
    }

    private static void CheckBackend(string backendUrl, OperationResult result)
    {
        try
        {
            if (!Uri.TryCreate(backendUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            {
                result.Warnings.Add($"Backend URL is not HTTPS: {backendUrl}");
                return;
            }
            _ = Dns.GetHostAddresses(uri.Host);
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            using var response = client.Send(request);
            result.Details.Add($"Backend HTTPS reachable: {(int)response.StatusCode} {response.StatusCode}");
        }
        catch (Exception ex) { result.Warnings.Add($"Backend/network validation warning: {ex.Message}"); }
    }

    private static string SanitizeJson(string json)
    {
        var node = JsonNode.Parse(json);
        SanitizeNode(node);
        return node?.ToJsonString(ReleaseManifest.JsonOptions) ?? "{}";
    }

    private static void SanitizeNode(JsonNode? node)
    {
        if (node is JsonObject obj)
        {
            foreach (var key in obj.Select(p => p.Key).ToList())
            {
                if (key.Contains("token", StringComparison.OrdinalIgnoreCase) || key.Contains("password", StringComparison.OrdinalIgnoreCase) ||
                    key.Contains("secret", StringComparison.OrdinalIgnoreCase) || key.Contains("api_key", StringComparison.OrdinalIgnoreCase) ||
                    key.Contains("license", StringComparison.OrdinalIgnoreCase)) obj[key] = "[REDACTED]";
                else SanitizeNode(obj[key]);
            }
        }
        else if (node is JsonArray array) foreach (var child in array) SanitizeNode(child);
    }

    private static void AddIfExists(ZipArchive archive, string source, string entry)
    {
        if (File.Exists(source)) archive.CreateEntryFromFile(source, entry, CompressionLevel.Optimal);
    }

    private OperationResult Unsupported(string message)
        => new() { Ok = false, Operation = _options.Operation, ExitCode = ExitCodes.Unsupported, Message = message };

    private void Log(string message)
    {
        var line = $"{_context.UtcNow():O} {message}";
        Directory.CreateDirectory(Path.GetDirectoryName(_logPath)!);
        File.AppendAllText(_logPath, line + Environment.NewLine);
        if (!_options.Quiet) _output.WriteLine(line);
    }

    private void PersistResult(OperationResult result)
    {
        if (_options.BundleOnly) return;
        try
        {
            Directory.CreateDirectory(_context.DeploymentRoot);
            var path = Path.Combine(_context.DeploymentRoot, "last-result.json");
            WriteAtomic(path, JsonSerializer.Serialize(result, ReleaseManifest.JsonOptions));
        }
        catch { /* The primary operation result remains authoritative if result-file persistence is unavailable. */ }
    }
}

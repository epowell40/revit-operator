using System.IO.Compression;
using System.Net;
using System.Security;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml;
using System.Xml.Linq;

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
            using var deploymentLease = _context.TryAcquireDeploymentMutex()
                ?? throw new DeploymentException(ExitCodes.InstallFailed, "Another OperatorDeploy operation is already in progress. Retry after it completes.");
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
        var minimumWindows = Version.Parse(manifest.MinimumWindowsVersion);
        if (_context.WindowsVersion.CompareTo(minimumWindows) < 0)
            throw new DeploymentException(ExitCodes.Unsupported, $"Windows {_context.WindowsVersion} is older than this release's minimum supported version {minimumWindows}.");
        var applicable = ApplicableComponents(manifest).ToList();
        if (applicable.Count == 0) throw new DeploymentException(ExitCodes.ManifestInvalid, "No manifest components apply to this workstation or requested Revit version.");
        if (applicable.Any(component => component.Kind == "operator-desktop")) EnsureManagedDesktopLauncherOverride();
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
        var finalReleaseRoot = Path.Combine(_context.ReleasesRoot, manifest.ReleaseVersion);
        var installedManifest = CopyManifestWithComponents(manifest, applicable);
        var stateBefore = LoadState(required: false);
        var currentOwnership = ResolveCurrentOwnership(stateBefore);
        if (_options.DryRun)
        {
            _ = PlanActivation(finalReleaseRoot, installedManifest, applicable, currentOwnership, requireAssembly: false);
            return result;
        }

        Directory.CreateDirectory(_context.ReleasesRoot);
        Directory.CreateDirectory(_context.DeploymentRoot);
        var stagingRoot = Path.Combine(_context.ReleasesRoot, $".{manifest.ReleaseVersion}.staging-{Guid.NewGuid():N}");
        var displacedRoot = Path.Combine(_context.ReleasesRoot, $".{manifest.ReleaseVersion}.replaced-{_context.UtcNow():yyyyMMddHHmmss}");
        var controlSnapshot = CaptureControlFiles(installedManifest, currentOwnership);
        var movedExisting = false;

        try
        {
            StageRelease(bundleRoot, stagingRoot, installedManifest, applicable);
            VerifyInstalledTree(stagingRoot, installedManifest, applicable);

            if (Directory.Exists(finalReleaseRoot))
            {
                var existingManifest = ReleaseManifest.Load(Path.Combine(finalReleaseRoot, "manifest.json"));
                EnsureCompatibleSameVersionManifest(existingManifest, installedManifest);
                var incomingIds = applicable.Select(component => component.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
                var preserved = existingManifest.Components.Where(component => !incomingIds.Contains(component.Id)).ToList();
                VerifyInstalledTree(finalReleaseRoot, existingManifest, preserved);

                DeploymentException? existingValidationFailure = null;
                try
                {
                    VerifyInstalledTree(finalReleaseRoot, installedManifest, applicable);
                }
                catch (DeploymentException ex)
                {
                    existingValidationFailure = ex;
                }

                var existingIds = existingManifest.Components.Select(component => component.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
                var hasEveryIncomingComponent = incomingIds.All(existingIds.Contains);
                if (existingValidationFailure == null && hasEveryIncomingComponent && !forceReplace)
                {
                    Directory.Delete(stagingRoot, recursive: true);
                    var activation = ActivateRelease(finalReleaseRoot, existingManifest, applicable, currentOwnership);
                    ValidateActivatedRelease(finalReleaseRoot, existingManifest, existingManifest.Components, activation);
                    SaveSuccessfulState(manifest.ReleaseVersion, activation.Ownership);
                    result.Message = "The requested release was already present and valid; activation was refreshed.";
                    return result;
                }

                var addsComponent = incomingIds.Any(id => !existingIds.Contains(id));
                if (existingValidationFailure != null && !forceReplace && !addsComponent)
                {
                    throw existingValidationFailure;
                }

                foreach (var component in preserved)
                {
                    CopyInstalledComponent(finalReleaseRoot, stagingRoot, component);
                }
                installedManifest = CopyManifestWithComponents(manifest, preserved.Concat(applicable));
                File.WriteAllText(Path.Combine(stagingRoot, "manifest.json"), JsonSerializer.Serialize(installedManifest, ReleaseManifest.JsonOptions));
                VerifyInstalledTree(stagingRoot, installedManifest, installedManifest.Components);

                Directory.Move(finalReleaseRoot, displacedRoot);
                movedExisting = true;
            }

            Directory.Move(stagingRoot, finalReleaseRoot);
            var completedActivation = ActivateRelease(finalReleaseRoot, installedManifest, applicable, currentOwnership);
            ValidateActivatedRelease(finalReleaseRoot, installedManifest, installedManifest.Components, completedActivation);
            SaveSuccessfulState(manifest.ReleaseVersion, completedActivation.Ownership);
            if (movedExisting) result.Warnings.Add($"The replaced release was retained for recovery at {displacedRoot}.");
            return result;
        }
        catch (Exception original)
        {
            var recoveryFailures = RestoreControlFiles(controlSnapshot);
            try
            {
                if (Directory.Exists(stagingRoot)) Directory.Delete(stagingRoot, recursive: true);
            }
            catch (Exception ex) { recoveryFailures.Add(ex); }
            if (movedExisting && Directory.Exists(displacedRoot))
            {
                try
                {
                    if (Directory.Exists(finalReleaseRoot))
                    {
                        var failedRoot = Path.Combine(_context.ReleasesRoot, $".{manifest.ReleaseVersion}.failed-{_context.UtcNow():yyyyMMddHHmmss}");
                        Directory.Move(finalReleaseRoot, failedRoot);
                    }
                    Directory.Move(displacedRoot, finalReleaseRoot);
                }
                catch (Exception ex) { recoveryFailures.Add(ex); }
            }
            if (recoveryFailures.Count == 0) throw;
            throw PreserveOriginalFailure(original, recoveryFailures);
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
        if (result.Ok)
        {
            try
            {
                foreach (var control in ResolveCurrentOwnership(state)) AssertOwnedManifest(control);
            }
            catch (DeploymentException ex)
            {
                result.Ok = false;
                result.ExitCode = ex.ExitCode;
                result.Message = ex.Message;
            }
        }
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
                var expected = BuildAddinControl(releaseRoot, manifest, addin);
                var addinPath = expected.Ownership.ManifestPath;
                if (!File.Exists(addinPath)) throw new DeploymentException(ExitCodes.ValidationFailed, $"Revit {addin.RevitYear} add-in manifest is missing: {addinPath}");
                if (!FileIntegrity.Sha256(addinPath).Equals(expected.Ownership.ManifestSha256, StringComparison.OrdinalIgnoreCase))
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"Revit {addin.RevitYear} add-in manifest does not exactly match the active release identity.");
                var entries = ReadAddinEntries(addinPath);
                if (entries.Count != 1 || !EntryMatches(entries[0], expected.Ownership))
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"Revit {addin.RevitYear} add-in manifest identity or assembly path is invalid.");
                var conflicts = FindConflictingAddinManifests(addin.RevitYear!, addinPath, expected.Ownership.AddInId).ToList();
                if (conflicts.Count > 0)
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"Conflicting Revit add-in manifest(s) were found for Revit {addin.RevitYear} and AddInId {expected.Ownership.AddInId}: {string.Join("; ", conflicts)}");
            }

            var desktop = components.FirstOrDefault(c => c.Kind == "operator-desktop");
            if (desktop != null)
            {
                var launcher = Path.Combine(releaseRoot, desktop.Id, "scripts", "launch_operator_desktop.ps1");
                var server = Path.Combine(releaseRoot, desktop.Id, "server.js");
                var runtime = Path.Combine(releaseRoot, desktop.Id, "runtime", "node.exe");
                if (!File.Exists(launcher) || !File.Exists(server) || !File.Exists(runtime))
                    throw new DeploymentException(ExitCodes.ValidationFailed, "Operator Desktop launcher, server, or bundled Node runtime is missing.");
                ValidateDesktopControls(releaseRoot, desktop, result);
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
        if (components.Any(component => component.Kind == "operator-desktop")) EnsureManagedDesktopLauncherOverride();
        VerifyInstalledTree(releaseRoot, manifest, components);
        var currentOwnership = ResolveCurrentOwnership(state);
        _ = PlanActivation(releaseRoot, manifest, components, currentOwnership, requireAssembly: true);
        if (_options.DryRun)
            return new OperationResult { Ok = true, Operation = "rollback", ExitCode = 0, ReleaseVersion = target, Message = $"Rollback target {target} is valid; no files were changed." };

        var snapshot = CaptureControlFiles(manifest, currentOwnership);
        try
        {
            var activation = ActivateRelease(releaseRoot, manifest, components, currentOwnership);
            ValidateActivatedRelease(releaseRoot, manifest, components, activation);
            state.CurrentRelease = target;
            state.UpdatedAtUtc = _context.UtcNow().ToString("O");
            state.SchemaVersion = 2;
            state.OwnedAddinManifests = activation.Ownership;
            SaveState(state);
        }
        catch (Exception original)
        {
            var restoreFailures = RestoreControlFiles(snapshot);
            if (restoreFailures.Count == 0) throw;
            throw PreserveOriginalFailure(original, restoreFailures);
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
        var launcherOverrideStatus = DescribeLauncherOverride();
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
            WriteDesktopControlDiagnostics(writer, launcherOverrideStatus);
        }
        if (launcherOverrideStatus is "conflict" or "invalid")
        {
            return new OperationResult
            {
                Ok = false,
                Operation = "diagnostics",
                ExitCode = ExitCodes.ValidationFailed,
                Message = $"Diagnostics created, but OPERATOR_DESKTOP_LAUNCHER_PATH is {launcherOverrideStatus}. Point it to the managed launcher or remove the override, then retry; OperatorDeploy did not change the environment.",
                Details = { zipPath }
            };
        }
        return new OperationResult { Ok = true, Operation = "diagnostics", ExitCode = 0, Message = $"Diagnostics created: {zipPath}", Details = { zipPath } };
    }

    private IEnumerable<ReleaseComponent> ApplicableComponents(ReleaseManifest manifest)
    {
        if (_options.RevitVersion != null)
        {
            if (_options.RevitVersion.Length != 4 || !int.TryParse(_options.RevitVersion, out _))
                throw new DeploymentException(ExitCodes.InvalidArguments, "--revit-version must be a four-digit year.");
            if (!manifest.Components.Any(component => component.Kind == "revit-addin" && component.RevitYear == _options.RevitVersion))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"The release manifest has no complete Revit {_options.RevitVersion} activation set.");
        }
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

    private static ReleaseManifest CopyManifestWithComponents(ReleaseManifest source, IEnumerable<ReleaseComponent> components)
    {
        var copy = new ReleaseManifest
        {
            SchemaVersion = source.SchemaVersion,
            ReleaseVersion = source.ReleaseVersion,
            GeneratedAtUtc = source.GeneratedAtUtc,
            SourceRevision = source.SourceRevision,
            MinimumWindowsVersion = source.MinimumWindowsVersion,
            BackendUrl = source.BackendUrl,
            MinimumBackendApiVersion = source.MinimumBackendApiVersion,
            MaximumBackendApiVersion = source.MaximumBackendApiVersion,
            RevitAddinProfiles = source.RevitAddinProfiles
                .Where(profile => components.Any(component => component.RevitAddinProfileId != null && component.RevitAddinProfileId.Equals(profile.Id, StringComparison.OrdinalIgnoreCase)))
                .ToList(),
            Components = components.ToList()
        };
        copy.Validate();
        return copy;
    }

    private static void EnsureCompatibleSameVersionManifest(ReleaseManifest existing, ReleaseManifest incoming)
    {
        if (!existing.ReleaseVersion.Equals(incoming.ReleaseVersion, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"Installed release '{existing.ReleaseVersion}' does not match incoming release '{incoming.ReleaseVersion}'.");
        if (!string.IsNullOrWhiteSpace(existing.SourceRevision) &&
            !string.IsNullOrWhiteSpace(incoming.SourceRevision) &&
            !existing.SourceRevision.Equals(incoming.SourceRevision, StringComparison.OrdinalIgnoreCase))
        {
            throw new DeploymentException(ExitCodes.ManifestInvalid,
                $"Release {incoming.ReleaseVersion} already exists with a different source revision. Build a new release version instead of mixing payloads.");
        }
        if (existing.SchemaVersion != incoming.SchemaVersion)
            throw new DeploymentException(ExitCodes.ManifestInvalid, $"Release {incoming.ReleaseVersion} already exists with manifest schema {existing.SchemaVersion}, not {incoming.SchemaVersion}.");
        if (existing.SchemaVersion == 2)
        {
            var existingProfiles = JsonSerializer.Serialize(existing.RevitAddinProfiles.OrderBy(profile => profile.Id), ReleaseManifest.JsonOptions);
            var incomingProfiles = JsonSerializer.Serialize(incoming.RevitAddinProfiles.OrderBy(profile => profile.Id), ReleaseManifest.JsonOptions);
            if (!existingProfiles.Equals(incomingProfiles, StringComparison.Ordinal))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Release {incoming.ReleaseVersion} already exists with different Revit add-in profiles.");
        }
    }

    private static void CopyInstalledComponent(string sourceReleaseRoot, string stagingRoot, ReleaseComponent component)
    {
        var sourceRoot = Path.Combine(sourceReleaseRoot, component.Id);
        var destinationRoot = Path.Combine(stagingRoot, component.Id);
        foreach (var file in component.Files)
        {
            var source = FileIntegrity.ResolveUnder(sourceRoot, file.Path, ExitCodes.ValidationFailed);
            var destination = FileIntegrity.ResolveUnder(destinationRoot, file.Path, ExitCodes.ValidationFailed);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(source, destination, overwrite: false);
        }
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

    private ActivationResult ActivateRelease(
        string releaseRoot,
        ReleaseManifest manifest,
        IReadOnlyCollection<ReleaseComponent> components,
        IReadOnlyCollection<OwnedAddinManifest> currentOwnership)
    {
        var plan = PlanActivation(releaseRoot, manifest, components, currentOwnership, requireAssembly: true);

        foreach (var target in plan.Targets) WriteAtomic(target.Ownership.ManifestPath, target.Xml);
        foreach (var control in plan.Obsolete)
        {
            AssertOwnedManifest(control);
            File.Delete(control.ManifestPath);
        }

        var desktop = components.FirstOrDefault(c => c.Kind == "operator-desktop");
        if (desktop != null)
        {
            EnsureManagedDesktopLauncherOverride();
            var script = Path.Combine(releaseRoot, desktop.Id, "scripts", "launch_operator_desktop.ps1");
            var command = DesktopCommand(script);
            WriteAtomic(_context.StableDesktopLauncherPath, command);
            if (!string.IsNullOrWhiteSpace(_context.Desktop))
            {
                WriteAtomic(_context.DesktopCommandPath, command);
                if (_context.DesktopShortcuts.IsSupported)
                {
                    _context.DesktopShortcuts.CreateOrUpdate(
                        _context.DesktopShortcutPath,
                        new DesktopShortcutInfo(_context.StableDesktopLauncherPath, "", _context.ProductRoot));
                }
            }
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
        return new ActivationResult(plan.Retained.Concat(plan.Targets.Select(target => target.Ownership)).ToList(), plan.Obsolete);
    }

    private PlannedActivation PlanActivation(
        string releaseRoot,
        ReleaseManifest manifest,
        IReadOnlyCollection<ReleaseComponent> components,
        IReadOnlyCollection<OwnedAddinManifest> currentOwnership,
        bool requireAssembly)
    {
        var targets = components.Where(component => component.Kind == "revit-addin")
            .Select(component => BuildAddinControl(releaseRoot, manifest, component, requireAssembly)).ToList();
        EnsureCompleteActivationSelection(manifest, targets);
        var targetPaths = targets.Select(target => target.Ownership.ManifestPath).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var affectedYears = targets.Select(target => target.Ownership.RevitYear).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var obsolete = currentOwnership.Where(control => affectedYears.Contains(control.RevitYear) && !targetPaths.Contains(control.ManifestPath)).ToList();
        var retained = currentOwnership.Where(control => !affectedYears.Contains(control.RevitYear)).ToList();

        foreach (var control in obsolete) AssertOwnedManifest(control);
        foreach (var control in currentOwnership.Where(control => targetPaths.Contains(control.ManifestPath) && File.Exists(control.ManifestPath)))
            AssertOwnedManifest(control);
        foreach (var target in targets)
        {
            EnsureControlPathIsLocal(target.Ownership.ManifestPath);
            if (!File.Exists(target.Ownership.ManifestPath)) continue;
            var owned = currentOwnership.FirstOrDefault(control => PathsEqual(control.ManifestPath, target.Ownership.ManifestPath));
            if (owned == null)
                throw new DeploymentException(ExitCodes.ValidationFailed, $"Refusing to replace unowned Revit add-in manifest: {target.Ownership.ManifestPath}");
        }
        return new PlannedActivation(targets, obsolete, retained);
    }

    private string AddinManifestPath(string year, string fileName)
        => Path.Combine(_context.AppData, "Autodesk", "Revit", "Addins", year, fileName);

    private IEnumerable<string> FindConflictingAddinManifests(string year, string primaryPath, string addInId)
    {
        var roots = new[]
        {
            Path.Combine(_context.AppData, "Autodesk", "Revit", "Addins", year),
            Path.Combine(_context.CommonAppData, "Autodesk", "Revit", "Addins", year)
        };
        foreach (var root in roots.Where(Directory.Exists))
        {
            foreach (var path in Directory.GetFiles(root, "*.addin", SearchOption.TopDirectoryOnly))
            {
                if (path.Equals(primaryPath, StringComparison.OrdinalIgnoreCase)) continue;
                var matches = false;
                try
                {
                    matches = ReadAddInIds(path).Any(value => value.Equals(addInId, StringComparison.OrdinalIgnoreCase));
                }
                catch { /* An unreadable unrelated manifest is not owned by this installer. */ }
                if (matches) yield return path;
            }
        }
    }

    private Dictionary<string, byte[]?> CaptureControlFiles(ReleaseManifest manifest, IReadOnlyCollection<OwnedAddinManifest> currentOwnership)
    {
        var paths = manifest.Components.Where(c => c.Kind == "revit-addin" && c.RevitYear != null)
            .Select(component => AddinManifestPath(component.RevitYear!, GetAddinProfile(manifest, component).ManifestFileName))
            .Concat(currentOwnership.Select(control => control.ManifestPath)).ToList();
        paths.Add(_context.StableDesktopLauncherPath);
        if (!string.IsNullOrWhiteSpace(_context.Desktop))
        {
            paths.Add(_context.DesktopCommandPath);
            paths.Add(_context.DesktopShortcutPath);
        }
        paths.Add(_context.StatePath);
        return paths.Distinct(StringComparer.OrdinalIgnoreCase).ToDictionary(path => path, path => File.Exists(path) ? File.ReadAllBytes(path) : null, StringComparer.OrdinalIgnoreCase);
    }

    private AddinControl BuildAddinControl(string releaseRoot, ReleaseManifest manifest, ReleaseComponent component, bool requireAssembly = true)
    {
        var profile = GetAddinProfile(manifest, component);
        var assembly = FileIntegrity.ResolveUnder(Path.Combine(releaseRoot, component.Id), profile.AssemblyPath, ExitCodes.ValidationFailed);
        if (requireAssembly && !File.Exists(assembly))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Add-in assembly '{profile.AssemblyPath}' is missing from component {component.Id}.");
        var path = AddinManifestPath(component.RevitYear!, profile.ManifestFileName);
        var xml = BuildAddinXml(profile, assembly);
        var bytes = new UTF8Encoding(false).GetBytes(xml);
        return new AddinControl(xml, new OwnedAddinManifest
        {
            RevitYear = component.RevitYear!,
            ProfileId = profile.Id,
            ManifestPath = Path.GetFullPath(path),
            ManifestFileName = profile.ManifestFileName,
            AddInId = Guid.Parse(profile.AddInId).ToString("D").ToUpperInvariant(),
            FullClassName = profile.FullClassName,
            AssemblyPath = Path.GetFullPath(assembly),
            ManifestSha256 = FileIntegrity.Sha256(bytes)
        });
    }

    private static RevitAddinProfile GetAddinProfile(ReleaseManifest manifest, ReleaseComponent component)
    {
        if (manifest.SchemaVersion == 1) return LegacyAddinProfile;
        return manifest.RevitAddinProfiles.Single(profile => profile.Id.Equals(component.RevitAddinProfileId, StringComparison.OrdinalIgnoreCase));
    }

    private static readonly RevitAddinProfile LegacyAddinProfile = new()
    {
        Id = "revit-bridge-legacy",
        ManifestFileName = "RevitBridge.addin",
        AssemblyPath = "RevitBridge.dll",
        Name = "RevitOperator",
        FullClassName = "RevitBridge.App",
        AddInId = "B2883307-2852-4740-9833-281048674F77",
        VendorId = "com.revitoperator",
        VendorDescription = "Revit Operator"
    };

    private static string BuildAddinXml(RevitAddinProfile profile, string assembly)
        => $"""
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="{SecurityElement.Escape(profile.Type)}">
    <Name>{SecurityElement.Escape(profile.Name)}</Name>
    <Assembly>{SecurityElement.Escape(assembly)}</Assembly>
    <FullClassName>{SecurityElement.Escape(profile.FullClassName)}</FullClassName>
    <AddInId>{Guid.Parse(profile.AddInId).ToString("D").ToUpperInvariant()}</AddInId>
    <VendorId>{SecurityElement.Escape(profile.VendorId)}</VendorId>
    <VendorDescription>{SecurityElement.Escape(profile.VendorDescription)}</VendorDescription>
  </AddIn>
</RevitAddIns>
""";

    private static void EnsureCompleteActivationSelection(ReleaseManifest manifest, IReadOnlyCollection<AddinControl> targets)
    {
        if (manifest.SchemaVersion != 2 || targets.Count == 0) return;
        var expected = manifest.RevitAddinProfiles.Select(profile => profile.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var group in targets.GroupBy(target => target.Ownership.RevitYear, StringComparer.OrdinalIgnoreCase))
        {
            var actual = group.Select(target => target.Ownership.ProfileId).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (group.Count() != expected.Count || !actual.SetEquals(expected))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Revit {group.Key} activation is not a complete add-in profile set.");
        }
    }

    private void AssertOwnedManifest(OwnedAddinManifest control)
    {
        ValidateOwnershipRecord(control);
        if (!File.Exists(control.ManifestPath))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Installer-owned Revit add-in manifest is missing: {control.ManifestPath}");
        if (!FileIntegrity.Sha256(control.ManifestPath).Equals(control.ManifestSha256, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Installer-owned Revit add-in manifest was modified and will not be replaced or removed: {control.ManifestPath}");
        var entries = ReadAddinEntries(control.ManifestPath);
        if (entries.Count != 1 || !EntryMatches(entries[0], control))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Installer-owned Revit add-in manifest identity changed and will not be replaced or removed: {control.ManifestPath}");
    }

    private void ValidateOwnershipRecord(OwnedAddinManifest control)
    {
        if (control.RevitYear.Length != 4 || !int.TryParse(control.RevitYear, out _))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Installed add-in ownership state contains an invalid Revit year.");
        ReleaseManifest.EnsureSafeBaseName(control.ProfileId, "installed add-in profile id");
        ReleaseManifest.EnsureSafeBaseName(control.ManifestFileName, "installed add-in manifest filename");
        if (!control.ManifestFileName.EndsWith(".addin", StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Installed add-in ownership state contains a non-.addin manifest filename.");
        var expectedPath = AddinManifestPath(control.RevitYear, control.ManifestFileName);
        if (!PathsEqual(expectedPath, control.ManifestPath))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Installed add-in ownership state contains an unexpected manifest path.");
        EnsureControlPathIsLocal(control.ManifestPath);
        if (!Guid.TryParse(control.AddInId, out _) || string.IsNullOrWhiteSpace(control.FullClassName))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Installed add-in ownership state contains an invalid identity.");
        var releasesPrefix = Path.GetFullPath(_context.ReleasesRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!Path.GetFullPath(control.AssemblyPath).StartsWith(releasesPrefix, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Installed add-in ownership state contains an assembly outside the releases root.");
        if (control.ManifestSha256.Length != 64 || control.ManifestSha256.Any(character => !Uri.IsHexDigit(character)))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Installed add-in ownership state contains an invalid manifest hash.");
    }

    private void EnsureControlPathIsLocal(string path)
    {
        var root = Path.GetFullPath(_context.AppData).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var full = Path.GetFullPath(path);
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Revit add-in control path escapes the per-user application-data root.");
        var relative = Path.GetRelativePath(root, full);
        var current = root;
        foreach (var part in relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            current = Path.Combine(current, part);
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new DeploymentException(ExitCodes.ValidationFailed, $"Revit add-in control path contains a link or reparse point: {current}");
        }
    }

    private static bool EntryMatches(AddinEntry entry, OwnedAddinManifest control)
        => entry.AddInId.Equals(Guid.Parse(control.AddInId).ToString("D"), StringComparison.OrdinalIgnoreCase)
           && entry.FullClassName.Equals(control.FullClassName, StringComparison.Ordinal)
           && PathsEqual(entry.Assembly, control.AssemblyPath);

    private static List<AddinEntry> ReadAddinEntries(string path)
    {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 128 * 1024 };
        using var stream = File.OpenRead(path);
        using var reader = XmlReader.Create(stream, settings);
        var document = XDocument.Load(reader, LoadOptions.None);
        if (document.Root?.Name.LocalName != "RevitAddIns") throw new InvalidDataException("Revit add-in manifest has an invalid root element.");
        return document.Root.Elements().Where(element => element.Name.LocalName == "AddIn").Select(element => new AddinEntry(
            RequiredElement(element, "Assembly"), RequiredElement(element, "FullClassName"), RequiredElement(element, "AddInId"))).ToList();

        static string RequiredElement(XElement parent, string name)
        {
            var values = parent.Elements().Where(element => element.Name.LocalName == name).ToList();
            if (values.Count != 1 || string.IsNullOrWhiteSpace(values[0].Value)) throw new InvalidDataException($"Revit add-in manifest requires exactly one {name} element.");
            return values[0].Value;
        }
    }

    private static List<string> ReadAddInIds(string path)
    {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 128 * 1024, ConformanceLevel = ConformanceLevel.Fragment };
        using var stream = File.OpenRead(path);
        using var reader = XmlReader.Create(stream, settings);
        var document = XDocument.Load(reader, LoadOptions.None);
        return document.Descendants().Where(element => element.Name.LocalName == "AddInId" && !string.IsNullOrWhiteSpace(element.Value))
            .Select(element => element.Value).ToList();
    }

    private static List<Exception> RestoreControlFiles(Dictionary<string, byte[]?> snapshot)
    {
        var failures = new List<Exception>();
        foreach (var pair in snapshot)
        {
            try
            {
                if (pair.Value == null)
                {
                    if (File.Exists(pair.Key)) File.Delete(pair.Key);
                    continue;
                }
                WriteAtomicBytes(pair.Key, pair.Value);
            }
            catch (Exception ex)
            {
                failures.Add(new IOException($"Failed to restore control file '{pair.Key}': {ex.Message}", ex));
            }
        }
        return failures;
    }

    private List<OwnedAddinManifest> ResolveCurrentOwnership(InstalledState? state)
    {
        if (state == null) return new List<OwnedAddinManifest>();
        var releaseRoot = Path.Combine(_context.ReleasesRoot, state.CurrentRelease);
        var manifestPath = Path.Combine(releaseRoot, "manifest.json");
        var manifest = ReleaseManifest.Load(manifestPath);
        var expectedForCurrentRelease = manifest.Components.Where(component => component.Kind == "revit-addin")
            .Select(component => BuildAddinControl(releaseRoot, manifest, component).Ownership).ToList();
        if (state.SchemaVersion == 1) return expectedForCurrentRelease;

        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var identities = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var control in state.OwnedAddinManifests)
        {
            ValidateOwnershipRecord(control);
            if (!paths.Add(Path.GetFullPath(control.ManifestPath)))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"Installed state repeats add-in manifest path '{control.ManifestPath}'.");
            if (!identities.Add($"{control.RevitYear}|{Guid.Parse(control.AddInId):D}"))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"Installed state repeats AddInId '{control.AddInId}' for Revit {control.RevitYear}.");
        }
        foreach (var expected in expectedForCurrentRelease)
        {
            var actual = state.OwnedAddinManifests.SingleOrDefault(control => PathsEqual(control.ManifestPath, expected.ManifestPath));
            if (actual == null || !actual.ManifestSha256.Equals(expected.ManifestSha256, StringComparison.OrdinalIgnoreCase) ||
                !actual.AddInId.Equals(expected.AddInId, StringComparison.OrdinalIgnoreCase) || !PathsEqual(actual.AssemblyPath, expected.AssemblyPath))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"Installed ownership state does not bind current release control '{expected.ManifestPath}'.");
        }
        return state.OwnedAddinManifests.Select(CloneOwnership).ToList();
    }

    private static OwnedAddinManifest CloneOwnership(OwnedAddinManifest source) => new()
    {
        RevitYear = source.RevitYear,
        ProfileId = source.ProfileId,
        ManifestPath = source.ManifestPath,
        ManifestFileName = source.ManifestFileName,
        AddInId = source.AddInId,
        FullClassName = source.FullClassName,
        AssemblyPath = source.AssemblyPath,
        ManifestSha256 = source.ManifestSha256
    };

    private void SaveSuccessfulState(string releaseVersion, List<OwnedAddinManifest> ownership)
    {
        var state = LoadState(required: false) ?? new InstalledState();
        state.SuccessfulReleases.RemoveAll(x => x.Equals(releaseVersion, StringComparison.OrdinalIgnoreCase));
        state.SuccessfulReleases.Add(releaseVersion);
        state.CurrentRelease = releaseVersion;
        state.UpdatedAtUtc = _context.UtcNow().ToString("O");
        state.SchemaVersion = 2;
        state.OwnedAddinManifests = ownership;
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
            var state = JsonSerializer.Deserialize<InstalledState>(File.ReadAllText(_context.StatePath), ReleaseManifest.JsonOptions)
                ?? throw new InvalidDataException("State was empty.");
            if (state.SchemaVersion is not (1 or 2)) throw new InvalidDataException($"Unsupported state schemaVersion {state.SchemaVersion}.");
            if (string.IsNullOrWhiteSpace(state.CurrentRelease)) throw new InvalidDataException("State currentRelease is missing.");
            if (state.SuccessfulReleases.Count == 0 || !state.SuccessfulReleases.Contains(state.CurrentRelease, StringComparer.OrdinalIgnoreCase))
                throw new InvalidDataException("State successfulReleases does not contain currentRelease.");
            ReleaseManifest.EnsureSafeBaseName(state.CurrentRelease, "state currentRelease");
            var releases = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var release in state.SuccessfulReleases)
            {
                ReleaseManifest.EnsureSafeBaseName(release, "state successful release");
                if (!releases.Add(release)) throw new InvalidDataException($"State repeats successful release '{release}'.");
            }
            return state;
        }
        catch (Exception ex) { throw new DeploymentException(ExitCodes.ValidationFailed, $"Installed state is invalid: {ex.Message}", ex); }
    }

    private void SaveState(InstalledState state)
        => WriteAtomic(_context.StatePath, JsonSerializer.Serialize(state, ReleaseManifest.JsonOptions));

    private static void WriteAtomic(string path, string contents)
        => WriteAtomicBytes(path, new UTF8Encoding(false).GetBytes(contents));

    private static void WriteAtomicBytes(string path, byte[] contents)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + $".tmp-{Guid.NewGuid():N}";
        try
        {
            File.WriteAllBytes(temp, contents);
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private void ValidateActivatedRelease(string releaseRoot, ReleaseManifest manifest, IReadOnlyCollection<ReleaseComponent> components, ActivationResult activation)
    {
        var validation = ValidateInstalledRelease(releaseRoot, manifest, components, includeNetwork: false);
        if (!validation.Ok) throw new DeploymentException(ExitCodes.ValidationFailed, validation.Message);
        foreach (var control in activation.Ownership) AssertOwnedManifest(control);
        foreach (var control in activation.Obsolete)
        {
            if (File.Exists(control.ManifestPath))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"Obsolete installer-owned Revit add-in manifest is still present: {control.ManifestPath}");
        }
    }

    private static Exception PreserveOriginalFailure(Exception original, IReadOnlyCollection<Exception> recoveryFailures)
    {
        if (recoveryFailures.Count == 0) return original;
        var aggregate = new AggregateException(new[] { original }.Concat(recoveryFailures));
        var message = $"{original.Message} Recovery also reported {recoveryFailures.Count} failure(s): {string.Join(" | ", recoveryFailures.Select(failure => failure.Message))}";
        return original is DeploymentException deployment
            ? new DeploymentException(deployment.ExitCode, message, aggregate)
            : new DeploymentException(ExitCodes.InstallFailed, message, aggregate);
    }

    private static string DesktopCommand(string script)
        => $"@echo off\r\n\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"{script}\" %*\r\n";

    private void ValidateDesktopControls(string releaseRoot, ReleaseComponent desktop, OperationResult result)
    {
        var expectedCommand = DesktopCommand(Path.Combine(releaseRoot, desktop.Id, "scripts", "launch_operator_desktop.ps1"));
        ValidateCommandWrapper(_context.StableDesktopLauncherPath, expectedCommand, "stable Operator Desktop command wrapper");
        if (string.IsNullOrWhiteSpace(_context.Desktop))
        {
            result.Warnings.Add("The Windows Desktop folder is unavailable; no desktop command or shortcut could be validated.");
            return;
        }

        ValidateCommandWrapper(_context.DesktopCommandPath, expectedCommand, "desktop Operator Desktop command wrapper");
        if (!_context.DesktopShortcuts.IsSupported)
        {
            result.Warnings.Add("Windows shortcut management is unavailable; Operator Desktop.lnk could not be validated.");
            return;
        }

        var shortcut = _context.DesktopShortcuts.Read(_context.DesktopShortcutPath)
            ?? throw new DeploymentException(ExitCodes.ValidationFailed, $"Operator Desktop shortcut is missing: {_context.DesktopShortcutPath}");
        if (!PathsEqual(shortcut.TargetPath, _context.StableDesktopLauncherPath))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Operator Desktop shortcut target is stale or unmanaged.");
        if (!string.IsNullOrWhiteSpace(shortcut.Arguments))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Operator Desktop shortcut contains unmanaged arguments.");
        if (!PathsEqual(shortcut.WorkingDirectory, _context.ProductRoot))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Operator Desktop shortcut working directory is stale or unmanaged.");
        EnsureManagedDesktopLauncherOverride();
    }

    private static void ValidateCommandWrapper(string path, string expected, string label)
    {
        if (!File.Exists(path)) throw new DeploymentException(ExitCodes.ValidationFailed, $"The {label} is missing: {path}");
        if (!File.ReadAllText(path).Equals(expected, StringComparison.Ordinal))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"The {label} is stale or unmanaged: {path}");
    }

    private void EnsureManagedDesktopLauncherOverride()
    {
        var status = DescribeLauncherOverride();
        if (status == "unset" || status == "managed") return;
        throw new DeploymentException(
            ExitCodes.ValidationFailed,
            $"OPERATOR_DESKTOP_LAUNCHER_PATH is {status} and would bypass the managed Operator Desktop launcher. Point it to %LOCALAPPDATA%\\RevitOperator\\Operator Desktop.cmd or remove the override, then retry; OperatorDeploy did not change the environment.");
    }

    private void WriteDesktopControlDiagnostics(TextWriter writer, string launcherOverrideStatus)
    {
        writer.WriteLine($"OperatorDesktopStableCommand={(File.Exists(_context.StableDesktopLauncherPath) ? "present" : "missing")}");
        writer.WriteLine($"OperatorDesktopLauncherOverride={launcherOverrideStatus}");
        if (string.IsNullOrWhiteSpace(_context.Desktop))
        {
            writer.WriteLine("OperatorDesktopShortcut=desktop-unavailable");
            return;
        }
        if (!_context.DesktopShortcuts.IsSupported)
        {
            writer.WriteLine("OperatorDesktopShortcut=unsupported");
            return;
        }
        try
        {
            var shortcut = _context.DesktopShortcuts.Read(_context.DesktopShortcutPath);
            if (shortcut == null) writer.WriteLine("OperatorDesktopShortcut=missing");
            else writer.WriteLine(
                $"OperatorDesktopShortcut={(PathsEqual(shortcut.TargetPath, _context.StableDesktopLauncherPath) ? "managed" : "stale")};" +
                $"Arguments={(string.IsNullOrWhiteSpace(shortcut.Arguments) ? "none" : "present")};" +
                $"WorkingDirectory={(PathsEqual(shortcut.WorkingDirectory, _context.ProductRoot) ? "managed" : "stale")}");
        }
        catch (Exception ex)
        {
            writer.WriteLine($"OperatorDesktopShortcut=unreadable;Error={ex.GetType().Name}");
        }
    }

    private string DescribeLauncherOverride()
    {
        var value = _context.GetEnvironmentVariable("OPERATOR_DESKTOP_LAUNCHER_PATH");
        if (string.IsNullOrWhiteSpace(value)) return "unset";
        try
        {
            var resolved = Path.GetFullPath(value.Trim().Trim('"'));
            return PathsEqual(resolved, _context.StableDesktopLauncherPath) ? "managed" : "conflict";
        }
        catch { return "invalid"; }
    }

    private static bool PathsEqual(string left, string right)
    {
        try
        {
            return Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                .Equals(Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
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

    private sealed record AddinControl(string Xml, OwnedAddinManifest Ownership);
    private sealed record AddinEntry(string Assembly, string FullClassName, string AddInId);
    private sealed record PlannedActivation(List<AddinControl> Targets, List<OwnedAddinManifest> Obsolete, List<OwnedAddinManifest> Retained);
    private sealed record ActivationResult(List<OwnedAddinManifest> Ownership, List<OwnedAddinManifest> Obsolete);
}

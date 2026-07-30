using System.IO.Compression;
using System.Net;
using System.Security;
using System.Security.Cryptography;
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
            RecoverPendingActivationJournal();
            if (_options.HasAnySafeReadAdmissionInput &&
                _options.Operation is not ("install" or "update" or "repair") &&
                !(_options.Operation == "validate" && _options.BundleOnly))
                throw new DeploymentException(ExitCodes.InvalidArguments, "SafeRead admission inputs are valid only for install, update, repair, or validate --bundle-only.");
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
        var finalReleaseRoot = Path.Combine(_context.ReleasesRoot, manifest.ReleaseVersion);
        var safeReadAdmission = SafeReadAdmissionVerifier.PrepareExternal(
            _context,
            _options,
            manifestPath,
            manifest,
            finalReleaseRoot);
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
        var installedManifest = CopyManifestWithComponents(manifest, applicable);
        var stateSnapshot = LoadStateSnapshot(required: false);
        var stateBefore = stateSnapshot.State;
        var currentOwnership = ResolveCurrentOwnership(stateBefore);
        _ = PlanActivation(finalReleaseRoot, installedManifest, applicable, currentOwnership, requireAssembly: false);
        if (_options.DryRun)
        {
            return result;
        }

        Directory.CreateDirectory(_context.ReleasesRoot);
        Directory.CreateDirectory(_context.DeploymentRoot);
        var transactionId = Guid.NewGuid().ToString("D").ToLowerInvariant();
        var transactionSuffix = transactionId.Replace("-", "", StringComparison.Ordinal);
        var stagingRoot = Path.Combine(_context.ReleasesRoot, $".{manifest.ReleaseVersion}.staging-{transactionSuffix}");
        var displacedRoot = Path.Combine(_context.ReleasesRoot, $".{manifest.ReleaseVersion}.replaced-{transactionSuffix}");
        var failedRoot = Path.Combine(_context.ReleasesRoot, $".{manifest.ReleaseVersion}.failed-{transactionSuffix}");
        ActivationJournal? activationJournal = null;

        try
        {
            StageRelease(bundleRoot, manifestPath, stagingRoot, installedManifest, applicable, safeReadAdmission);
            VerifyInstalledTree(stagingRoot, installedManifest, applicable);
            SafeReadAdmissionVerifier.VerifyCandidate(
                _context,
                stagingRoot,
                finalReleaseRoot,
                installedManifest,
                safeReadAdmission?.Binding,
                safeReadAdmission?.ReceiptBytes);

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
                    SafeReadAdmissionVerifier.VerifyCandidate(
                        _context,
                        finalReleaseRoot,
                        finalReleaseRoot,
                        existingManifest,
                        safeReadAdmission?.Binding,
                        safeReadAdmission?.ReceiptBytes);
                    var plan = PlanActivation(finalReleaseRoot, existingManifest, applicable, currentOwnership, requireAssembly: true);
                    var auxiliary = PrepareAuxiliaryControls(finalReleaseRoot, applicable);
                    var journal = BeginActivationJournal(plan, auxiliary, stateSnapshot, safeReadAdmission: safeReadAdmission?.Binding);
                    var activation = ActivateRelease(finalReleaseRoot, existingManifest, applicable, plan, auxiliary, journal);
                    ValidateActivatedRelease(finalReleaseRoot, existingManifest, existingManifest.Components, activation, safeReadAdmission?.Binding);
                    SaveSuccessfulState(manifest.ReleaseVersion, activation.Ownership, safeReadAdmission?.Binding, journal);
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
                WriteStagedManifest(Path.Combine(stagingRoot, "manifest.json"), manifestPath, installedManifest);
                VerifyInstalledTree(stagingRoot, installedManifest, installedManifest.Components);
                SafeReadAdmissionVerifier.VerifyCandidate(
                    _context,
                    stagingRoot,
                    finalReleaseRoot,
                    installedManifest,
                    safeReadAdmission?.Binding,
                    safeReadAdmission?.ReceiptBytes);

            }

            var completedPlan = PlanActivation(finalReleaseRoot, installedManifest, applicable, currentOwnership, requireAssembly: false);
            var completedAuxiliary = PrepareAuxiliaryControls(finalReleaseRoot, applicable);
            var releaseRootSwap = PrepareReleaseRootSwap(finalReleaseRoot, stagingRoot, displacedRoot, failedRoot);
            activationJournal = BeginActivationJournal(
                completedPlan,
                completedAuxiliary,
                stateSnapshot,
                releaseRootSwap,
                transactionId,
                safeReadAdmission?.Binding);
            _context.ActivationCheckpoint("before-release-root-displacement");
            if (Directory.Exists(finalReleaseRoot))
            {
                Directory.Move(finalReleaseRoot, displacedRoot);
            }
            _context.ActivationCheckpoint("after-release-root-displacement");
            Directory.Move(stagingRoot, finalReleaseRoot);
            _context.ActivationCheckpoint("after-release-root-placement");
            _context.ActivationCheckpoint("before-legacy-activation-journal-boundary");
            AssertReleaseRootMatches(finalReleaseRoot, releaseRootSwap.AfterTreeSha256, "promoted release root");
            SafeReadAdmissionVerifier.VerifyCandidate(
                _context,
                finalReleaseRoot,
                finalReleaseRoot,
                installedManifest,
                safeReadAdmission?.Binding,
                safeReadAdmission?.ReceiptBytes);
            var completedActivation = ActivateRelease(finalReleaseRoot, installedManifest, applicable, completedPlan, completedAuxiliary, activationJournal);
            ValidateActivatedRelease(finalReleaseRoot, installedManifest, installedManifest.Components, completedActivation, safeReadAdmission?.Binding);
            SaveSuccessfulState(manifest.ReleaseVersion, completedActivation.Ownership, safeReadAdmission?.Binding, activationJournal);
            if (releaseRootSwap.BeforeExists) result.Warnings.Add($"The replaced release was retained for recovery at {displacedRoot}.");
            return result;
        }
        catch (Exception original)
        {
            var recoveryFailures = TryRecoverPendingActivationJournal();
            if (activationJournal == null)
            {
                try
                {
                    if (Directory.Exists(stagingRoot)) Directory.Delete(stagingRoot, recursive: true);
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
            var finalReleaseRoot = Path.Combine(_context.ReleasesRoot, manifest.ReleaseVersion);
            _ = SafeReadAdmissionVerifier.PrepareExternal(_context, _options, manifestPath, manifest, finalReleaseRoot);
            return new OperationResult { Ok = true, Operation = "validate", ExitCode = 0, ReleaseVersion = manifest.ReleaseVersion, Message = "Release manifest and bundled payload hashes are valid." };
        }

        if (_options.HasAnySafeReadAdmissionInput)
            throw new DeploymentException(ExitCodes.InvalidArguments, "Installed validation uses the durable pinned admission state; external admission inputs are valid only with --bundle-only.");
        var stateSnapshot = LoadStateSnapshot(required: true);
        var state = stateSnapshot.State!;
        var releaseRoot = Path.Combine(_context.ReleasesRoot, state.CurrentRelease);
        var manifestPathInstalled = Path.Combine(releaseRoot, "manifest.json");
        var manifestInstalled = ReleaseManifest.Load(manifestPathInstalled);
        var safeReadAdmission = AdmissionForRelease(state, state.CurrentRelease, manifestInstalled);
        SafeReadAdmissionVerifier.VerifyCandidate(_context, releaseRoot, releaseRoot, manifestInstalled, safeReadAdmission);
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
        if (_options.RevitVersion != null)
            throw new DeploymentException(ExitCodes.InvalidArguments, "--revit-version is not supported for rollback while installed state uses one global currentRelease. Run an unfiltered rollback.");
        if (_context.IsRevitRunning()) throw new DeploymentException(ExitCodes.BlockedProcess, "Revit is running. Close every Revit window before rollback.");
        var stateSnapshot = LoadStateSnapshot(required: true);
        var state = stateSnapshot.State!;
        var target = state.SuccessfulReleases.LastOrDefault(x => !x.Equals(state.CurrentRelease, StringComparison.OrdinalIgnoreCase));
        if (target == null) throw new DeploymentException(ExitCodes.RollbackFailed, "No previous successful release is available for rollback.");
        var releaseRoot = Path.Combine(_context.ReleasesRoot, target);
        var manifest = ReleaseManifest.Load(Path.Combine(releaseRoot, "manifest.json"));
        var components = ApplicableComponents(manifest).ToList();
        var safeReadAdmission = AdmissionForRelease(state, target, manifest);
        if (components.Any(component => component.Kind == "operator-desktop")) EnsureManagedDesktopLauncherOverride();
        VerifyInstalledTree(releaseRoot, manifest, components);
        SafeReadAdmissionVerifier.VerifyCandidate(_context, releaseRoot, releaseRoot, manifest, safeReadAdmission);
        var currentOwnership = ResolveCurrentOwnership(state);
        var plan = PlanActivation(releaseRoot, manifest, components, currentOwnership, requireAssembly: true);
        if (_options.DryRun)
            return new OperationResult { Ok = true, Operation = "rollback", ExitCode = 0, ReleaseVersion = target, Message = $"Rollback target {target} is valid; no files were changed." };

        try
        {
            var auxiliary = PrepareAuxiliaryControls(releaseRoot, components);
            var journal = BeginActivationJournal(plan, auxiliary, stateSnapshot, safeReadAdmission: safeReadAdmission);
            var activation = ActivateRelease(releaseRoot, manifest, components, plan, auxiliary, journal);
            ValidateActivatedRelease(releaseRoot, manifest, components, activation, safeReadAdmission);
            state.CurrentRelease = target;
            state.UpdatedAtUtc = _context.UtcNow().ToString("O");
            state.SchemaVersion = 3;
            state.OwnedAddinManifests = activation.Ownership;
            SaveState(state, journal);
        }
        catch (Exception original)
        {
            var restoreFailures = TryRecoverPendingActivationJournal();
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

    private void StageRelease(
        string bundleRoot,
        string sourceManifestPath,
        string stagingRoot,
        ReleaseManifest manifest,
        IReadOnlyCollection<ReleaseComponent> components,
        PreparedSafeReadAdmission? safeReadAdmission)
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
        WriteStagedManifest(Path.Combine(stagingRoot, "manifest.json"), sourceManifestPath, manifest);
        if (safeReadAdmission != null)
        {
            var receiptPath = FileIntegrity.ResolveUnder(
                stagingRoot,
                SafeReadAdmissionContracts.PersistedReceiptRelativePath,
                ExitCodes.ValidationFailed);
            Directory.CreateDirectory(Path.GetDirectoryName(receiptPath)!);
            using var stream = new FileStream(receiptPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            stream.Write(safeReadAdmission.ReceiptBytes);
            stream.Flush(flushToDisk: true);
        }
        Log($"Staged release {manifest.ReleaseVersion} at {stagingRoot}.");
    }

    private static void WriteStagedManifest(string destination, string sourceManifestPath, ReleaseManifest manifest)
    {
        if (manifest.SchemaVersion == 3)
        {
            File.Copy(sourceManifestPath, destination, overwrite: true);
            return;
        }
        File.WriteAllText(destination, JsonSerializer.Serialize(manifest, ReleaseManifest.JsonOptions));
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
            SafeReadAdmission = source.SafeReadAdmission,
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
        if (existing.SchemaVersion is 2 or 3)
        {
            var existingProfiles = JsonSerializer.Serialize(existing.RevitAddinProfiles.OrderBy(profile => profile.Id), ReleaseManifest.JsonOptions);
            var incomingProfiles = JsonSerializer.Serialize(incoming.RevitAddinProfiles.OrderBy(profile => profile.Id), ReleaseManifest.JsonOptions);
            if (!existingProfiles.Equals(incomingProfiles, StringComparison.Ordinal))
                throw new DeploymentException(ExitCodes.ManifestInvalid, $"Release {incoming.ReleaseVersion} already exists with different Revit add-in profiles.");
            if (existing.SchemaVersion == 3)
            {
                var existingAdmission = JsonSerializer.Serialize(existing.SafeReadAdmission, ReleaseManifest.JsonOptions);
                var incomingAdmission = JsonSerializer.Serialize(incoming.SafeReadAdmission, ReleaseManifest.JsonOptions);
                if (!existingAdmission.Equals(incomingAdmission, StringComparison.Ordinal))
                    throw new DeploymentException(ExitCodes.ManifestInvalid, $"Release {incoming.ReleaseVersion} already exists with different SafeRead admission layout metadata.");
            }
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
        PlannedActivation plan,
        IReadOnlyCollection<PreparedAuxiliaryControl> auxiliary,
        ActivationJournal journal)
    {
        foreach (var target in plan.Targets)
        {
            ApplyJournaledWrite(journal, target.Ownership.ManifestPath, new UTF8Encoding(false).GetBytes(target.Xml));
            _context.ActivationCheckpoint($"after-target:{target.Ownership.RevitYear}:{target.Ownership.ProfileId}");
        }
        foreach (var control in plan.Obsolete)
        {
            ApplyJournaledDelete(journal, control.ManifestPath);
            _context.ActivationCheckpoint($"after-obsolete:{control.RevitYear}:{control.ProfileId}");
        }

        foreach (var control in auxiliary)
            ApplyJournaledWrite(journal, control.Path, control.Contents);

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
        var previousTargets = currentOwnership.Where(control => targetPaths.Contains(control.ManifestPath))
            .ToDictionary(control => Path.GetFullPath(control.ManifestPath), CloneOwnership, StringComparer.OrdinalIgnoreCase);

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
        return new PlannedActivation(targets, obsolete, retained, previousTargets);
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

    private List<PreparedAuxiliaryControl> PrepareAuxiliaryControls(
        string releaseRoot,
        IReadOnlyCollection<ReleaseComponent> components)
    {
        var controls = new List<PreparedAuxiliaryControl>();
        var desktop = components.FirstOrDefault(component => component.Kind == "operator-desktop");
        if (desktop == null) return controls;
        EnsureManagedDesktopLauncherOverride();
        EnsurePathContainsNoReparsePoint(_context.LocalAppData, _context.StableDesktopLauncherPath, "Operator Desktop control");
        var script = Path.Combine(releaseRoot, desktop.Id, "scripts", "launch_operator_desktop.ps1");
        var command = new UTF8Encoding(false).GetBytes(DesktopCommand(script));
        controls.Add(new PreparedAuxiliaryControl(_context.StableDesktopLauncherPath, command));
        if (!string.IsNullOrWhiteSpace(_context.Desktop))
        {
            EnsurePathContainsNoReparsePoint(_context.Desktop, _context.DesktopCommandPath, "Operator Desktop control");
            EnsurePathContainsNoReparsePoint(_context.Desktop, _context.DesktopShortcutPath, "Operator Desktop control");
            controls.Add(new PreparedAuxiliaryControl(_context.DesktopCommandPath, command));
            if (_context.DesktopShortcuts.IsSupported)
            {
                var temporaryShortcut = _context.DesktopShortcutPath + $".prepare-{Guid.NewGuid():N}.lnk";
                try
                {
                    _context.DesktopShortcuts.CreateOrUpdate(
                        temporaryShortcut,
                        new DesktopShortcutInfo(_context.StableDesktopLauncherPath, "", _context.ProductRoot));
                    var prepared = _context.DesktopShortcuts.Read(temporaryShortcut)
                        ?? throw new DeploymentException(ExitCodes.ValidationFailed, "Operator Desktop shortcut preparation did not create a readable shortcut.");
                    if (!PathsEqual(prepared.TargetPath, _context.StableDesktopLauncherPath) ||
                        !string.IsNullOrWhiteSpace(prepared.Arguments) ||
                        !PathsEqual(prepared.WorkingDirectory, _context.ProductRoot))
                        throw new DeploymentException(ExitCodes.ValidationFailed, "Operator Desktop shortcut preparation produced unmanaged shortcut fields.");
                    controls.Add(new PreparedAuxiliaryControl(_context.DesktopShortcutPath, File.ReadAllBytes(temporaryShortcut)));
                }
                finally
                {
                    if (File.Exists(temporaryShortcut)) File.Delete(temporaryShortcut);
                }
            }
        }
        return controls;
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

    internal static string BuildAddinXml(RevitAddinProfile profile, string assembly)
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

    internal static byte[] BuildAddinXmlBytes(RevitAddinProfile profile, string assembly)
        => new UTF8Encoding(false).GetBytes(BuildAddinXml(profile, assembly));

    private static void EnsureCompleteActivationSelection(ReleaseManifest manifest, IReadOnlyCollection<AddinControl> targets)
    {
        if (manifest.SchemaVersion is not (2 or 3) || targets.Count == 0) return;
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
        EnsurePathContainsNoReparsePoint(root, full, "Revit add-in control");
    }

    private void EnsurePathContainsNoReparsePoint(string allowedRoot, string path, string label)
    {
        var root = Path.GetFullPath(allowedRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var full = Path.GetFullPath(path);
        if (!full.Equals(root, StringComparison.OrdinalIgnoreCase) &&
            !full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} path escapes its managed root.");
        var relative = Path.GetRelativePath(root, full);
        var current = root;
        if (_context.IsReparsePoint(current))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} path contains a link or reparse point: {current}");
        foreach (var part in relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (part == ".") continue;
            current = Path.Combine(current, part);
            if (_context.IsReparsePoint(current))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} path contains a link or reparse point: {current}");
        }
    }

    private void EnsureReleaseTransactionPath(string path, string label)
    {
        var releasesRoot = Path.GetFullPath(_context.ReleasesRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var relative = Path.GetRelativePath(releasesRoot, full);
        if (relative == "." || relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Length != 1)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} must be one direct child of the managed releases root.");
        EnsurePathContainsNoReparsePoint(releasesRoot, full, label);
    }

    private string ReleaseTreeSha256(string root)
    {
        EnsureReleaseTransactionPath(root, "release root");
        if (!Directory.Exists(root))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Release root is missing: {root}");

        var rootFull = Path.GetFullPath(root);
        var pending = new Stack<string>();
        var files = new List<string>();
        pending.Push(rootFull);
        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            if (_context.IsReparsePoint(directory))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"Release root contains a link or reparse point: {directory}");
            foreach (var child in Directory.EnumerateDirectories(directory, "*", SearchOption.TopDirectoryOnly))
            {
                if (_context.IsReparsePoint(child))
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"Release root contains a link or reparse point: {child}");
                pending.Push(child);
            }
            foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.TopDirectoryOnly))
            {
                if (_context.IsReparsePoint(file))
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"Release root contains a link or reparse point: {file}");
                files.Add(file);
                if (files.Count > 100_000)
                    throw new DeploymentException(ExitCodes.ValidationFailed, "Release root contains too many files to fingerprint safely.");
            }
        }

        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in files.OrderBy(path => Path.GetRelativePath(rootFull, path), StringComparer.Ordinal))
        {
            var relative = Path.GetRelativePath(rootFull, file).Replace(Path.DirectorySeparatorChar, '/');
            if (relative.Length > 4096)
                throw new DeploymentException(ExitCodes.ValidationFailed, "Release root contains an excessively long relative path.");
            var record = $"{relative}\0{new FileInfo(file).Length}\0{FileIntegrity.Sha256(file)}\n";
            digest.AppendData(Encoding.UTF8.GetBytes(record));
        }
        return Convert.ToHexString(digest.GetHashAndReset());
    }

    private void AssertReleaseRootMatches(string path, string expectedSha256, string label)
    {
        if (!Directory.Exists(path) ||
            !ReleaseTreeSha256(path).Equals(expectedSha256, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"{label} does not match its durable release-tree fingerprint.");
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

    private ActivationJournalReleaseRootSwap PrepareReleaseRootSwap(
        string finalPath,
        string stagingPath,
        string displacedPath,
        string failedPath)
    {
        EnsureReleaseTransactionPath(finalPath, "final release root");
        EnsureReleaseTransactionPath(stagingPath, "staging release root");
        EnsureReleaseTransactionPath(displacedPath, "displaced release root");
        EnsureReleaseTransactionPath(failedPath, "failed release root");
        if (File.Exists(finalPath))
            throw new DeploymentException(ExitCodes.ValidationFailed, "The final release-root slot contains a foreign file and remains untouched.");
        if (!Directory.Exists(stagingPath))
            throw new DeploymentException(ExitCodes.ValidationFailed, "The staged release root disappeared before durable activation preparation.");
        if (Directory.Exists(displacedPath) || File.Exists(displacedPath) ||
            Directory.Exists(failedPath) || File.Exists(failedPath))
            throw new DeploymentException(ExitCodes.ValidationFailed, "A release-root transaction path already exists and remains untouched.");
        return new ActivationJournalReleaseRootSwap
        {
            FinalPath = Path.GetFullPath(finalPath),
            StagingPath = Path.GetFullPath(stagingPath),
            DisplacedPath = Path.GetFullPath(displacedPath),
            FailedPath = Path.GetFullPath(failedPath),
            BeforeExists = Directory.Exists(finalPath),
            BeforeTreeSha256 = Directory.Exists(finalPath) ? ReleaseTreeSha256(finalPath) : null,
            AfterTreeSha256 = ReleaseTreeSha256(stagingPath)
        };
    }

    private ActivationJournal BeginActivationJournal(
        PlannedActivation plan,
        IReadOnlyCollection<PreparedAuxiliaryControl> auxiliary,
        StateSnapshot stateSnapshot,
        ActivationJournalReleaseRootSwap? releaseRootSwap = null,
        string? transactionId = null,
        InstalledSafeReadAdmission? safeReadAdmission = null)
    {
        EnsureNoQuarantinedActivationJournal();
        if (File.Exists(_context.ActivationJournalPath))
            throw new DeploymentException(ExitCodes.ValidationFailed, "A pending activation journal must be recovered before starting another deployment.");
        EnsurePathContainsNoReparsePoint(_context.LocalAppData, _context.ActivationJournalPath, "Activation journal");
        EnsurePathContainsNoReparsePoint(_context.LocalAppData, _context.StatePath, "Deployment state");

        var controls = new List<ActivationJournalControl>();
        foreach (var target in plan.Targets)
        {
            EnsureControlPathIsLocal(target.Ownership.ManifestPath);
            plan.PreviousTargets.TryGetValue(Path.GetFullPath(target.Ownership.ManifestPath), out var previous);
            if (File.Exists(target.Ownership.ManifestPath))
            {
                if (previous == null)
                    throw new DeploymentException(ExitCodes.ValidationFailed, $"Refusing to snapshot or replace unowned Revit add-in manifest: {target.Ownership.ManifestPath}");
                AssertOwnedManifest(previous);
            }
            var beforeExists = File.Exists(target.Ownership.ManifestPath);
            if (beforeExists && previous == null)
                throw new DeploymentException(ExitCodes.ValidationFailed, $"Refusing to snapshot or replace an unowned Revit add-in manifest that appeared during journal preparation: {target.Ownership.ManifestPath}");
            controls.Add(CreateJournalControl("addin", target.Ownership.ManifestPath, true, target.Ownership.ManifestSha256,
                beforeExists, beforeExists ? previous!.ManifestSha256 : null));
        }
        foreach (var obsolete in plan.Obsolete)
        {
            AssertOwnedManifest(obsolete);
            controls.Add(CreateJournalControl("addin", obsolete.ManifestPath, false, null, true, obsolete.ManifestSha256));
        }
        foreach (var control in auxiliary)
        {
            var isDesktopControl = PathsEqual(control.Path, _context.DesktopCommandPath) || PathsEqual(control.Path, _context.DesktopShortcutPath);
            EnsurePathContainsNoReparsePoint(
                isDesktopControl ? _context.Desktop : _context.LocalAppData,
                control.Path,
                "Operator Desktop control");
            controls.Add(CreateJournalControl("auxiliary", control.Path, true, FileIntegrity.Sha256(control.Contents)));
        }
        controls.Add(CreateJournalControl("state", _context.StatePath, stateSnapshot.State != null, stateSnapshot.Sha256,
            stateSnapshot.State != null, stateSnapshot.Sha256));

        var duplicate = controls.GroupBy(control => Path.GetFullPath(control.Path), StringComparer.OrdinalIgnoreCase).FirstOrDefault(group => group.Count() != 1);
        if (duplicate != null)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Activation journal repeats control path '{duplicate.Key}'.");
        var journal = new ActivationJournal
        {
            TransactionId = transactionId ?? Guid.NewGuid().ToString("D").ToLowerInvariant(),
            Operation = _options.Operation,
            CreatedAtUtc = _context.UtcNow().ToString("O"),
            Controls = controls,
            ReleaseRootSwap = releaseRootSwap,
            SafeReadAdmission = safeReadAdmission == null ? null : SafeReadAdmissionVerifier.Clone(safeReadAdmission)
        };
        PersistActivationJournal(journal);
        _context.ActivationCheckpoint("journal-prepared");
        return journal;
    }

    private static ActivationJournalControl CreateJournalControl(string kind, string path, bool afterExists, string? afterSha256)
    {
        var fullPath = Path.GetFullPath(path);
        byte[]? before = File.Exists(fullPath) ? File.ReadAllBytes(fullPath) : null;
        return new ActivationJournalControl
        {
            Kind = kind,
            Path = fullPath,
            BeforeExists = before != null,
            BeforeSha256 = before == null ? null : FileIntegrity.Sha256(before),
            BeforeBase64 = before == null ? null : Convert.ToBase64String(before),
            AfterExists = afterExists,
            AfterSha256 = afterSha256
        };
    }

    private static ActivationJournalControl CreateJournalControl(
        string kind,
        string path,
        bool afterExists,
        string? afterSha256,
        bool expectedBeforeExists,
        string? expectedBeforeSha256)
    {
        var control = CreateJournalControl(kind, path, afterExists, afterSha256);
        if (control.BeforeExists != expectedBeforeExists ||
            (expectedBeforeExists && !control.BeforeSha256!.Equals(expectedBeforeSha256, StringComparison.OrdinalIgnoreCase)))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Control changed while activation journal was being prepared and remains untouched: {path}");
        return control;
    }

    private void ApplyJournaledWrite(ActivationJournal journal, string path, byte[] contents)
    {
        var control = JournalControl(journal, path);
        var intended = FileIntegrity.Sha256(contents);
        if (!control.AfterExists || !intended.Equals(control.AfterSha256, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Activation journal does not authorize the intended write: {path}");
        CasWrite(control.Path, contents, control.BeforeExists, control.BeforeSha256);
    }

    private void ApplyJournaledDelete(ActivationJournal journal, string path)
    {
        var control = JournalControl(journal, path);
        if (control.AfterExists)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Activation journal does not authorize deletion: {path}");
        CasDelete(control.Path, control.BeforeExists, control.BeforeSha256);
    }

    private static ActivationJournalControl JournalControl(ActivationJournal journal, string path)
    {
        var full = Path.GetFullPath(path);
        return journal.Controls.SingleOrDefault(control => PathsEqual(control.Path, full))
            ?? throw new DeploymentException(ExitCodes.ValidationFailed, $"Activation journal does not contain control path '{full}'.");
    }

    private static void CasWrite(string path, byte[] contents, bool expectedExists, string? expectedSha256)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + $".tmp-{Guid.NewGuid():N}";
        var displaced = path + $".displaced-{Guid.NewGuid():N}";
        var preserveDisplaced = false;
        try
        {
            WriteDurableFile(temp, contents);
            if (!expectedExists)
            {
                if (File.Exists(path)) throw new IOException($"Control appeared after activation preflight and remains foreign: {path}");
                File.Move(temp, path, overwrite: false);
                return;
            }
            if (!File.Exists(path) || !FileIntegrity.Sha256(path).Equals(expectedSha256, StringComparison.OrdinalIgnoreCase))
                throw new IOException($"Control changed after activation preflight and remains foreign: {path}");
            File.Replace(temp, path, displaced, ignoreMetadataErrors: false);
            if (!FileIntegrity.Sha256(displaced).Equals(expectedSha256, StringComparison.OrdinalIgnoreCase))
            {
                if (File.Exists(path) && FileIntegrity.Sha256(path).Equals(FileIntegrity.Sha256(contents), StringComparison.OrdinalIgnoreCase))
                {
                    try { File.Replace(displaced, path, null, ignoreMetadataErrors: false); }
                    catch { preserveDisplaced = true; throw; }
                }
                else
                    preserveDisplaced = true;
                throw new IOException($"Control changed during activation CAS and was not accepted: {path}");
            }
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
            if (!preserveDisplaced && File.Exists(displaced)) File.Delete(displaced);
        }
    }

    private static void CasDelete(string path, bool expectedExists, string? expectedSha256)
    {
        if (!expectedExists)
        {
            if (File.Exists(path)) throw new IOException($"Foreign control appeared where absence was required: {path}");
            return;
        }
        if (!File.Exists(path) || !FileIntegrity.Sha256(path).Equals(expectedSha256, StringComparison.OrdinalIgnoreCase))
            throw new IOException($"Control changed before activation deletion and remains foreign: {path}");
        var removed = path + $".removed-{Guid.NewGuid():N}";
        var preserveRemoved = false;
        File.Move(path, removed, overwrite: false);
        try
        {
            if (!FileIntegrity.Sha256(removed).Equals(expectedSha256, StringComparison.OrdinalIgnoreCase))
            {
                if (!File.Exists(path))
                {
                    try { File.Move(removed, path, overwrite: false); }
                    catch { preserveRemoved = true; throw; }
                }
                else preserveRemoved = true;
                throw new IOException($"Control changed during activation deletion and was preserved: {path}");
            }
        }
        finally
        {
            if (!preserveRemoved && File.Exists(removed)) File.Delete(removed);
        }
    }

    private void PersistActivationJournal(ActivationJournal journal)
    {
        ValidateActivationJournal(journal);
        var bytes = new UTF8Encoding(false).GetBytes(JsonSerializer.Serialize(journal, ReleaseManifest.JsonOptions));
        WriteDurableAtomic(_context.ActivationJournalPath, bytes);
    }

    private void RetireActivationJournal(string expectedSha256)
    {
        CasDelete(_context.ActivationJournalPath, expectedExists: true, expectedSha256: expectedSha256);
    }

    private List<Exception> TryRecoverPendingActivationJournal()
    {
        try
        {
            RecoverPendingActivationJournal();
            return new List<Exception>();
        }
        catch (Exception ex)
        {
            return new List<Exception> { ex };
        }
    }

    private void RecoverPendingActivationJournal()
    {
        EnsureNoQuarantinedActivationJournal();
        if (!File.Exists(_context.ActivationJournalPath)) return;
        EnsurePathContainsNoReparsePoint(_context.LocalAppData, _context.ActivationJournalPath, "Activation journal");
        if (_context.IsRevitRunning())
            throw new DeploymentException(ExitCodes.BlockedProcess, "An interrupted activation must be recovered before Revit can remain open. Close every Revit window and retry.");

        ActivationJournal journal;
        string journalSha256;
        try
        {
            var rawBytes = File.ReadAllBytes(_context.ActivationJournalPath);
            journalSha256 = FileIntegrity.Sha256(rawBytes);
            var raw = new UTF8Encoding(false, true).GetString(rawBytes);
            RejectDuplicateJsonProperties(raw);
            journal = JsonSerializer.Deserialize<ActivationJournal>(raw, ReleaseManifest.JsonOptions)
                ?? throw new InvalidDataException("Activation journal was empty.");
            ValidateActivationJournal(journal);
        }
        catch (Exception ex)
        {
            QuarantineActivationJournal($"Activation journal is invalid: {ex.Message}");
            throw new DeploymentException(ExitCodes.ValidationFailed, "The interrupted activation journal was quarantined because it is invalid.", ex);
        }

        try
        {
            VerifyJournalAdmissionCandidates(journal);
        }
        catch (Exception ex)
        {
            var recoveryFailures = RecoverRejectedAdmissionControls(journal);
            var recoveryDetail = recoveryFailures.Count == 0
                ? "transaction-owned controls were restored or disabled before quarantine"
                : $"control recovery reported {recoveryFailures.Count} failure(s): {string.Join(" | ", recoveryFailures.Select(failure => failure.Message))}";
            QuarantineActivationJournal($"Activation journal SafeRead admission is invalid: {ex.Message}; {recoveryDetail}.");
            throw new DeploymentException(
                ExitCodes.ValidationFailed,
                $"The interrupted activation journal was quarantined because its SafeRead admission no longer binds the exact candidate release; {recoveryDetail}.",
                recoveryFailures.Count == 0 ? ex : new AggregateException(new[] { ex }.Concat(recoveryFailures)));
        }

        var state = journal.Controls.Single(control => control.Kind == "state");
        var releaseRootCommitted = journal.ReleaseRootSwap == null ||
            DirectoryMatchesTree(journal.ReleaseRootSwap.FinalPath, journal.ReleaseRootSwap.AfterTreeSha256);
        if (state.Note == "commit-state" && journal.Controls.All(CurrentMatchesAfter) && releaseRootCommitted)
        {
            RetireActivationJournal(journalSha256);
            Log($"Retired committed activation journal {journal.TransactionId}.");
            return;
        }

        if (journal.ReleaseRootSwap != null) RecoverReleaseRootSwap(journal.ReleaseRootSwap);

        var foreign = journal.Controls.FirstOrDefault(control => !CurrentMatchesBefore(control) && !CurrentMatchesAfter(control));
        if (foreign != null)
        {
            QuarantineActivationJournal($"Control no longer matches transaction before/after fingerprints: {foreign.Path}");
            throw new DeploymentException(ExitCodes.ValidationFailed,
                $"Interrupted activation was quarantined without altering a concurrently modified control: {foreign.Path}");
        }

        foreach (var control in journal.Controls.OrderBy(control => control.Kind == "state" ? 1 : 0))
        {
            if (CurrentMatchesBefore(control)) continue;
            if (control.BeforeExists)
            {
                var before = Convert.FromBase64String(control.BeforeBase64!);
                CasWrite(control.Path, before, control.AfterExists, control.AfterSha256);
            }
            else
            {
                CasDelete(control.Path, control.AfterExists, control.AfterSha256);
            }
        }
        RetireActivationJournal(journalSha256);
        Log($"Recovered interrupted activation journal {journal.TransactionId}; state was restored last.");
    }

    private List<Exception> RecoverRejectedAdmissionControls(ActivationJournal journal)
    {
        var failures = new List<Exception>();
        var disabled = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var unsafeReleaseRoot = journal.SafeReadAdmission == null
            ? null
            : Path.Combine(_context.ReleasesRoot, journal.SafeReadAdmission.ReleaseVersion);
        var previousRootStillExact = RejectedAdmissionPreviousRootStillExact(journal);

        // Revit-facing and auxiliary controls are handled before state. An exact after-image is
        // transaction-owned and may be removed with CAS. A third-party image is never changed.
        foreach (var control in journal.Controls.Where(control => control.Kind != "state"))
        {
            try
            {
                if (control.AfterExists && CurrentMatchesAfter(control))
                {
                    CasDelete(control.Path, expectedExists: true, expectedSha256: control.AfterSha256);
                    disabled.Add(control.Path);
                }
            }
            catch (Exception failure)
            {
                failures.Add(new IOException($"Failed to disable rejected admission control '{control.Path}'.", failure));
            }
        }

        // The unadmitted release tree is evidence. Leave final, staging, displaced, and failed
        // roots byte-for-byte in place; in particular, never move a tampered/foreign final root.
        // Restore only control preimages that do not resolve into that unsafe final root.
        foreach (var control in journal.Controls.Where(control => control.Kind != "state"))
        {
            try
            {
                var beforeIsUnsafe = unsafeReleaseRoot != null &&
                    !previousRootStillExact &&
                    control.Kind == "addin" &&
                    AddinSnapshotReferencesRoot(control, unsafeReleaseRoot);
                if (beforeIsUnsafe) continue;
                RestoreRejectedControlPreimage(control, disabled.Contains(control.Path));
            }
            catch (Exception failure)
            {
                failures.Add(new IOException($"Failed to restore rejected admission control '{control.Path}'.", failure));
            }
        }

        var state = journal.Controls.Single(control => control.Kind == "state");
        try
        {
            var beforeStateIsUnsafe = journal.SafeReadAdmission != null &&
                !previousRootStillExact &&
                StateSnapshotReferencesRelease(state, journal.SafeReadAdmission.ReleaseVersion);
            var stateDisabled = false;
            if (state.AfterExists && CurrentMatchesAfter(state))
            {
                CasDelete(state.Path, expectedExists: true, expectedSha256: state.AfterSha256);
                stateDisabled = true;
            }
            else if (beforeStateIsUnsafe && state.BeforeExists && CurrentMatchesBefore(state))
            {
                CasDelete(state.Path, expectedExists: true, expectedSha256: state.BeforeSha256);
                stateDisabled = true;
            }

            if (!beforeStateIsUnsafe)
                RestoreRejectedControlPreimage(state, stateDisabled);
        }
        catch (Exception failure)
        {
            failures.Add(new IOException($"Failed to restore or disable rejected admission state '{state.Path}'.", failure));
        }

        return failures;
    }

    private bool RejectedAdmissionPreviousRootStillExact(ActivationJournal journal)
    {
        var swap = journal.ReleaseRootSwap;
        if (swap == null || !swap.BeforeExists || swap.BeforeTreeSha256 == null) return false;
        try
        {
            return DirectoryMatchesTree(swap.FinalPath, swap.BeforeTreeSha256);
        }
        catch
        {
            return false;
        }
    }

    private static void RestoreRejectedControlPreimage(ActivationJournalControl control, bool wasDisabled)
    {
        if (control.BeforeExists)
        {
            if (CurrentMatchesBefore(control)) return;
            var before = Convert.FromBase64String(control.BeforeBase64!);
            if (wasDisabled || (!File.Exists(control.Path) && CurrentMatchesAfter(control)))
            {
                CasWrite(control.Path, before, expectedExists: false, expectedSha256: null);
                return;
            }
            if (CurrentMatchesAfter(control))
                CasWrite(control.Path, before, control.AfterExists, control.AfterSha256);
            return;
        }

        if (CurrentMatchesBefore(control)) return;
        if (CurrentMatchesAfter(control))
            CasDelete(control.Path, control.AfterExists, control.AfterSha256);
    }

    private static bool AddinSnapshotReferencesRoot(ActivationJournalControl control, string unsafeReleaseRoot)
    {
        if (!control.BeforeExists || control.BeforeBase64 == null) return false;
        try
        {
            var document = XDocument.Parse(new UTF8Encoding(false, true).GetString(Convert.FromBase64String(control.BeforeBase64)), LoadOptions.None);
            return document.Descendants()
                .Where(element => element.Name.LocalName == "Assembly")
                .Any(element => IsPathAtOrUnder(element.Value, unsafeReleaseRoot));
        }
        catch
        {
            return true;
        }
    }

    private static bool StateSnapshotReferencesRelease(ActivationJournalControl control, string unsafeReleaseVersion)
    {
        if (!control.BeforeExists || control.BeforeBase64 == null) return false;
        try
        {
            var state = JsonSerializer.Deserialize<InstalledState>(
                Convert.FromBase64String(control.BeforeBase64),
                ReleaseManifest.JsonOptions);
            return state == null || state.CurrentRelease.Equals(unsafeReleaseVersion, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return true;
        }
    }

    private static bool IsPathAtOrUnder(string candidate, string root)
    {
        try
        {
            var candidateFull = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return candidateFull.Equals(rootFull, StringComparison.OrdinalIgnoreCase) ||
                   candidateFull.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return true;
        }
    }

    private void VerifyJournalAdmissionCandidates(ActivationJournal journal)
    {
        var candidateRoots = new List<string>();
        if (journal.ReleaseRootSwap != null)
        {
            var swap = journal.ReleaseRootSwap;
            foreach (var path in new[] { swap.FinalPath, swap.StagingPath, swap.FailedPath })
            {
                if (Directory.Exists(path) &&
                    ReleaseTreeSha256(path).Equals(swap.AfterTreeSha256, StringComparison.OrdinalIgnoreCase))
                    candidateRoots.Add(path);
            }
            if (candidateRoots.Count == 0)
                throw new InvalidDataException("The journaled replacement tree is absent or no longer exact.");
        }
        else if (journal.SafeReadAdmission != null)
        {
            var releaseRoot = Path.Combine(_context.ReleasesRoot, journal.SafeReadAdmission.ReleaseVersion);
            if (!Directory.Exists(releaseRoot))
                throw new InvalidDataException("The journaled SafeRead release root is missing.");
            candidateRoots.Add(releaseRoot);
        }

        foreach (var candidateRoot in candidateRoots.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var manifestPath = Path.Combine(candidateRoot, "manifest.json");
            var manifest = ReleaseManifest.Load(manifestPath);
            var requiresAdmission = manifest.SafeReadAdmission != null;
            if (requiresAdmission != (journal.SafeReadAdmission != null))
                throw new InvalidDataException("The activation journal admission presence is detached from the candidate manifest.");
            SafeReadAdmissionVerifier.VerifyCandidate(
                _context,
                candidateRoot,
                journal.ReleaseRootSwap?.FinalPath ?? candidateRoot,
                manifest,
                journal.SafeReadAdmission);
        }
    }

    private void RecoverReleaseRootSwap(ActivationJournalReleaseRootSwap swap)
    {
        var beforeHash = swap.BeforeTreeSha256;
        var finalHash = ReleaseRootSlotHash(swap.FinalPath, "final");
        var stagingHash = ReleaseRootSlotHash(swap.StagingPath, "staging");
        var displacedHash = ReleaseRootSlotHash(swap.DisplacedPath, "displaced");
        var failedHash = ReleaseRootSlotHash(swap.FailedPath, "failed");
        RequireReleaseRootSlot("final", swap.FinalPath, finalHash, beforeHash, swap.AfterTreeSha256);
        RequireReleaseRootSlot("staging", swap.StagingPath, stagingHash, swap.AfterTreeSha256);
        RequireReleaseRootSlot("displaced", swap.DisplacedPath, displacedHash, beforeHash);
        RequireReleaseRootSlot("failed", swap.FailedPath, failedHash, swap.AfterTreeSha256);

        var identicalTrees = swap.BeforeExists &&
            beforeHash!.Equals(swap.AfterTreeSha256, StringComparison.OrdinalIgnoreCase);
        var finalIsBefore = swap.BeforeExists && HashesEqual(finalHash, beforeHash);
        var finalIsAfter = HashesEqual(finalHash, swap.AfterTreeSha256);

        if (!finalIsBefore && finalIsAfter && !identicalTrees)
        {
            if (failedHash != null)
            {
                QuarantineReleaseRootSwap("both final and failed roots contain the replacement tree");
            }
            Directory.Move(swap.FinalPath, swap.FailedPath);
            finalHash = null;
        }

        if (swap.BeforeExists && !HashesEqual(finalHash, beforeHash))
        {
            if (!HashesEqual(displacedHash, beforeHash))
                QuarantineReleaseRootSwap("the previous release tree is not available in its final or displaced root");
            if (Directory.Exists(swap.FinalPath) || File.Exists(swap.FinalPath))
                QuarantineReleaseRootSwap("the final release path could not be cleared without touching a foreign entry");
            Directory.Move(swap.DisplacedPath, swap.FinalPath);
            finalHash = ReleaseRootSlotHash(swap.FinalPath, "restored final");
        }
        else if (!swap.BeforeExists && finalHash != null)
        {
            if (!finalIsAfter)
                QuarantineReleaseRootSwap("the previously absent final release path contains a foreign tree");
            if (failedHash != null)
                QuarantineReleaseRootSwap("both final and failed roots contain the replacement tree");
            Directory.Move(swap.FinalPath, swap.FailedPath);
            finalHash = null;
        }

        if (swap.BeforeExists)
        {
            if (!HashesEqual(finalHash, beforeHash))
                throw new IOException("Interrupted release-root recovery did not restore the previous tree exactly.");
        }
        else if (Directory.Exists(swap.FinalPath) || File.Exists(swap.FinalPath))
        {
            throw new IOException("Interrupted release-root recovery did not restore the previous absent final path.");
        }

        if (Directory.Exists(swap.StagingPath))
        {
            if (Directory.Exists(swap.FailedPath) || File.Exists(swap.FailedPath))
                QuarantineReleaseRootSwap("both staging and failed roots contain the replacement tree");
            Directory.Move(swap.StagingPath, swap.FailedPath);
        }
    }

    private string? ReleaseRootSlotHash(string path, string slot)
    {
        if (File.Exists(path))
            QuarantineReleaseRootSwap($"the {slot} release-root slot contains a file instead of a directory");
        return Directory.Exists(path) ? ReleaseTreeSha256(path) : null;
    }

    private void RequireReleaseRootSlot(string slot, string path, string? actual, params string?[] allowed)
    {
        if (actual == null || allowed.Any(expected => HashesEqual(actual, expected))) return;
        QuarantineReleaseRootSwap($"the {slot} release-root slot no longer matches its transaction fingerprint: {path}");
    }

    private void QuarantineReleaseRootSwap(string reason)
    {
        QuarantineActivationJournal($"Release-root transaction is unsafe to recover: {reason}.");
        throw new DeploymentException(ExitCodes.ValidationFailed,
            $"Interrupted activation was quarantined without moving a foreign release root: {reason}.");
    }

    private bool DirectoryMatchesTree(string path, string expectedSha256)
        => Directory.Exists(path) && ReleaseTreeSha256(path).Equals(expectedSha256, StringComparison.OrdinalIgnoreCase);

    private static bool HashesEqual(string? left, string? right)
        => left != null && right != null && left.Equals(right, StringComparison.OrdinalIgnoreCase);

    private void EnsureNoQuarantinedActivationJournal()
    {
        if (!Directory.Exists(_context.DeploymentRoot)) return;
        var quarantined = Directory.GetFiles(_context.DeploymentRoot, "activation-journal.quarantine-*.json", SearchOption.TopDirectoryOnly);
        if (quarantined.Length > 0)
            throw new DeploymentException(ExitCodes.ValidationFailed,
                $"A quarantined activation requires manual inspection before deployment can continue: {quarantined[0]}");
    }

    private void QuarantineActivationJournal(string reason)
    {
        Directory.CreateDirectory(_context.DeploymentRoot);
        var destination = Path.Combine(_context.DeploymentRoot,
            $"activation-journal.quarantine-{_context.UtcNow():yyyyMMddHHmmss}-{Guid.NewGuid():N}.json");
        if (File.Exists(_context.ActivationJournalPath)) File.Move(_context.ActivationJournalPath, destination, overwrite: false);
        Log($"QUARANTINED activation journal: {reason} ({destination})");
    }

    private void ValidateActivationJournal(ActivationJournal journal)
    {
        if (journal.Schema != "revit-operator.activation-journal.v1" || !Guid.TryParseExact(journal.TransactionId, "D", out _) ||
            journal.Operation is not ("install" or "update" or "repair" or "rollback") ||
            !DateTimeOffset.TryParse(journal.CreatedAtUtc, out _) || journal.Controls.Count is < 1 or > 64)
            throw new InvalidDataException("Activation journal header is invalid.");
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var control in journal.Controls)
        {
            if (!paths.Add(Path.GetFullPath(control.Path))) throw new InvalidDataException("Activation journal repeats a control path.");
            ValidateJournalControlPath(control);
            ValidateJournalFingerprint(control.BeforeExists, control.BeforeSha256, control.BeforeBase64, control.Path);
            if (control.AfterExists && (control.AfterSha256 == null || !IsSha256(control.AfterSha256)))
                throw new InvalidDataException($"Activation journal after fingerprint is invalid: {control.Path}");
            if (!control.AfterExists && control.AfterSha256 != null)
                throw new InvalidDataException($"Activation journal absent control has a hash: {control.Path}");
        }
        if (journal.Controls.Count(control => control.Kind == "state" && PathsEqual(control.Path, _context.StatePath)) != 1)
            throw new InvalidDataException("Activation journal requires one exact state control.");
        if (journal.SafeReadAdmission != null)
        {
            SafeReadAdmissionVerifier.ValidateBinding(journal.SafeReadAdmission, journal.SafeReadAdmission.ReleaseVersion);
            var expectedRoot = Path.Combine(_context.ReleasesRoot, journal.SafeReadAdmission.ReleaseVersion);
            if (journal.ReleaseRootSwap != null && !PathsEqual(journal.ReleaseRootSwap.FinalPath, expectedRoot))
                throw new InvalidDataException("Activation journal SafeRead admission is bound to a different final release root.");
        }
        if (journal.ReleaseRootSwap != null) ValidateReleaseRootSwap(journal);
    }

    private void ValidateReleaseRootSwap(ActivationJournal journal)
    {
        var swap = journal.ReleaseRootSwap!;
        EnsureReleaseTransactionPath(swap.FinalPath, "activation journal final release root");
        EnsureReleaseTransactionPath(swap.StagingPath, "activation journal staging release root");
        EnsureReleaseTransactionPath(swap.DisplacedPath, "activation journal displaced release root");
        EnsureReleaseTransactionPath(swap.FailedPath, "activation journal failed release root");
        var paths = new[] { swap.FinalPath, swap.StagingPath, swap.DisplacedPath, swap.FailedPath };
        if (paths.Distinct(StringComparer.OrdinalIgnoreCase).Count() != paths.Length)
            throw new InvalidDataException("Activation journal release-root paths must be distinct.");

        var finalName = Path.GetFileName(swap.FinalPath);
        ReleaseManifest.EnsureSafeBaseName(finalName, "activation journal release root");
        var suffix = Guid.Parse(journal.TransactionId).ToString("N");
        if (!PathsEqual(swap.StagingPath, Path.Combine(_context.ReleasesRoot, $".{finalName}.staging-{suffix}")) ||
            !PathsEqual(swap.DisplacedPath, Path.Combine(_context.ReleasesRoot, $".{finalName}.replaced-{suffix}")) ||
            !PathsEqual(swap.FailedPath, Path.Combine(_context.ReleasesRoot, $".{finalName}.failed-{suffix}")))
            throw new InvalidDataException("Activation journal release-root transaction paths are not bound to its transaction identity.");
        if (swap.BeforeExists != (swap.BeforeTreeSha256 != null) ||
            (swap.BeforeTreeSha256 != null && !IsSha256(swap.BeforeTreeSha256)) ||
            !IsSha256(swap.AfterTreeSha256))
            throw new InvalidDataException("Activation journal release-root fingerprints are invalid.");
    }

    private void ValidateJournalControlPath(ActivationJournalControl control)
    {
        if (control.Kind == "state")
        {
            if (!PathsEqual(control.Path, _context.StatePath)) throw new InvalidDataException("Activation journal state path is invalid.");
            EnsurePathContainsNoReparsePoint(_context.LocalAppData, control.Path, "Deployment state");
            return;
        }
        if (control.Kind == "auxiliary")
        {
            var allowed = new[] { _context.StableDesktopLauncherPath, _context.DesktopCommandPath, _context.DesktopShortcutPath };
            if (!allowed.Any(path => PathsEqual(path, control.Path))) throw new InvalidDataException("Activation journal auxiliary path is invalid.");
            var isDesktopControl = PathsEqual(control.Path, _context.DesktopCommandPath) || PathsEqual(control.Path, _context.DesktopShortcutPath);
            EnsurePathContainsNoReparsePoint(
                isDesktopControl ? _context.Desktop : _context.LocalAppData,
                control.Path,
                "Operator Desktop control");
            return;
        }
        if (control.Kind != "addin") throw new InvalidDataException("Activation journal control kind is invalid.");
        EnsureControlPathIsLocal(control.Path);
        var addinsRoot = Path.Combine(_context.AppData, "Autodesk", "Revit", "Addins");
        var relative = Path.GetRelativePath(addinsRoot, control.Path).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (relative.Length != 2 || relative[0].Length != 4 || !int.TryParse(relative[0], out _) ||
            !relative[1].EndsWith(".addin", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Activation journal add-in path is invalid.");
        ReleaseManifest.EnsureSafeBaseName(relative[1], "activation journal add-in filename");
    }

    private static void ValidateJournalFingerprint(bool exists, string? sha256, string? base64, string path)
    {
        if (!exists)
        {
            if (sha256 != null || base64 != null) throw new InvalidDataException($"Activation journal absent snapshot is invalid: {path}");
            return;
        }
        if (sha256 == null || !IsSha256(sha256) || base64 == null) throw new InvalidDataException($"Activation journal snapshot is incomplete: {path}");
        var bytes = Convert.FromBase64String(base64);
        if (bytes.Length > 1024 * 1024 || !FileIntegrity.Sha256(bytes).Equals(sha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Activation journal snapshot hash is invalid: {path}");
    }

    private static bool IsSha256(string value) => value.Length == 64 && value.All(Uri.IsHexDigit);

    private static bool CurrentMatchesBefore(ActivationJournalControl control)
        => CurrentMatches(control.Path, control.BeforeExists, control.BeforeSha256);

    private static bool CurrentMatchesAfter(ActivationJournalControl control)
        => CurrentMatches(control.Path, control.AfterExists, control.AfterSha256);

    private static bool CurrentMatches(string path, bool exists, string? sha256)
        => exists
            ? File.Exists(path) && FileIntegrity.Sha256(path).Equals(sha256, StringComparison.OrdinalIgnoreCase)
            : !File.Exists(path);

    private static void RejectDuplicateJsonProperties(string json)
    {
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 32 });
        Inspect(document.RootElement);
        static void Inspect(JsonElement element)
        {
            if (element.ValueKind == JsonValueKind.Object)
            {
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var property in element.EnumerateObject())
                {
                    if (!names.Add(property.Name)) throw new InvalidDataException($"Duplicate JSON property '{property.Name}'.");
                    Inspect(property.Value);
                }
            }
            else if (element.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in element.EnumerateArray()) Inspect(item);
            }
        }
    }

    private static void WriteDurableAtomic(string path, byte[] contents)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + $".tmp-{Guid.NewGuid():N}";
        try
        {
            WriteDurableFile(temp, contents);
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private static void WriteDurableFile(string path, byte[] contents)
    {
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096,
            FileOptions.WriteThrough | FileOptions.SequentialScan);
        stream.Write(contents);
        stream.Flush(flushToDisk: true);
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

    private void SaveSuccessfulState(
        string releaseVersion,
        List<OwnedAddinManifest> ownership,
        InstalledSafeReadAdmission? safeReadAdmission,
        ActivationJournal journal)
    {
        var state = LoadState(required: false) ?? new InstalledState();
        state.SuccessfulReleases.RemoveAll(x => x.Equals(releaseVersion, StringComparison.OrdinalIgnoreCase));
        state.SuccessfulReleases.Add(releaseVersion);
        state.CurrentRelease = releaseVersion;
        state.UpdatedAtUtc = _context.UtcNow().ToString("O");
        state.SchemaVersion = 3;
        state.OwnedAddinManifests = ownership;
        state.SafeReadAdmissions.RemoveAll(admission => admission.ReleaseVersion.Equals(releaseVersion, StringComparison.OrdinalIgnoreCase));
        if (safeReadAdmission != null)
            state.SafeReadAdmissions.Add(SafeReadAdmissionVerifier.Clone(safeReadAdmission));
        SaveState(state, journal);
    }

    private InstalledState? LoadState(bool required) => LoadStateSnapshot(required).State;

    private StateSnapshot LoadStateSnapshot(bool required)
    {
        if (!File.Exists(_context.StatePath))
        {
            if (required) throw new DeploymentException(ExitCodes.NoInstalledRelease, "No OperatorDeploy installation state was found.");
            return new StateSnapshot(null, null);
        }
        try
        {
            var bytes = File.ReadAllBytes(_context.StatePath);
            var state = JsonSerializer.Deserialize<InstalledState>(bytes, ReleaseManifest.JsonOptions)
                ?? throw new InvalidDataException("State was empty.");
            if (state.SchemaVersion is not (1 or 2 or 3)) throw new InvalidDataException($"Unsupported state schemaVersion {state.SchemaVersion}.");
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
            if (state.SchemaVersion is 1 or 2 && state.SafeReadAdmissions.Count != 0)
                throw new InvalidDataException($"State schemaVersion {state.SchemaVersion} cannot carry SafeRead admission bindings.");
            var admissionReleases = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var admission in state.SafeReadAdmissions)
            {
                SafeReadAdmissionVerifier.ValidateBinding(admission, admission.ReleaseVersion);
                if (!releases.Contains(admission.ReleaseVersion) || !admissionReleases.Add(admission.ReleaseVersion))
                    throw new InvalidDataException($"State SafeRead admission for release '{admission.ReleaseVersion}' is detached or duplicated.");
            }
            return new StateSnapshot(state, FileIntegrity.Sha256(bytes));
        }
        catch (Exception ex) { throw new DeploymentException(ExitCodes.ValidationFailed, $"Installed state is invalid: {ex.Message}", ex); }
    }

    private void SaveState(InstalledState state, ActivationJournal journal)
    {
        var releaseRoot = Path.Combine(_context.ReleasesRoot, state.CurrentRelease);
        var manifest = ReleaseManifest.Load(Path.Combine(releaseRoot, "manifest.json"));
        var stateAdmission = AdmissionForRelease(state, state.CurrentRelease, manifest);
        var stateAdmissionJson = JsonSerializer.Serialize(stateAdmission, ReleaseManifest.JsonOptions);
        var journalAdmissionJson = JsonSerializer.Serialize(journal.SafeReadAdmission, ReleaseManifest.JsonOptions);
        if (!stateAdmissionJson.Equals(journalAdmissionJson, StringComparison.Ordinal))
            throw new DeploymentException(ExitCodes.ValidationFailed, "Activation journal SafeRead admission does not match the state being committed.");
        var bytes = new UTF8Encoding(false).GetBytes(JsonSerializer.Serialize(state, ReleaseManifest.JsonOptions));
        var stateControl = JournalControl(journal, _context.StatePath);
        stateControl.AfterExists = true;
        stateControl.AfterSha256 = FileIntegrity.Sha256(bytes);
        stateControl.Note = "commit-state";
        PersistActivationJournal(journal);
        _context.ActivationCheckpoint("before-state-commit");
        ApplyJournaledWrite(journal, _context.StatePath, bytes);
        _context.ActivationCheckpoint("after-state-commit");
        var journalBytes = new UTF8Encoding(false).GetBytes(JsonSerializer.Serialize(journal, ReleaseManifest.JsonOptions));
        RetireActivationJournal(FileIntegrity.Sha256(journalBytes));
    }

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

    private void ValidateActivatedRelease(
        string releaseRoot,
        ReleaseManifest manifest,
        IReadOnlyCollection<ReleaseComponent> components,
        ActivationResult activation,
        InstalledSafeReadAdmission? safeReadAdmission)
    {
        SafeReadAdmissionVerifier.VerifyCandidate(_context, releaseRoot, releaseRoot, manifest, safeReadAdmission);
        var validation = ValidateInstalledRelease(releaseRoot, manifest, components, includeNetwork: false);
        if (!validation.Ok) throw new DeploymentException(ExitCodes.ValidationFailed, validation.Message);
        foreach (var control in activation.Ownership) AssertOwnedManifest(control);
        foreach (var control in activation.Obsolete)
        {
            if (File.Exists(control.ManifestPath))
                throw new DeploymentException(ExitCodes.ValidationFailed, $"Obsolete installer-owned Revit add-in manifest is still present: {control.ManifestPath}");
        }
    }

    private static InstalledSafeReadAdmission? AdmissionForRelease(
        InstalledState state,
        string releaseVersion,
        ReleaseManifest manifest)
    {
        var matches = state.SafeReadAdmissions
            .Where(admission => admission.ReleaseVersion.Equals(releaseVersion, StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (matches.Count > 1)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Installed state repeats SafeRead admission for release '{releaseVersion}'.");
        if (manifest.SafeReadAdmission == null)
        {
            if (matches.Count != 0)
                throw new DeploymentException(ExitCodes.ValidationFailed, $"Installed SafeRead admission is detached from release '{releaseVersion}'.");
            return null;
        }
        if (matches.Count != 1)
            throw new DeploymentException(ExitCodes.ValidationFailed, $"Release '{releaseVersion}' requires one durable SafeRead admission binding.");
        return SafeReadAdmissionVerifier.Clone(matches[0]);
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
    private sealed record PlannedActivation(
        List<AddinControl> Targets,
        List<OwnedAddinManifest> Obsolete,
        List<OwnedAddinManifest> Retained,
        Dictionary<string, OwnedAddinManifest> PreviousTargets);
    private sealed record ActivationResult(List<OwnedAddinManifest> Ownership, List<OwnedAddinManifest> Obsolete);
    private sealed record PreparedAuxiliaryControl(string Path, byte[] Contents);
    private sealed record StateSnapshot(InstalledState? State, string? Sha256);
}

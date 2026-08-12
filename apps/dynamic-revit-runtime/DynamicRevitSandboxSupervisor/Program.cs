using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using RevitOperator.DynamicRevit.RuntimePackaging;
using RevitOperator.DynamicRevitSdk;

namespace RevitOperator.DynamicRevitSandboxSupervisor;

internal static class Program
{
    private static readonly TimeSpan BridgeRequestTimeout = TimeSpan.FromSeconds(90);
    internal static TimeSpan BridgeRequestTimeoutForTests => BridgeRequestTimeout;
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true, WriteIndented = true };
    private static readonly JsonSerializerOptions WireJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true, WriteIndented = false };
    private static readonly JsonSerializerOptions SnakeJson = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower, PropertyNameCaseInsensitive = false, WriteIndented = false };
    private static readonly JsonSerializerOptions StrictJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = false, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, WriteIndented = false };

    public static async Task<int> Main(string[] args)
    {
        if (args.Length == 2 && (args[0] == "--execute-task" || args[0] == "--execute-replay-task"))
        {
            var config = JsonSerializer.Deserialize<LiveTaskConfig>(await File.ReadAllTextAsync(args[1]), Json) ?? throw new ArgumentException("Live task config is invalid.");
            var live = await RunLiveTask(config, replayAdmission: args[0] == "--execute-replay-task");
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(config.EvidencePath))!);
            await File.WriteAllTextAsync(config.EvidencePath, JsonSerializer.Serialize(live, Json));
            Console.WriteLine(JsonSerializer.Serialize(live, Json));
            return live.Ok ? 0 : 1;
        }
        if (args.Length != 6 || args[0] != "--probe-suite" || args[1] != "--worker-directory" || args[3] != "--evidence")
        {
            Console.Error.WriteLine("Usage: DynamicRevitSandboxSupervisor --probe-suite --worker-directory <dir> --evidence <json> <lpac|appcontainer>");
            return 2;
        }
        var lessPrivileged = string.Equals(args[5], "lpac", StringComparison.OrdinalIgnoreCase);
        var evidence = await RunProbeSuite(Path.GetFullPath(args[2]), Path.GetFullPath(args[4]), lessPrivileged);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args[4]))!);
        await File.WriteAllTextAsync(args[4], JsonSerializer.Serialize(evidence, Json));
        Console.WriteLine(JsonSerializer.Serialize(evidence, Json));
        return evidence.Ok ? 0 : 1;
    }

    private static async Task<LiveEvidence> RunLiveTask(LiveTaskConfig config, bool replayAdmission)
    {
        var started = DateTimeOffset.UtcNow;
        var contextRuleRequested = !string.IsNullOrWhiteSpace(config.ContextRuleFile) || !string.IsNullOrWhiteSpace(config.ContextRuleVerificationKeyFile) ||
            !string.IsNullOrWhiteSpace(config.ContextCompanyId) || !string.IsNullOrWhiteSpace(config.ContextUserId) || config.CoreEffectBudget != null;
        if (contextRuleRequested)
        {
            RequireDevelopmentLaboratory();
            if (string.IsNullOrWhiteSpace(config.ContextRuleFile) || string.IsNullOrWhiteSpace(config.ContextRuleVerificationKeyFile) ||
                string.IsNullOrWhiteSpace(config.ContextCompanyId) || string.IsNullOrWhiteSpace(config.ContextUserId) || config.CoreEffectBudget == null || config.ResultReference)
                throw new InvalidOperationException("Context-rule execution requires one complete rule/key/company/user/core-budget lane and cannot share another worker lane.");
            config.CoreEffectBudget.Validate();
        }
        var workerDirectory = Path.GetFullPath(config.WorkerDirectory);
        var evidencePath = Path.GetFullPath(config.EvidencePath);
        using var workspace = TaskWorkspace.Create(evidencePath, "live-tasks", workerDirectory);
        var taskRoot = workspace.Root;
        var scratch = workspace.ScratchDirectory;
        var source = await File.ReadAllTextAsync(config.SourceFile);
        var token = (await File.ReadAllTextAsync(config.OperatorTokenFile)).Trim();
        if (token.Length < 16) throw new InvalidOperationException("Operator token file is empty or invalid.");
        var writeGrant = ReadWriteGrantForMode(config.OperatorTokenFile, config.Apply);
        using var profile = WindowsSandboxProfile.Create(lessPrivileged: true);
        profile.GrantTaskLayout(taskRoot, workspace.RuntimeDirectory, scratch);
        var runtimeId = Guid.NewGuid().ToString("N");
        var signingKey = RandomNumberGenerator.GetBytes(32);
        var hostSessionKey = RandomNumberGenerator.GetBytes(32);
        var launcherHash = LauncherPackageHash();
        var hostCapabilitiesPath = Path.Combine(AppContext.BaseDirectory, "manifests", "revit-host-capabilities.v1.json");
        var selectedHost = RevitHostCapabilityManifest.LoadTrusted(hostCapabilitiesPath).Select(config.TargetRevitYear);
        var runtimeExpires = DateTimeOffset.UtcNow.AddMinutes(8).ToUnixTimeSeconds();
        var registration = "";
        var hostAuthentications = new List<string>();
        var bootstrapRaw = await Post(config.BridgeUrl, "/revit/dynamic-runtime/bootstrap", token, writeGrant, "{}", Guid.NewGuid().ToString("N"));
        var bootstrap = await CompleteBootstrap(bootstrapRaw, runtimeId, hostSessionKey, launcherHash, selectedHost);
        hostAuthentications.Add(bootstrap.Receipt);
        var snapshotCore = JsonSerializer.Serialize(new { category = config.Category, limit = config.Limit, parameters = config.Parameters, operationBudget = config.OperationBudget }, WireJson);
        var snapshotCorrelation = Guid.NewGuid().ToString("N");
        var snapshotAuthExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
        var snapshotRequest = JsonSerializer.Serialize(new { category = config.Category, limit = config.Limit, parameters = config.Parameters, operationBudget = config.OperationBudget, runtimeInstanceId = runtimeId, correlationId = snapshotCorrelation, authExpiresUnixSeconds = snapshotAuthExpires, requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "snapshot", runtimeId, snapshotCorrelation, snapshotAuthExpires, DynamicWire.Sha256(snapshotCore)) }, WireJson);
        var snapshotEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/snapshot", token, writeGrant, snapshotRequest, snapshotCorrelation);
        var snapshotRaw = UnwrapAuthenticated(snapshotEnvelope, hostSessionKey, runtimeId, "snapshot-receipt", out var snapshotAuthentication);
        hostAuthentications.Add(snapshotAuthentication);
        using var snapshotDocument = JsonDocument.Parse(snapshotRaw);
        var snapshotRoot = snapshotDocument.RootElement;
        var document = snapshotRoot.GetProperty("document").Deserialize<DynamicDocumentDto>(Json) ?? throw new InvalidOperationException("Snapshot document DTO is missing.");
        var elements = snapshotRoot.GetProperty("elements").Deserialize<List<DynamicElementDto>>(Json) ?? throw new InvalidOperationException("Snapshot element DTOs are missing.");
        var snapshotToken = snapshotRoot.GetProperty("snapshot_token").GetString() ?? throw new InvalidOperationException("Snapshot capability is missing.");
        var snapshotInputHash = snapshotRoot.GetProperty("input_hash").GetString() ?? throw new InvalidOperationException("Snapshot input binding is missing.");
        var taskInput = new DynamicTaskInput { Document = document, Elements = elements, OperationBudget = config.OperationBudget };
        string workerInput;
        ResultReferenceObservationInput? resultReferenceInput = null;
        ContextRuleExecutionInput? contextRuleInput = null;

        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var correlation = Guid.NewGuid().ToString("N");
        var channelKey = RandomNumberGenerator.GetBytes(32);
        var outputPipeName = "RevitOperator.DynamicRuntime.Worker." + Guid.NewGuid().ToString("N");
        using var pipe = profile.CreateAuthenticatedPipe(outputPipeName);
        using var inputPipe = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
        var inputPipeHandle = inputPipe.GetClientHandleAsString();
        var executable = Path.Combine(workspace.RuntimeDirectory, "DynamicRevitWorker.exe");
        var arguments = "--sandbox-execute --input-pipe " + inputPipeHandle + " --output-named-pipe " + outputPipeName;
        var workerRuntimePackageHash = workspace.RuntimeImage.VerifyBeforeLaunch();
        var workerExecutableHash = workspace.RuntimeImage.WorkerExecutableHash;
        var compilerRuntimeHash = workspace.RuntimeImage.CompilerRuntimeHash;
        var sdkArtifactHash = workspace.RuntimeImage.SdkArtifactHash;
        using var worker = profile.Launch(executable, arguments, scratch, memoryMb: 256, cpuTimeLimit: TimeSpan.FromMilliseconds(Math.Max(config.WorkerDeadlineMs, 1_000) + 5_000), inheritedHandles: new[] { new IntPtr(long.Parse(inputPipeHandle, System.Globalization.CultureInfo.InvariantCulture)) });
        var startupNonceHash = DynamicWire.Sha256(nonce);
        var taskDirectoryIdentity = DynamicWire.Sha256(Path.GetFullPath(taskRoot));
        var registrationCore = JsonSerializer.Serialize(new { runtimeInstanceId = runtimeId, signingKeyBase64 = Convert.ToBase64String(signingKey), launcherExecutableHash = launcherHash, workerExecutableHash, workerRuntimePackageHash, compilerRuntimeHash, sdkArtifactHash, sandboxProfile = profile.ProfileName, workerProcessId = checked((int)worker.ProcessId), startupNonceHash, taskDirectoryIdentity, expiresUnixSeconds = runtimeExpires }, WireJson);
        var registrationCorrelation = Guid.NewGuid().ToString("N");
        var registrationAuthExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
        var registrationRequest = JsonSerializer.Serialize(new { runtimeInstanceId = runtimeId, signingKeyBase64 = Convert.ToBase64String(signingKey), launcherExecutableHash = launcherHash, workerExecutableHash, workerRuntimePackageHash, compilerRuntimeHash, sdkArtifactHash, sandboxProfile = profile.ProfileName, workerProcessId = checked((int)worker.ProcessId), startupNonceHash, taskDirectoryIdentity, expiresUnixSeconds = runtimeExpires, correlationId = registrationCorrelation, authExpiresUnixSeconds = registrationAuthExpires, requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "register-worker", runtimeId, registrationCorrelation, registrationAuthExpires, DynamicWire.Sha256(registrationCore)) }, WireJson);
        var registrationEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/register", token, writeGrant, registrationRequest, registrationCorrelation);
        registration = UnwrapAuthenticated(registrationEnvelope, hostSessionKey, runtimeId, "register-worker-receipt", out var registrationAuthentication);
        hostAuthentications.Add(registrationAuthentication);
        if (contextRuleRequested)
        {
            contextRuleInput = await CollectContextRuleInput(config, taskInput, runtimeId, hostSessionKey, token, writeGrant, workerRuntimePackageHash, hostAuthentications);
            workerInput = JsonSerializer.Serialize(new
            {
                schema = "dynamic-revit-worker-input/v0", source, input = taskInput, deadlineMs = config.WorkerDeadlineMs,
                resultReferenceDocumentRevision = contextRuleInput.DocumentRevision, verifiedContextRule = contextRuleInput.Rule,
                contextObservationPages = contextRuleInput.Pages
            }, Json);
        }
        else if (config.ResultReference)
        {
            if (config.BuildingSystemsSelector == null || config.ResultReferenceEffectBudget == null)
                throw new InvalidOperationException("Result-reference execution requires an exact building-systems selector and effect budget.");
            config.ResultReferenceEffectBudget.Validate();
            resultReferenceInput = await CollectResultReferenceInputs(config, runtimeId, hostSessionKey, token, writeGrant, workerRuntimePackageHash, hostAuthentications);
            ValidateResultReferenceObservationContext(taskInput, resultReferenceInput);
            workerInput = JsonSerializer.Serialize(new
            {
                schema = "dynamic-revit-worker-input/v0",
                source,
                input = taskInput,
                deadlineMs = config.WorkerDeadlineMs,
                resultReferenceDocumentRevision = resultReferenceInput.DocumentRevision,
                resultReferenceSnapshotHash = resultReferenceInput.SnapshotHash,
                resultReferenceScopeHash = resultReferenceInput.ScopeHash,
                buildingSystemsPages = resultReferenceInput.Pages,
                trustedExternalTargets = resultReferenceInput.TrustedExternalTargets
            }, Json);
        }
        else
        {
            workerInput = JsonSerializer.Serialize(new { schema = "dynamic-revit-worker-input/v0", source, input = taskInput, deadlineMs = config.WorkerDeadlineMs }, Json);
        }
        inputPipe.DisposeLocalCopyOfClientHandle();
        using (var inputWriter = new StreamWriter(inputPipe, new UTF8Encoding(false), 64 * 1024, leaveOpen: true) { AutoFlush = true }) await inputWriter.WriteLineAsync(JsonSerializer.Serialize(new { nonce, correlation, channelKeyBase64 = Convert.ToBase64String(channelKey), request = JsonDocument.Parse(workerInput).RootElement }, WireJson));
        inputPipe.Close();
        var connected = pipe.WaitForConnectionAsync();
        if (await Task.WhenAny(connected, Task.Delay(TimeSpan.FromMilliseconds(config.WorkerDeadlineMs + 5_000))) != connected) { worker.Kill(); throw new TimeoutException("Sandboxed worker did not connect its authenticated output pipe before the supervisor deadline."); }
        await connected;
        if (!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var kernelObservedWorkerPid) || kernelObservedWorkerPid != worker.ProcessId) { worker.Kill(); throw new InvalidOperationException("Sandboxed worker output pipe was connected by the wrong kernel-observed process."); }
        var read = ReadBoundedLineAsync(pipe, 4 * 1024 * 1024);
        if (await Task.WhenAny(read, Task.Delay(TimeSpan.FromMilliseconds(config.WorkerDeadlineMs + 5_000))) != read) { worker.Kill(); throw new TimeoutException("Sandboxed worker did not return before supervisor deadline."); }
        var messageRaw = await read ?? throw new InvalidOperationException("Sandboxed worker closed its channel without a result.");
        using var messageDocument = JsonDocument.Parse(messageRaw);
        var message = messageDocument.RootElement;
        var messagePid = message.GetProperty("pid").GetUInt32();
        var pidMatches = messagePid == worker.ProcessId;
        var nonceMatches = FixedEquals(nonce, message.GetProperty("nonce").GetString() ?? "");
        var correlationMatches = FixedEquals(correlation, message.GetProperty("correlation").GetString() ?? "");
        var hmacMatches = VerifyChannelMessage(message, channelKey, worker.ProcessId);
        if (!pidMatches || !nonceMatches || !correlationMatches || !hmacMatches)
            throw new InvalidOperationException("Sandboxed worker channel authentication failed: pid=" + pidMatches + ", nonce=" + nonceMatches + ", correlation=" + correlationMatches + ", payload/HMAC=" + hmacMatches + ", expectedPid=" + worker.ProcessId + ", observedPid=" + messagePid + ".");
        if (!worker.Wait(TimeSpan.FromSeconds(5))) worker.Kill();
        var output = DecodePayload(message);
        if (!output.GetProperty("ok").GetBoolean()) return LiveEvidence.Failed(started, profile.ProfileName, taskRoot, workspace.RuntimeImage, registration, snapshotRaw, output.Clone(), "Worker compilation or execution failed.");
        var sourceHash = output.GetProperty("sourceHash").GetString()!;
        var programHash = output.GetProperty("programHash").GetString()!;
        var sdkHash = output.GetProperty("sdkHash").GetString()!;
        if (contextRuleInput != null)
            return await CompleteCoreContextTask(config, started, taskRoot, workspace, profile, selectedHost, bootstrap, runtimeId, hostSessionKey,
                token, writeGrant, registration, snapshotRaw, output.Clone(), sourceHash, programHash, sdkHash, snapshotInputHash, contextRuleInput, hostAuthentications);
        if (config.ResultReference)
        {
            if (resultReferenceInput == null) throw new InvalidOperationException("Result-reference observation state is missing.");
            return await CompleteResultReferenceTask(config, started, taskRoot, workspace, profile, selectedHost, bootstrap, runtimeId, hostSessionKey,
                token, writeGrant, registration, snapshotRaw, output.Clone(), sourceHash, programHash, sdkHash, snapshotInputHash, resultReferenceInput, hostAuthentications);
        }
        if (output.TryGetProperty("resultReferenceProgramResult", out var unexpectedResult) && unexpectedResult.ValueKind != JsonValueKind.Null)
            throw new InvalidOperationException("A result-reference program was returned on the legacy execution lane.");
        var graph = output.GetProperty("graph").Clone();
        var graphHash = graph.GetProperty("graphHash").GetString()!;
        if (!FixedEquals(snapshotInputHash, graph.GetProperty("inputHash").GetString() ?? "")) throw new InvalidOperationException("Worker graph is not bound to the exact issued snapshot DTO input.");
        var admission = new DynamicWorkerAdmission
        {
            RuntimeInstanceId = runtimeId, LauncherExecutableHash = launcherHash, WorkerExecutableHash = workerExecutableHash, SandboxProfile = profile.ProfileName,
            WorkerProcessId = checked((int)worker.ProcessId), StartupNonceHash = startupNonceHash, TaskDirectoryIdentity = taskDirectoryIdentity,
            SourceHash = sourceHash, ProgramHash = programHash, SdkHash = sdkHash, OperationGraphHash = graphHash, DocumentFingerprint = document.ProjectFingerprint, DocumentSessionId = document.SessionId,
            CorrelationId = correlation, ExpiresUnixSeconds = DateTimeOffset.UtcNow.AddMinutes(2).ToUnixTimeSeconds()
        };
        admission.Signature = DynamicWire.SignAdmission(admission, signingKey);
        if (graph.GetProperty("operations").GetArrayLength() == 0)
        {
            var readReceipt = JsonSerializer.Serialize(new { schema = "dynamic-revit-read-report-receipt/v0", ok = true, sourceHash, programHash, sdkHash, inputHash = snapshotInputHash, graphHash, documentFingerprint = document.ProjectFingerprint, documentSessionId = document.SessionId, workerIdentity = admission, report = output.GetProperty("report").Clone(), logs = output.GetProperty("logs").Clone() }, Json);
            return new LiveEvidence { Schema = "dynamic-revit-phase2-live-evidence/v0", Ok = true, StartedUtc = started, CompletedUtc = DateTimeOffset.UtcNow, SandboxProfile = profile.ProfileName, TaskDirectory = taskRoot, RuntimeImageDirectory = workspace.RuntimeDirectory, RuntimeImageIdentity = workerRuntimePackageHash, RuntimeDependencyCount = workspace.RuntimeImage.Files.Count, RegistrationReceipt = registration, SnapshotReceipt = snapshotRaw, WorkerOutput = output.Clone(), Admission = admission, PreviewReceipt = readReceipt, HostAuthenticationReceipts = hostAuthentications, TargetRevitYear = selectedHost.RevitYear, ExpectedHostExecutable = bootstrap.ExpectedImage, ObservedHostExecutable = bootstrap.ObservedImage };
        }
        var previewRequest = JsonSerializer.Serialize(new { schema = "dynamic-revit-preview-request/v0", phase = "preview", sourceHash, programHash, sdkHash, documentFingerprint = document.ProjectFingerprint, documentSessionId = document.SessionId, snapshotToken, operationBudget = config.OperationBudget, graph, admission }, Json);
        var previewEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/preview", token, writeGrant, previewRequest, correlation);
        var previewRaw = UnwrapAuthenticated(previewEnvelope, hostSessionKey, runtimeId, "preview-receipt", out var previewAuthentication);
        hostAuthentications.Add(previewAuthentication);
        using var previewDoc = JsonDocument.Parse(previewRaw);
        var ok = previewDoc.RootElement.TryGetProperty("ok", out var okProperty) && okProperty.GetBoolean();
        string? applyAuthorizationRaw = null; string? applyRaw = null; DynamicProgramAdmissionV1? v1Admission = null;
        if (ok && config.Apply)
        {
            var previewId = previewDoc.RootElement.GetProperty("preview_id").GetString() ?? throw new InvalidOperationException("Preview did not return an apply seal.");
            var previewReceiptHash = DynamicWire.Sha256(previewRaw);
            var authorizationCore = JsonSerializer.Serialize(new { schema = "dynamic-revit-apply-authorization-request/v1", runtimeInstanceId = runtimeId, previewId, previewReceiptHash, maximumExecutionMilliseconds = Math.Min(Math.Max(config.ApplyDeadlineMs, 100), 5000) }, WireJson);
            var authorizationCorrelation = Guid.NewGuid().ToString("N"); var authorizationExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
            var authorizationRequest = JsonSerializer.Serialize(new { schema = "dynamic-revit-apply-authorization-request/v1", runtimeInstanceId = runtimeId, previewId, previewReceiptHash, maximumExecutionMilliseconds = Math.Min(Math.Max(config.ApplyDeadlineMs, 100), 5000), correlationId = authorizationCorrelation, authExpiresUnixSeconds = authorizationExpires, requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "authorize-apply", runtimeId, authorizationCorrelation, authorizationExpires, DynamicWire.Sha256(authorizationCore)) }, WireJson);
            var authorizationEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/authorize-apply", token, writeGrant, authorizationRequest, authorizationCorrelation);
            applyAuthorizationRaw = UnwrapAuthenticated(authorizationEnvelope, hostSessionKey, runtimeId, "authorize-apply-receipt", out var authorizationAuthentication);
            hostAuthentications.Add(authorizationAuthentication);
            using var authorizationDocument = JsonDocument.Parse(applyAuthorizationRaw); var authorizationRoot = authorizationDocument.RootElement;
            var authorizationId = authorizationRoot.GetProperty("authorization_id").GetString() ?? throw new InvalidOperationException("Apply authorization ID is missing.");
            var budget = authorizationRoot.GetProperty("effect_budget").Deserialize<DynamicEffectBudgetV1>(Json) ?? throw new InvalidOperationException("Host effect budget is missing.");
            var expectations = authorizationRoot.GetProperty("admission_expectations").Deserialize<DynamicProgramAdmissionExpectationsV1>(Json) ?? throw new InvalidOperationException("Host admission expectations are missing.");
            v1Admission = AdmissionFrom(expectations);
            v1Admission.AdmissionId = "admission_" + Guid.NewGuid().ToString("N"); v1Admission.CorrelationId = Guid.NewGuid().ToString("N");
            v1Admission.ReplayNonceHash = DynamicWire.Sha256(Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)));
            v1Admission.IssuedUnixSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds(); v1Admission.ExpiresUnixSeconds = Math.Min(authorizationRoot.GetProperty("expires_unix_seconds").GetInt64(), v1Admission.IssuedUnixSeconds + 60);
            v1Admission.AdmissionSignature = DynamicProgramAdmissionV1Policy.Sign(v1Admission, signingKey);
            var applyGraph = GraphForApply(graph);
            var applyRequest = JsonSerializer.Serialize(new { schema = "dynamic-revit-apply-request/v1", phase = "apply", runtime_instance_id = runtimeId, preview_id = previewId, authorization_id = authorizationId, graph = applyGraph, effect_budget = budget, admission = v1Admission }, SnakeJson);
            var applyEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/apply", token, writeGrant, applyRequest, v1Admission.CorrelationId);
            applyRaw = UnwrapAuthenticated(applyEnvelope, hostSessionKey, runtimeId, "apply-receipt", out var applyAuthentication); hostAuthentications.Add(applyAuthentication);
            using var applyDocument = JsonDocument.Parse(applyRaw); ok = applyDocument.RootElement.GetProperty("outcome").GetString() == "committed_verified";
        }
        HostReplayEvidence? replay = null;
        if (ok && replayAdmission && !config.Apply)
        {
            var freshSnapshotCorrelation = Guid.NewGuid().ToString("N");
            var freshSnapshotExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
            var freshSnapshotRequest = JsonSerializer.Serialize(new { category = config.Category, limit = config.Limit, parameters = config.Parameters, operationBudget = config.OperationBudget, runtimeInstanceId = runtimeId, correlationId = freshSnapshotCorrelation, authExpiresUnixSeconds = freshSnapshotExpires, requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "snapshot", runtimeId, freshSnapshotCorrelation, freshSnapshotExpires, DynamicWire.Sha256(snapshotCore)) }, WireJson);
            var freshSnapshotEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/snapshot", token, writeGrant, freshSnapshotRequest, freshSnapshotCorrelation);
            var freshSnapshotRaw = UnwrapAuthenticated(freshSnapshotEnvelope, hostSessionKey, runtimeId, "snapshot-receipt", out var freshSnapshotAuthentication);
            hostAuthentications.Add(freshSnapshotAuthentication);
            using var freshSnapshotDocument = JsonDocument.Parse(freshSnapshotRaw);
            var freshRoot = freshSnapshotDocument.RootElement;
            var freshToken = freshRoot.GetProperty("snapshot_token").GetString() ?? throw new InvalidOperationException("Fresh replay-test snapshot capability is missing.");
            var freshInputHash = freshRoot.GetProperty("input_hash").GetString() ?? throw new InvalidOperationException("Fresh replay-test input binding is missing.");
            var freshDocument = freshRoot.GetProperty("document").Deserialize<DynamicDocumentDto>(Json) ?? throw new InvalidOperationException("Fresh replay-test document DTO is missing.");
            var sameSnapshotBinding = FixedEquals(snapshotInputHash, freshInputHash)
                && FixedEquals(document.ProjectFingerprint, freshDocument.ProjectFingerprint)
                && FixedEquals(document.SessionId, freshDocument.SessionId);
            if (!sameSnapshotBinding) throw new InvalidOperationException("Rolled-back model did not reproduce the same snapshot binding for the replay test.");
            var replayRequest = JsonSerializer.Serialize(new { schema = "dynamic-revit-preview-request/v0", phase = "preview", sourceHash, programHash, sdkHash, documentFingerprint = document.ProjectFingerprint, documentSessionId = document.SessionId, snapshotToken = freshToken, operationBudget = config.OperationBudget, graph, admission }, Json);
            var replayResponse = await SendPost(config.BridgeUrl, "/revit/dynamic-runtime/preview", token, writeGrant, replayRequest, correlation);
            var replayRejected = !replayResponse.Success;
            replay = new HostReplayEvidence
            {
                FirstSubmissionAccepted = true,
                SecondSubmissionRejected = replayRejected,
                SameSignedAdmission = true,
                FreshSnapshotGrant = true,
                SameSnapshotBinding = sameSnapshotBinding,
                StatusCode = replayResponse.StatusCode,
                ResponseBody = replayResponse.Body
            };
            ok = ok && replayRejected;
        }
        return new LiveEvidence { Schema = config.Apply ? "dynamic-revit-live-evidence/v1" : "dynamic-revit-phase2-live-evidence/v0", Ok = ok, StartedUtc = started, CompletedUtc = DateTimeOffset.UtcNow, SandboxProfile = profile.ProfileName, TaskDirectory = taskRoot, RuntimeImageDirectory = workspace.RuntimeDirectory, RuntimeImageIdentity = workerRuntimePackageHash, RuntimeDependencyCount = workspace.RuntimeImage.Files.Count, RegistrationReceipt = registration, SnapshotReceipt = snapshotRaw, WorkerOutput = output.Clone(), Admission = admission, PreviewReceipt = previewRaw, ApplyAuthorizationReceipt = applyAuthorizationRaw, V1Admission = v1Admission, ApplyReceipt = applyRaw, HostAuthenticationReceipts = hostAuthentications, ReplayEvidence = replay, TargetRevitYear = selectedHost.RevitYear, ExpectedHostExecutable = bootstrap.ExpectedImage, ObservedHostExecutable = bootstrap.ObservedImage, Failure = ok ? null : replayAdmission && replay is not null && !replay.SecondSubmissionRejected ? "Revit host accepted a replayed signed worker admission." : config.Apply ? "Authorized Revit apply did not produce committed verification." : "Revit preview returned a structured failure." };
    }

    internal static void RequireDevelopmentLaboratory()
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE"), "development", StringComparison.Ordinal) ||
            !string.Equals(Environment.GetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE"), "laboratory", StringComparison.Ordinal))
            throw new InvalidOperationException("Trusted context-rule execution is available only in the exact development/laboratory profile.");
    }

    internal static DynamicContextRuleRecordV1 VerifyContextRuleRecord(string recordPath, string verificationKeyPath, DynamicTaskInput input,
        string expectedCompanyId, string expectedUserId, long nowUnixSeconds)
    {
        if (string.IsNullOrWhiteSpace(recordPath) || string.IsNullOrWhiteSpace(verificationKeyPath)) throw new InvalidOperationException("Context rule record and verification key files are required.");
        var record = JsonSerializer.Deserialize<DynamicContextRuleRecordV1>(File.ReadAllText(recordPath).TrimStart('\ufeff'), StrictJson)
            ?? throw new InvalidOperationException("Context rule record is empty.");
        DynamicContextRulePolicyV1.ValidateRecord(record);
        if (record.CompanyId != expectedCompanyId || record.UserId != expectedUserId || record.ProjectFingerprint != input.Document.ProjectFingerprint ||
            record.ActiveViewElementId != input.Document.ActiveViewId || record.IssuedUnixSeconds > nowUnixSeconds + 5 || record.ExpiresUnixSeconds <= nowUnixSeconds)
            throw new InvalidOperationException("Context rule company, project, user, active-view, or lifetime scope does not match the task.");
        byte[] key;
        try { key = Convert.FromBase64String(File.ReadAllText(verificationKeyPath).Trim()); }
        catch (Exception ex) { throw new InvalidOperationException("Context rule verification key is not valid base64.", ex); }
        if (key.Length != 32) throw new InvalidOperationException("Context rule verification key must be exactly 256 bits.");
        var expected = ContextRuleSignature(record.RecordHash, key);
        if (!FixedEquals(expected, record.Signature)) throw new InvalidOperationException("Context rule signature is invalid.");
        return record;
    }

    internal static string ContextRuleSignature(string recordHash, byte[] key)
    {
        if (!IsSha256(recordHash) || key == null || key.Length != 32) throw new ArgumentException("Context rule signature input is invalid.");
        using var hmac = new HMACSHA256(key);
        return "hmac-sha256:" + Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes("dynamic-revit-context-rule-signature/v1\n" + recordHash))).ToLowerInvariant();
    }

    private static bool IsSha256(string value) => value != null && value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal) && value.Substring(7).All(character => character >= '0' && character <= '9' || character >= 'a' && character <= 'f');

    private static async Task<ContextRuleExecutionInput> CollectContextRuleInput(LiveTaskConfig config, DynamicTaskInput input, string runtimeId,
        byte[] hostSessionKey, string token, string writeGrant, string workerRuntimePackageHash, List<string> hostAuthentications)
    {
        var record = VerifyContextRuleRecord(config.ContextRuleFile!, config.ContextRuleVerificationKeyFile!, input,
            config.ContextCompanyId, config.ContextUserId, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        var selector = new DynamicObservationSelectorV1
        {
            CategoryStableIds = record.TargetCategoryStableIds.OrderBy(value => value, StringComparer.Ordinal).ToArray(),
            VisibleInViewElementId = input.Document.ActiveViewId,
            ParameterNames = record.Conditions.Select(value => value.ParameterName).Append(record.Action.ParameterName).Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray(),
            IncludeTypeParameters = record.Conditions.Any(value => value.ParameterScope == "type") || record.Action.ParameterScope == "type",
            PageSize = DynamicObservationContractV1.MaximumPageSize
        };
        DynamicObservationPolicyV1.ValidateSelector(selector);
        var pages = new List<DynamicObservationEnvelopeV1>(); var receipts = new List<string>();
        for (var pageIndex = 0; pageIndex < 64; pageIndex++)
        {
            var core = JsonSerializer.Serialize(new { schema = "dynamic-revit-observation-request/v1", runtimeInstanceId = runtimeId, selector }, WireJson);
            var correlation = Guid.NewGuid().ToString("N"); var expires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
            var request = JsonSerializer.Serialize(new { schema = "dynamic-revit-observation-request/v1", runtimeInstanceId = runtimeId, selector,
                correlationId = correlation, authExpiresUnixSeconds = expires, requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "observe-v1", runtimeId, correlation, expires, DynamicWire.Sha256(core)) }, WireJson);
            var envelopeRaw = await Post(config.BridgeUrl, "/revit/dynamic-runtime/observe-v1", token, writeGrant, request, correlation);
            var receiptRaw = UnwrapAuthenticated(envelopeRaw, hostSessionKey, runtimeId, "observe-v1-receipt", out var authentication);
            hostAuthentications.Add(authentication); receipts.Add(receiptRaw);
            using var receiptDocument = JsonDocument.Parse(receiptRaw); var receipt = receiptDocument.RootElement;
            var page = receipt.GetProperty("envelope").Deserialize<DynamicObservationEnvelopeV1>(Json) ?? throw new InvalidOperationException("Context observation envelope is missing.");
            DynamicObservationPolicyV1.ValidateEnvelope(page);
            if (receipt.GetProperty("schema").GetString() != "dynamic-revit-observation-receipt/v1" || receipt.GetProperty("authorization_granted").GetBoolean() ||
                receipt.GetProperty("contract_manifest_hash").GetString() != DynamicObservationContractV1.ManifestHash || receipt.GetProperty("envelope_hash").GetString() != page.EnvelopeHash ||
                receipt.GetProperty("worker_runtime_package_hash").GetString() != workerRuntimePackageHash ||
                page.DocumentFingerprint != input.Document.ProjectFingerprint || page.DocumentSessionId != input.Document.SessionId ||
                pages.Count == 0 && page.PageOffset != 0 ||
                pages.Count > 0 && (page.RevisionHash != pages[0].RevisionHash || page.ScopeHash != pages[0].ScopeHash || page.PageOffset != pages.Sum(value => value.Elements.Count)))
                throw new InvalidOperationException("Context observation receipt or page binding is invalid, stale, or substituted.");
            pages.Add(page);
            if (page.NextCursor == null) break;
            selector.Cursor = page.NextCursor;
        }
        if (pages.Count == 0 || pages[^1].NextCursor != null || pages.Sum(value => value.Elements.Count) != pages[0].TotalCount)
            throw new InvalidOperationException("Context observation did not produce one complete bounded active-view candidate set.");
        selector.Cursor = null;
        var key = Convert.FromBase64String(File.ReadAllText(config.ContextRuleVerificationKeyFile!).Trim());
        var rule = new DynamicVerifiedContextRuleV1
        {
            RecordId = record.RecordId, RecordHash = record.RecordHash, CompanyId = record.CompanyId, ProjectFingerprint = record.ProjectFingerprint,
            UserId = record.UserId, ActiveViewElementId = record.ActiveViewElementId, TargetCategoryStableIds = record.TargetCategoryStableIds.ToArray(),
            Conditions = record.Conditions.ToArray(), Action = record.Action, IssuedUnixSeconds = record.IssuedUnixSeconds, ExpiresUnixSeconds = record.ExpiresUnixSeconds,
            VerificationKeyHash = DynamicWire.Sha256(Convert.ToBase64String(key)), WorkerRuntimePackageHash = workerRuntimePackageHash,
            ObservationScopeHash = pages[0].ScopeHash, ObservationRevisionHash = pages[0].RevisionHash
        };
        rule.BindingHash = DynamicContextRulePolicyV1.BindingHash(rule); DynamicContextRulePolicyV1.ValidateBinding(rule);
        return new ContextRuleExecutionInput { Rule = rule, Selector = selector, Pages = pages, ObservationReceiptBodies = receipts, DocumentRevision = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
    }

    private static async Task<LiveEvidence> CompleteCoreContextTask(LiveTaskConfig config, DateTimeOffset started, string taskRoot,
        TaskWorkspace workspace, WindowsSandboxProfile profile, RevitHostCapability selectedHost, BootstrapCompletion bootstrap, string runtimeId,
        byte[] hostSessionKey, string token, string writeGrant, string registration, string snapshotRaw, JsonElement output, string sourceHash,
        string programHash, string sdkHash, string snapshotInputHash, ContextRuleExecutionInput contextInput, List<string> hostAuthentications)
    {
        if (!output.TryGetProperty("coreProgramResult", out var resultElement) || resultElement.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("Worker did not return a core-v1 program result.");
        var result = resultElement.Deserialize<DynamicCoreProgramResultV1>(Json) ?? throw new InvalidOperationException("Core-v1 program result is malformed.");
        var rule = contextInput.Rule; DynamicContextRulePolicyV1.ValidateBinding(rule);
        if (result.Schema != "dynamic-revit-core-program-result/v1" || result.Graph.InputHash != snapshotInputHash ||
            result.Graph.DocumentFingerprint != rule.ProjectFingerprint || result.Graph.DocumentRevision != contextInput.DocumentRevision ||
            result.Graph.ContextRuleRecordId != rule.RecordId || result.Graph.ContextRuleRecordHash != rule.RecordHash ||
            result.Graph.ContextRuleBindingHash != rule.BindingHash || result.Graph.GraphHash != DynamicOperationGraphV1Admission.GraphHash(result.Graph))
            throw new InvalidOperationException("Core-v1 graph lost its exact worker-input or verified context-rule binding.");
        if (rule.ExpiresUnixSeconds <= DateTimeOffset.UtcNow.ToUnixTimeSeconds())
            throw new InvalidOperationException("The verified context rule expired before preview admission.");
        var budget = config.CoreEffectBudget ?? throw new InvalidOperationException("Core-v1 effect budget is missing.");
        var nonceHash = DynamicWire.Sha256(Guid.NewGuid().ToString("N"));
        var planned = Math.Min(Math.Max(config.CorePlannedExecutionMilliseconds, 1), 5000);
        var previewCore = JsonSerializer.Serialize(new { schema = "dynamic-revit-core-preview-request/v1", runtimeInstanceId = runtimeId,
            graph = result.Graph, effectBudget = budget, plannedExecutionMilliseconds = planned, nonceHash }, WireJson);
        var previewCorrelation = Guid.NewGuid().ToString("N"); var previewExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
        var previewRequest = JsonSerializer.Serialize(new { schema = "dynamic-revit-core-preview-request/v1", runtimeInstanceId = runtimeId,
            graph = result.Graph, effectBudget = budget, plannedExecutionMilliseconds = planned, nonceHash, correlationId = previewCorrelation,
            authExpiresUnixSeconds = previewExpires, requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "core-preview-v1", runtimeId, previewCorrelation, previewExpires, DynamicWire.Sha256(previewCore)) }, WireJson);
        var previewEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/core-preview-v1", token, writeGrant, previewRequest, previewCorrelation);
        var previewRaw = UnwrapAuthenticated(previewEnvelope, hostSessionKey, runtimeId, "core-preview-v1-receipt", out var previewAuthentication);
        hostAuthentications.Add(previewAuthentication);
        using var previewDocument = JsonDocument.Parse(previewRaw); var preview = previewDocument.RootElement;
        var ok = preview.GetProperty("schema").GetString() == "dynamic-revit-core-preview-receipt/v1" &&
            preview.GetProperty("outcome").GetString() == "preview_rolled_back_verified" && !preview.GetProperty("authorization_granted").GetBoolean() &&
            preview.GetProperty("graph_hash").GetString() == result.Graph.GraphHash && preview.GetProperty("context_rule_record_id").GetString() == rule.RecordId &&
            preview.GetProperty("context_rule_record_hash").GetString() == rule.RecordHash && preview.GetProperty("context_rule_binding_hash").GetString() == rule.BindingHash;
        string? authorizationRaw = null; string? applyRaw = null;
        if (ok && config.Apply)
        {
            if (rule.ExpiresUnixSeconds <= DateTimeOffset.UtcNow.ToUnixTimeSeconds())
                throw new InvalidOperationException("The verified context rule expired before apply authorization.");
            var previewId = preview.GetProperty("preview_id").GetString() ?? throw new InvalidOperationException("Core-v1 preview ID is missing.");
            var previewHash = preview.GetProperty("preview_hash").GetString() ?? throw new InvalidOperationException("Core-v1 preview hash is missing.");
            var authorizationCore = JsonSerializer.Serialize(new { schema = "dynamic-revit-core-authorize-request/v1", runtimeInstanceId = runtimeId, previewId, previewHash }, WireJson);
            var authorizationCorrelation = Guid.NewGuid().ToString("N"); var authorizationExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
            var authorizationRequest = JsonSerializer.Serialize(new { schema = "dynamic-revit-core-authorize-request/v1", runtimeInstanceId = runtimeId,
                previewId, previewHash, correlationId = authorizationCorrelation, authExpiresUnixSeconds = authorizationExpires,
                requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "core-authorize-v1", runtimeId, authorizationCorrelation, authorizationExpires, DynamicWire.Sha256(authorizationCore)) }, WireJson);
            var authorizationEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/core-authorize-v1", token, writeGrant, authorizationRequest, authorizationCorrelation);
            authorizationRaw = UnwrapAuthenticated(authorizationEnvelope, hostSessionKey, runtimeId, "core-authorize-v1-receipt", out var authorizationAuthentication);
            hostAuthentications.Add(authorizationAuthentication);
            using var authorizationDocument = JsonDocument.Parse(authorizationRaw); var authorization = authorizationDocument.RootElement;
            if (!authorization.GetProperty("authorization_granted").GetBoolean() || authorization.GetProperty("context_rule_binding_hash").GetString() != rule.BindingHash)
                throw new InvalidOperationException("Core-v1 apply authorization lost its verified context-rule binding.");
            if (rule.ExpiresUnixSeconds <= DateTimeOffset.UtcNow.ToUnixTimeSeconds())
                throw new InvalidOperationException("The verified context rule expired before apply dispatch.");
            var authorizationId = authorization.GetProperty("authorization_id").GetString() ?? throw new InvalidOperationException("Core-v1 authorization ID is missing.");
            var applyCore = JsonSerializer.Serialize(new { schema = "dynamic-revit-core-apply-request/v1", phase = "apply", runtimeInstanceId = runtimeId, previewId, authorizationId }, WireJson);
            var applyCorrelation = Guid.NewGuid().ToString("N"); var applyExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
            var applyRequest = JsonSerializer.Serialize(new { schema = "dynamic-revit-core-apply-request/v1", phase = "apply", runtimeInstanceId = runtimeId,
                previewId, authorizationId, correlationId = applyCorrelation, authExpiresUnixSeconds = applyExpires,
                requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "core-apply-v1", runtimeId, applyCorrelation, applyExpires, DynamicWire.Sha256(applyCore)) }, WireJson);
            var applyEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/core-apply-v1", token, writeGrant, applyRequest, applyCorrelation);
            applyRaw = UnwrapAuthenticated(applyEnvelope, hostSessionKey, runtimeId, "core-apply-v1-receipt", out var applyAuthentication);
            hostAuthentications.Add(applyAuthentication);
            using var applyDocument = JsonDocument.Parse(applyRaw); var apply = applyDocument.RootElement;
            ok = apply.GetProperty("outcome").GetString() == "committed_verified" && apply.GetProperty("graph_hash").GetString() == result.Graph.GraphHash &&
                apply.GetProperty("context_rule_record_id").GetString() == rule.RecordId && apply.GetProperty("context_rule_record_hash").GetString() == rule.RecordHash &&
                apply.GetProperty("context_rule_binding_hash").GetString() == rule.BindingHash;
        }
        return new LiveEvidence
        {
            Schema = "dynamic-revit-context-rule-live-evidence/v1", Ok = ok, StartedUtc = started, CompletedUtc = DateTimeOffset.UtcNow,
            SandboxProfile = profile.ProfileName, TaskDirectory = taskRoot, RuntimeImageDirectory = workspace.RuntimeDirectory,
            RuntimeImageIdentity = workspace.RuntimeImage.Identity, RuntimeDependencyCount = workspace.RuntimeImage.Files.Count,
            RegistrationReceipt = registration, SnapshotReceipt = snapshotRaw, WorkerOutput = output, PreviewReceipt = previewRaw,
            ApplyAuthorizationReceipt = authorizationRaw, ApplyReceipt = applyRaw, HostAuthenticationReceipts = hostAuthentications,
            ContextObservationReceipts = contextInput.ObservationReceiptBodies, ContextRule = rule,
            TargetRevitYear = selectedHost.RevitYear, ExpectedHostExecutable = bootstrap.ExpectedImage, ObservedHostExecutable = bootstrap.ObservedImage,
            Failure = ok ? null : config.Apply ? "Authorized context-rule core apply did not produce committed verification." : "Context-rule core preview did not produce rollback truth."
        };
    }

    internal static void ValidateResultReferenceObservationContext(DynamicTaskInput input, ResultReferenceObservationInput observation)
    {
        if (input == null || observation == null) throw new ArgumentNullException(input == null ? nameof(input) : nameof(observation));
        var context = new DynamicResultReferenceProgramContextV1(input, observation.DocumentRevision, observation.SnapshotHash,
            observation.ScopeHash, observation.Pages, observation.TrustedExternalTargets);
        foreach (var target in observation.TrustedExternalTargets) _ = context.ExternalTarget(target.UniqueId);
    }

    private static async Task<ResultReferenceObservationInput> CollectResultReferenceInputs(LiveTaskConfig config, string runtimeId,
        byte[] hostSessionKey, string token, string writeGrant, string workerRuntimePackageHash, List<string> hostAuthentications)
    {
        var selector = Clone(config.BuildingSystemsSelector ?? throw new InvalidOperationException("Building-systems selector is missing."));
        DynamicBuildingSystemsObservationPolicyV1.ValidateSelector(selector);
        var pages = new List<DynamicBuildingSystemsEnvelopeV1>();
        var receiptBodies = new List<string>();
        string? snapshotId = null; string? snapshotHash = null; string? scopeHash = null; long? revision = null;
        for (var pageIndex = 0; pageIndex < 64; pageIndex++)
        {
            var core = JsonSerializer.Serialize(new { schema = "dynamic-revit-building-systems-request/v1", runtimeInstanceId = runtimeId, selector, snapshotId }, WireJson);
            var correlation = Guid.NewGuid().ToString("N"); var expires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
            var request = JsonSerializer.Serialize(new
            {
                schema = "dynamic-revit-building-systems-request/v1", runtimeInstanceId = runtimeId, selector, snapshotId,
                correlationId = correlation, authExpiresUnixSeconds = expires,
                requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "observe-building-systems-v1", runtimeId, correlation, expires, DynamicWire.Sha256(core))
            }, WireJson);
            var envelopeRaw = await Post(config.BridgeUrl, "/revit/dynamic-runtime/observe-building-systems-v1", token, writeGrant, request, correlation);
            var receiptRaw = UnwrapAuthenticated(envelopeRaw, hostSessionKey, runtimeId, "observe-building-systems-v1-receipt", out var authentication);
            hostAuthentications.Add(authentication); receiptBodies.Add(receiptRaw);
            using var receiptDocument = JsonDocument.Parse(receiptRaw); var receipt = receiptDocument.RootElement;
            var schemaMatches = receipt.GetProperty("schema").GetString() == "dynamic-revit-building-systems-receipt/v1";
            var nonAuthorizing = !receipt.GetProperty("authorization_granted").GetBoolean();
            var contractMatches = receipt.GetProperty("contract_manifest_hash").GetString() == DynamicBuildingSystemsObservationContractV1.ManifestHash;
            var sdkMatches = receipt.GetProperty("sdk_manifest_hash").GetString() == DynamicRevitSdkProductionVersion.ManifestHash;
            var workerPackageMatches = FixedEquals(receipt.GetProperty("worker_runtime_package_hash").GetString() ?? "", workerRuntimePackageHash);
            if (!schemaMatches || !nonAuthorizing || !contractMatches || !sdkMatches || !workerPackageMatches)
                throw new InvalidOperationException("Building-systems observation receipt identity is invalid or substituted. Checks: schema=" + schemaMatches +
                    ", nonAuthorizing=" + nonAuthorizing + ", contract=" + contractMatches + ", sdk=" + sdkMatches + ", workerPackage=" + workerPackageMatches + ".");
            var page = receipt.GetProperty("envelope").Deserialize<DynamicBuildingSystemsEnvelopeV1>(Json) ?? throw new InvalidOperationException("Building-systems envelope is missing.");
            DynamicBuildingSystemsObservationPolicyV1.ValidateEnvelope(page);
            if (receipt.GetProperty("envelope_hash").GetString() != page.EnvelopeHash || receipt.GetProperty("document_fingerprint").GetString() != page.DocumentFingerprint ||
                receipt.GetProperty("document_session_id").GetString() != page.DocumentSessionId || receipt.GetProperty("document_revision").GetInt64() != page.DocumentRevision)
                throw new InvalidOperationException("Building-systems receipt and envelope bindings differ.");
            var receivedSnapshotId = receipt.GetProperty("snapshot_id").GetString() ?? throw new InvalidOperationException("Building-systems snapshot ID is missing.");
            if (snapshotId == null)
            {
                snapshotId = receivedSnapshotId; snapshotHash = page.SnapshotHash; scopeHash = page.ScopeHash; revision = page.DocumentRevision;
            }
            else if (snapshotId != receivedSnapshotId || snapshotHash != page.SnapshotHash || scopeHash != page.ScopeHash || revision != page.DocumentRevision)
                throw new InvalidOperationException("Building-systems pages do not share one exact snapshot/revision/scope.");
            if (page.PageOffset != pages.Sum(value => value.Facts.Count) || pages.Count > 0 && page.PageSize != pages[0].PageSize ||
                pages.Count > 0 && page.TotalCount != pages[0].TotalCount)
                throw new InvalidOperationException("Building-systems pages are not contiguous or canonical.");
            pages.Add(page);
            if (page.NextCursor == null) break;
            selector.Cursor = page.NextCursor;
        }
        if (pages.Count == 0 || pages[^1].NextCursor != null || pages.Sum(value => value.Facts.Count) != pages[0].TotalCount)
            throw new InvalidOperationException("Building-systems observation did not produce a complete bounded page set.");

        selector.Cursor = null;
        var targetIds = (config.ResultReferenceTargetUniqueIds.Length == 0 ? selector.ElementUniqueIds : config.ResultReferenceTargetUniqueIds).ToArray();
        var factsCore = JsonSerializer.Serialize(new { schema = "dynamic-revit-result-reference-facts-request/v1", runtimeInstanceId = runtimeId,
            snapshotId, selector, targetUniqueIds = targetIds }, WireJson);
        var factsCorrelation = Guid.NewGuid().ToString("N"); var factsExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
        var factsRequest = JsonSerializer.Serialize(new
        {
            schema = "dynamic-revit-result-reference-facts-request/v1", runtimeInstanceId = runtimeId, snapshotId, selector, targetUniqueIds = targetIds,
            correlationId = factsCorrelation, authExpiresUnixSeconds = factsExpires,
            requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "result-reference-facts-v1", runtimeId, factsCorrelation, factsExpires, DynamicWire.Sha256(factsCore))
        }, WireJson);
        var factsEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/result-reference-facts-v1", token, writeGrant, factsRequest, factsCorrelation);
        var factsRaw = UnwrapAuthenticated(factsEnvelope, hostSessionKey, runtimeId, "result-reference-facts-v1-receipt", out var factsAuthentication);
        hostAuthentications.Add(factsAuthentication);
        using var factsDocument = JsonDocument.Parse(factsRaw); var factsReceipt = factsDocument.RootElement;
        var facts = factsReceipt.GetProperty("facts").Deserialize<List<DynamicTrustedElementFactV1>>(Json) ?? throw new InvalidOperationException("Trusted result-reference facts are missing.");
        if (factsReceipt.GetProperty("schema").GetString() != "dynamic-revit-result-reference-facts-receipt/v1" || factsReceipt.GetProperty("authorization_granted").GetBoolean() ||
            factsReceipt.GetProperty("snapshot_id").GetString() != snapshotId || factsReceipt.GetProperty("snapshot_hash").GetString() != snapshotHash ||
            factsReceipt.GetProperty("scope_hash").GetString() != scopeHash || factsReceipt.GetProperty("document_revision").GetInt64() != revision ||
            factsReceipt.GetProperty("result_reference_manifest_hash").GetString() != DynamicResultReferenceManifestV1.ManifestHash ||
            factsReceipt.GetProperty("facts_hash").GetString() != TrustedFactsHash(facts))
            throw new InvalidOperationException("Trusted result-reference fact receipt is invalid or substituted.");
        return new ResultReferenceObservationInput
        {
            SnapshotId = snapshotId!, SnapshotHash = snapshotHash!, ScopeHash = scopeHash!, DocumentRevision = revision!.Value,
            Selector = selector, Pages = pages, TrustedExternalTargets = facts, ObservationReceiptBodies = receiptBodies, FactsReceiptBody = factsRaw
        };
    }

    private static async Task<LiveEvidence> CompleteResultReferenceTask(LiveTaskConfig config, DateTimeOffset started, string taskRoot,
        TaskWorkspace workspace, WindowsSandboxProfile profile, RevitHostCapability selectedHost, BootstrapCompletion bootstrap, string runtimeId,
        byte[] hostSessionKey, string token, string writeGrant, string registration, string snapshotRaw, JsonElement output, string sourceHash,
        string programHash, string sdkHash, string snapshotInputHash, ResultReferenceObservationInput observation, List<string> hostAuthentications)
    {
        if (output.TryGetProperty("graph", out var legacyGraph) && legacyGraph.ValueKind != JsonValueKind.Null)
            throw new InvalidOperationException("Worker returned both legacy and result-reference graph lanes.");
        if (!output.TryGetProperty("resultReferenceProgramResult", out var resultElement) || resultElement.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("Worker did not return a result-reference program result.");
        var result = resultElement.Deserialize<DynamicResultReferenceProgramResultV1>(Json) ?? throw new InvalidOperationException("Result-reference program result is malformed.");
        if (result.Schema != DynamicResultReferenceContractV1.ProgramResultSchema || result.ContractManifestHash != DynamicResultReferenceManifestV1.ManifestHash)
            throw new InvalidOperationException("Result-reference program result contract was substituted.");
        DynamicResultReferencePolicyV1.ValidateWorkerOutput(result.Graph, snapshotInputHash, result.Graph.DocumentFingerprint, result.Graph.DocumentSessionId, observation.DocumentRevision);
        if (result.Graph.DocumentFingerprint != observation.Pages[0].DocumentFingerprint || result.Graph.DocumentSessionId != observation.Pages[0].DocumentSessionId ||
            result.Graph.DocumentRevision != observation.DocumentRevision)
            throw new InvalidOperationException("Result-reference graph does not bind the authenticated observation document/session/revision.");
        var budget = config.ResultReferenceEffectBudget ?? throw new InvalidOperationException("Result-reference effect budget is missing.");
        var resultFamily = ResultReferenceFamily(result.Graph);
        var resultPrefix = resultFamily == "annotation" ? "annotation-result" : "mep-result";
        var envelopeHashes = observation.Pages.Select(value => value.EnvelopeHash).ToArray();
        var previewCore = JsonSerializer.Serialize(new
        {
            schema = "dynamic-revit-" + resultPrefix + "-preview-request/v1", runtimeInstanceId = runtimeId, snapshotId = observation.SnapshotId,
            selector = observation.Selector, observationEnvelopeHashes = envelopeHashes, sourceHash, programHash, sdkHash, graph = result.Graph, effectBudget = budget
        }, WireJson);
        var previewCorrelation = Guid.NewGuid().ToString("N"); var previewExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
        var previewRequest = JsonSerializer.Serialize(new
        {
            schema = "dynamic-revit-" + resultPrefix + "-preview-request/v1", runtimeInstanceId = runtimeId, snapshotId = observation.SnapshotId,
            selector = observation.Selector, observationEnvelopeHashes = envelopeHashes, sourceHash, programHash, sdkHash, graph = result.Graph, effectBudget = budget,
            correlationId = previewCorrelation, authExpiresUnixSeconds = previewExpires,
            requestMac = DynamicWire.SignSessionMessage(hostSessionKey, resultPrefix + "-preview-v1", runtimeId, previewCorrelation, previewExpires, DynamicWire.Sha256(previewCore))
        }, WireJson);
        var previewEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/" + resultPrefix + "-preview-v1", token, writeGrant, previewRequest, previewCorrelation);
        var previewRaw = UnwrapAuthenticated(previewEnvelope, hostSessionKey, runtimeId, resultPrefix + "-preview-v1-receipt", out var previewAuthentication);
        hostAuthentications.Add(previewAuthentication);
        using var previewDocument = JsonDocument.Parse(previewRaw); var preview = previewDocument.RootElement;
        var ok = preview.GetProperty("schema").GetString() == "dynamic-revit-" + resultPrefix + "-preview-receipt/v1" &&
            preview.GetProperty("outcome").GetString() == "preview_rolled_back_verified" && !preview.GetProperty("authorization_granted").GetBoolean() &&
            preview.GetProperty("graph_hash").GetString() == result.Graph.GraphHash && preview.GetProperty("source_hash").GetString() == sourceHash &&
            preview.GetProperty("program_hash").GetString() == programHash && preview.GetProperty("sdk_hash").GetString() == sdkHash;
        string? authorizationRaw = null; string? applyRaw = null;
        if (ok && config.Apply)
        {
            var previewId = preview.GetProperty("preview_id").GetString() ?? throw new InvalidOperationException("Result-reference preview ID is missing.");
            var previewHash = preview.GetProperty("preview_hash").GetString() ?? throw new InvalidOperationException("Result-reference preview hash is missing.");
            var authorizationCore = JsonSerializer.Serialize(new { schema = "dynamic-revit-" + resultPrefix + "-authorize-request/v1", runtimeInstanceId = runtimeId, previewId, previewHash }, WireJson);
            var authorizationCorrelation = Guid.NewGuid().ToString("N"); var authorizationExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
            var authorizationRequest = JsonSerializer.Serialize(new
            {
                schema = "dynamic-revit-" + resultPrefix + "-authorize-request/v1", runtimeInstanceId = runtimeId, previewId, previewHash,
                correlationId = authorizationCorrelation, authExpiresUnixSeconds = authorizationExpires,
                requestMac = DynamicWire.SignSessionMessage(hostSessionKey, resultPrefix + "-authorize-v1", runtimeId, authorizationCorrelation, authorizationExpires, DynamicWire.Sha256(authorizationCore))
            }, WireJson);
            var authorizationEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/" + resultPrefix + "-authorize-v1", token, writeGrant, authorizationRequest, authorizationCorrelation);
            authorizationRaw = UnwrapAuthenticated(authorizationEnvelope, hostSessionKey, runtimeId, resultPrefix + "-authorize-v1-receipt", out var authorizationAuthentication);
            hostAuthentications.Add(authorizationAuthentication);
            using var authorizationDocument = JsonDocument.Parse(authorizationRaw); var authorization = authorizationDocument.RootElement;
            if (!authorization.GetProperty("authorization_granted").GetBoolean()) throw new InvalidOperationException("Result-reference apply authorization was not granted.");
            var authorizationId = authorization.GetProperty("authorization_id").GetString() ?? throw new InvalidOperationException("Result-reference authorization ID is missing.");
            var applyCore = JsonSerializer.Serialize(new { schema = "dynamic-revit-" + resultPrefix + "-apply-request/v1", phase = "apply", runtimeInstanceId = runtimeId, previewId, authorizationId }, WireJson);
            var applyCorrelation = Guid.NewGuid().ToString("N"); var applyExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
            var applyRequest = JsonSerializer.Serialize(new
            {
                schema = "dynamic-revit-" + resultPrefix + "-apply-request/v1", phase = "apply", runtimeInstanceId = runtimeId, previewId, authorizationId,
                correlationId = applyCorrelation, authExpiresUnixSeconds = applyExpires,
                requestMac = DynamicWire.SignSessionMessage(hostSessionKey, resultPrefix + "-apply-v1", runtimeId, applyCorrelation, applyExpires, DynamicWire.Sha256(applyCore))
            }, WireJson);
            var applyEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/" + resultPrefix + "-apply-v1", token, writeGrant, applyRequest, applyCorrelation);
            applyRaw = UnwrapAuthenticated(applyEnvelope, hostSessionKey, runtimeId, resultPrefix + "-apply-v1-receipt", out var applyAuthentication);
            hostAuthentications.Add(applyAuthentication);
            using var applyDocument = JsonDocument.Parse(applyRaw); var apply = applyDocument.RootElement;
            ok = apply.GetProperty("outcome").GetString() == "committed_verified" && apply.GetProperty("graph_hash").GetString() == result.Graph.GraphHash &&
                apply.GetProperty("source_hash").GetString() == sourceHash && apply.GetProperty("program_hash").GetString() == programHash && apply.GetProperty("sdk_hash").GetString() == sdkHash;
        }
        return new LiveEvidence
        {
            Schema = "dynamic-revit-result-reference-live-evidence/v1", Ok = ok, StartedUtc = started, CompletedUtc = DateTimeOffset.UtcNow,
            SandboxProfile = profile.ProfileName, TaskDirectory = taskRoot, RuntimeImageDirectory = workspace.RuntimeDirectory,
            RuntimeImageIdentity = workspace.RuntimeImage.Identity, RuntimeDependencyCount = workspace.RuntimeImage.Files.Count,
            RegistrationReceipt = registration, SnapshotReceipt = snapshotRaw, BuildingSystemsObservationReceipts = observation.ObservationReceiptBodies,
            ResultReferenceFactsReceipt = observation.FactsReceiptBody, WorkerOutput = output, PreviewReceipt = previewRaw,
            ApplyAuthorizationReceipt = authorizationRaw, ApplyReceipt = applyRaw, HostAuthenticationReceipts = hostAuthentications,
            TargetRevitYear = selectedHost.RevitYear, ExpectedHostExecutable = bootstrap.ExpectedImage, ObservedHostExecutable = bootstrap.ObservedImage,
            Failure = ok ? null : config.Apply ? "Authorized " + resultFamily + " result-reference apply did not produce committed verification." : resultFamily + " result-reference preview did not produce rollback truth."
        };
    }

    internal static string ResultReferenceFamily(DynamicResultReferenceGraphV1 graph)
    {
        if (graph == null || graph.Nodes == null || graph.Nodes.Count == 0) throw new InvalidOperationException("Result-reference graph is empty.");
        if (graph.Nodes.All(node => DynamicAnnotationOperationManifestV1.Find(node.Kind) != null)) return "annotation";
        if (graph.Nodes.All(node => DynamicMepMutationManifestV1.Find(node.Kind) != null)) return "mep";
        throw new InvalidOperationException("Result-reference graph must contain one activated primitive family only.");
    }

    private static string TrustedFactsHash(IEnumerable<DynamicTrustedElementFactV1> facts) => DynamicWire.Sha256(
        "dynamic-result-reference-trusted-facts/v1\n" + string.Join("\n", facts.OrderBy(value => value.UniqueId, StringComparer.Ordinal).Select(value =>
            CanonicalJoin(value.UniqueId, value.ElementId.ToString(System.Globalization.CultureInfo.InvariantCulture), value.DocumentFingerprint,
                value.CategoryStableId, value.TypeUniqueId, value.StateHash, value.Exists ? "1" : "0", value.Verified ? "1" : "0", value.Visible ? "1" : "0"))));

    private static string CanonicalJoin(params string?[] values)
    {
        var builder = new StringBuilder();
        foreach (var value in values)
            if (value == null) builder.Append("-\n"); else builder.Append('+').Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(value))).Append('\n');
        return builder.ToString();
    }

    private static T Clone<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, Json), Json)
        ?? throw new InvalidOperationException("Dynamic runtime configuration could not be cloned.");

    private static DynamicProgramAdmissionV1 AdmissionFrom(DynamicProgramAdmissionExpectationsV1 value) => new()
    {
        NormalizedSourceHash = value.NormalizedSourceHash, CompiledArtifactHash = value.CompiledArtifactHash, CompilerRuntimeHash = value.CompilerRuntimeHash,
        SdkVersion = value.SdkVersion, SdkManifestHash = value.SdkManifestHash, SdkArtifactHash = value.SdkArtifactHash,
        WorkerExecutableHash = value.WorkerExecutableHash, WorkerRuntimePackageHash = value.WorkerRuntimePackageHash,
        SandboxProfileVersion = value.SandboxProfileVersion, SandboxProfileHash = value.SandboxProfileHash,
        AuthenticatedWorkerIdentityHash = value.AuthenticatedWorkerIdentityHash, TargetRevitVersion = value.TargetRevitVersion,
        HostAdapterManifestHash = value.HostAdapterManifestHash, DocumentFingerprint = value.DocumentFingerprint, DocumentSessionId = value.DocumentSessionId,
        DocumentRevision = value.DocumentRevision, ProjectContextIdentityHash = value.ProjectContextIdentityHash, CapabilityEnvelopeHash = value.CapabilityEnvelopeHash,
        OperationFamilyEnvelopeHash = value.OperationFamilyEnvelopeHash, EffectBudgetHash = value.EffectBudgetHash, FileCapabilitySetHash = value.FileCapabilitySetHash,
        OperationGraphHash = value.OperationGraphHash, PreviewReceiptHash = value.PreviewReceiptHash, PolicyIdentityHash = value.PolicyIdentityHash,
        RuntimeIdentityHash = value.RuntimeIdentityHash, RequestFamilySealHash = value.RequestFamilySealHash, FinalAuthorizationHash = value.FinalAuthorizationHash,
        PrincipalIdHash = value.PrincipalIdHash, PrincipalSessionHash = value.PrincipalSessionHash
    };

    private static async Task<string> Post(string baseUrl, string path, string token, string writeGrant, string json, string correlation)
    {
        var response = await SendPost(baseUrl, path, token, writeGrant, json, correlation);
        if (!response.Success) throw new InvalidOperationException("Bridge " + path + " returned " + response.StatusCode + ": " + response.Body);
        return response.Body;
    }

    private static async Task<HttpPostResult> SendPost(string baseUrl, string path, string token, string writeGrant, string json, string correlation)
    {
        // Revit external events run on the UI thread and can legitimately wait behind regeneration,
        // printing, or another add-in callback. Keep the network envelope above the bounded worker
        // and apply deadlines so a healthy queued event is not abandoned while still in the host.
        using var client = new HttpClient { Timeout = BridgeRequestTimeout };
        using var request = new HttpRequestMessage(HttpMethod.Post, baseUrl.TrimEnd('/') + path) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        request.Headers.TryAddWithoutValidation("X-Operator-Token", token);
        request.Headers.TryAddWithoutValidation("X-Operator-Write-Grant", writeGrant);
        request.Headers.TryAddWithoutValidation("X-Operator-Correlation-Id", correlation);
        using var response = await client.SendAsync(request);
        var body = await response.Content.ReadAsStringAsync();
        return new HttpPostResult(response.IsSuccessStatusCode, (int)response.StatusCode, body);
    }

    internal static string ReadWriteGrantForMode(string operatorTokenFile, bool apply)
    {
        if (!apply) return "";
        var grantPath = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(operatorTokenFile))!, "write_grant.json");
        if (!File.Exists(grantPath)) throw new InvalidOperationException("Operator write-grant file is missing. Issue a session grant before running a live task.");
        using var document = JsonDocument.Parse(File.ReadAllText(grantPath).TrimStart('\ufeff'));
        var token = document.RootElement.TryGetProperty("token", out var property) ? property.GetString()?.Trim() : null;
        if (string.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("Operator write-grant file is empty or invalid.");
        return token;
    }

    internal static DynamicOperationGraph GraphForApply(JsonElement graph)
    {
        var typed = graph.Deserialize<DynamicOperationGraph>(Json) ?? throw new InvalidOperationException("Worker graph is invalid.");
        var wireHash = graph.TryGetProperty("graphHash", out var property) ? property.GetString() : null;
        if (string.IsNullOrWhiteSpace(wireHash) || !FixedEquals(wireHash, typed.GraphHash))
            throw new InvalidOperationException("Worker graph identity was lost before apply serialization.");
        return typed;
    }

    private static async Task<BootstrapCompletion> CompleteBootstrap(string challengeRaw, string runtimeId, byte[] sessionKey, string launcherHash, RevitHostCapability selectedHost)
    {
        using var challengeDocument = JsonDocument.Parse(challengeRaw);
        var root = challengeDocument.RootElement;
        if (root.GetProperty("schema").GetString() != "dynamic-revit-bootstrap-challenge/v0") throw new InvalidOperationException("Revit returned an invalid dynamic bootstrap challenge.");
        var pipeName = root.GetProperty("pipe_name").GetString() ?? throw new InvalidOperationException("Dynamic bootstrap pipe name is missing.");
        var challenge = root.GetProperty("challenge_nonce").GetString() ?? throw new InvalidOperationException("Dynamic bootstrap nonce is missing.");
        var claimedRevitPid = root.GetProperty("revit_process_id").GetInt32();
        var expires = root.GetProperty("expires_unix_seconds").GetInt64();
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        pipe.Connect(5_000);
        if (!Native.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var observedRevitPid) || observedRevitPid != claimedRevitPid) throw new InvalidOperationException("Dynamic bootstrap server PID did not match the kernel-observed named-pipe server.");
        string observedImage;
        var expectedImage = selectedHost.ResolveExpectedExecutable(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
        using (var server = Process.GetProcessById(claimedRevitPid))
        {
            observedImage = Path.GetFullPath(server.MainModule?.FileName ?? "");
            if (!string.Equals(observedImage, expectedImage, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException($"Dynamic bootstrap pipe is not hosted by the trusted Revit {selectedHost.RevitYear} image.");
        }
        using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true })
            await writer.WriteLineAsync(JsonSerializer.Serialize(new { challengeNonce = challenge, runtimeInstanceId = runtimeId, sessionKeyBase64 = Convert.ToBase64String(sessionKey), launcherExecutableHash = launcherHash }, WireJson));
        var receiptRaw = await ReadBoundedLineAsync(pipe, 64 * 1024);
        using var receiptDocument = JsonDocument.Parse(receiptRaw);
        var receipt = receiptDocument.RootElement;
        var proofHash = receipt.GetProperty("proofHash").GetString() ?? "";
        var proof = receipt.GetProperty("hostProofMac").GetString() ?? "";
        if (receipt.GetProperty("schema").GetString() != "dynamic-revit-bootstrap-receipt/v0" || !receipt.GetProperty("ok").GetBoolean() || receipt.GetProperty("runtimeInstanceId").GetString() != runtimeId || receipt.GetProperty("launcherProcessId").GetInt32() != Environment.ProcessId || receipt.GetProperty("revitProcessId").GetInt32() != claimedRevitPid || !DynamicWire.VerifySessionMessage(sessionKey, "bootstrap", runtimeId, challenge, expires, proofHash, proof)) throw new InvalidOperationException("Dynamic bootstrap receipt authentication failed.");
        return new BootstrapCompletion(receiptRaw, expectedImage, observedImage);
    }

    private static string UnwrapAuthenticated(string envelopeRaw, byte[] sessionKey, string runtimeId, string purpose, out string authenticationRaw)
    {
        using var envelopeDocument = JsonDocument.Parse(envelopeRaw);
        var root = envelopeDocument.RootElement;
        if (root.GetProperty("schema").GetString() != "dynamic-revit-authenticated-receipt/v0" || root.GetProperty("runtime_instance_id").GetString() != runtimeId || root.GetProperty("purpose").GetString() != purpose) throw new InvalidOperationException("Revit returned an invalid authenticated receipt envelope.");
        var expires = root.GetProperty("expires_unix_seconds").GetInt64();
        if (expires < DateTimeOffset.UtcNow.ToUnixTimeSeconds()) throw new InvalidOperationException("Revit authenticated receipt expired.");
        var receiptRaw = root.GetProperty("receipt").GetRawText();
        var receiptHash = root.GetProperty("receipt_hash").GetString() ?? "";
        if (!FixedEquals(receiptHash, DynamicWire.Sha256(receiptRaw)) || !DynamicWire.VerifySessionMessage(sessionKey, purpose, runtimeId, purpose, expires, receiptHash, root.GetProperty("host_receipt_mac").GetString() ?? "")) throw new InvalidOperationException("Revit authenticated receipt MAC or body hash was invalid.");
        authenticationRaw = envelopeRaw;
        return receiptRaw;
    }

    private static async Task<ProbeEvidence> RunProbeSuite(string workerDirectory, string evidencePath, bool lessPrivileged)
    {
        var started = DateTimeOffset.UtcNow;
        using var workspace = TaskWorkspace.Create(evidencePath, "tasks", workerDirectory);
        var root = workspace.Root;
        var scratch = workspace.ScratchDirectory;
        var outsideSecret = Path.Combine(Path.GetDirectoryName(evidencePath)!, "outside-secret.txt");
        await File.WriteAllTextAsync(outsideSecret, "not-visible-to-worker-" + Guid.NewGuid().ToString("N"));
        var outsideWrite = Path.Combine(Path.GetDirectoryName(evidencePath)!, "outside-write-must-not-exist.txt");
        var secretName = "REVIT_OPERATOR_SANDBOX_SECRET_" + Guid.NewGuid().ToString("N");
        Environment.SetEnvironmentVariable(secretName, Guid.NewGuid().ToString("N"));

        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        using var profile = WindowsSandboxProfile.Create(lessPrivileged);
        profile.GrantTaskLayout(root, workspace.RuntimeDirectory, scratch);
        var inputPath = Path.Combine(scratch, "probe-input.json");
        await File.WriteAllTextAsync(inputPath, JsonSerializer.Serialize(new
        {
            scratchPath = scratch,
            outsideReadPath = outsideSecret,
            outsideEnumeratePath = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            outsideWritePath = outsideWrite,
            secretEnvironmentName = secretName,
            loopbackPort = port
        }, Json));
        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var correlation = Guid.NewGuid().ToString("N");
        var channelKey = RandomNumberGenerator.GetBytes(32);
        using var pipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
        var pipeHandle = pipe.GetClientHandleAsString();
        var executable = Path.Combine(workspace.RuntimeDirectory, "DynamicRevitWorker.exe");
        var workerPackageHash = workspace.RuntimeImage.VerifyBeforeLaunch();
        var arguments = "--sandbox-probe --input \"" + inputPath + "\" --pipe " + pipeHandle + " --nonce " + nonce + " --channel-key " + Convert.ToBase64String(channelKey) + " " + correlation;
        using var process = profile.Launch(executable, arguments, scratch, memoryMb: 256, cpuTimeLimit: TimeSpan.FromSeconds(30), inheritedHandles: new[] { new IntPtr(long.Parse(pipeHandle, System.Globalization.CultureInfo.InvariantCulture)) });
        pipe.DisposeLocalCopyOfClientHandle();
        var read = ReadBoundedLineAsync(pipe, 4 * 1024 * 1024);
        var received = await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(30))) == read;
        if (!received)
        {
            var exited = process.Wait(TimeSpan.Zero);
            var detail = exited ? " Worker exited with code " + process.ExitCode + "." : " Worker remained running until terminated.";
            process.Kill();
            return ProbeEvidence.Failed(profile.ProfileName, profile.Sid.Value, "Worker did not write to the inherited task pipe." + detail, root, started, process.ProcessId, workspace.RuntimeImage, File.Exists(Path.Combine(scratch, "managed-startup-marker.txt")), File.Exists(Path.Combine(scratch, "probe-failure.txt")) ? await File.ReadAllTextAsync(Path.Combine(scratch, "probe-failure.txt")) : null);
        }
        string line;
        try { line = await read; }
        catch (Exception exception)
        {
            var exited = process.Wait(TimeSpan.FromSeconds(2));
            var detail = exited ? " Worker exited with code " + process.ExitCode + "." : " Worker remained running until terminated.";
            if (!exited) process.Kill();
            return ProbeEvidence.Failed(profile.ProfileName, profile.Sid.Value, "Worker channel failed: " + exception.Message + detail, root, started, process.ProcessId, workspace.RuntimeImage, File.Exists(Path.Combine(scratch, "managed-startup-marker.txt")), File.Exists(Path.Combine(scratch, "probe-failure.txt")) ? await File.ReadAllTextAsync(Path.Combine(scratch, "probe-failure.txt")) : null);
        }
        using var message = JsonDocument.Parse(line);
        var rootMessage = message.RootElement;
        var envelopePid = rootMessage.GetProperty("pid").GetUInt32();
        var observedNonce = rootMessage.GetProperty("nonce").GetString() ?? "";
        var observedCorrelation = rootMessage.GetProperty("correlation").GetString() ?? "";
        var pipePid = envelopePid;
        var authenticated = envelopePid == process.ProcessId && FixedEquals(nonce, observedNonce) && FixedEquals(correlation, observedCorrelation) && VerifyChannelMessage(rootMessage, channelKey, process.ProcessId);
        var completed = process.Wait(TimeSpan.FromSeconds(10));
        if (!completed) process.Kill();
        var results = DecodePayload(rootMessage).GetProperty("results").Deserialize<List<ProbeResult>>(Json) ?? new List<ProbeResult>();

        var signingKey = RandomNumberGenerator.GetBytes(32);
        var admission = new DynamicWorkerAdmission
        {
            RuntimeInstanceId = Guid.NewGuid().ToString("N"),
            LauncherExecutableHash = LauncherPackageHash(),
            WorkerExecutableHash = workerPackageHash,
            SandboxProfile = profile.ProfileName,
            WorkerProcessId = checked((int)process.ProcessId),
            StartupNonceHash = DynamicWire.Sha256(nonce),
            TaskDirectoryIdentity = DynamicWire.Sha256(Path.GetFullPath(root)),
            SourceHash = DynamicWire.Sha256("probe-source"),
            ProgramHash = DynamicWire.Sha256("probe-program"),
            SdkHash = DynamicRevitSdkVersion.ManifestHash,
            OperationGraphHash = DynamicWire.Sha256("probe-graph"),
            DocumentFingerprint = DynamicWire.Sha256("probe-document"),
            DocumentSessionId = "probe-session",
            CorrelationId = correlation,
            ExpiresUnixSeconds = DateTimeOffset.UtcNow.AddMinutes(2).ToUnixTimeSeconds()
        };
        admission.Signature = DynamicWire.SignAdmission(admission, signingKey);
        var signatureValid = DynamicWire.VerifyAdmission(admission, signingKey);
        var wrongKeyRejected = !DynamicWire.VerifyAdmission(admission, RandomNumberGenerator.GetBytes(32));
        var replay = new HashSet<string>(StringComparer.Ordinal);
        var firstUseAccepted = replay.Add(admission.CorrelationId);
        var replayRejected = !replay.Add(admission.CorrelationId);
        var hostilePipeName = "RevitOperator.DynamicRuntime.Hostile." + Guid.NewGuid().ToString("N");
        using var hostilePipe = profile.CreateAuthenticatedPipe(hostilePipeName);
        var hostileArguments = "--hostile-named-pipe-attempt --pipe " + hostilePipeName + " --nonce " + nonce + " --channel-key " + Convert.ToBase64String(channelKey) + " --correlation " + correlation + " --claim-pid " + process.ProcessId;
        var hostileExecutable = Path.Combine(workerDirectory, "DynamicRevitWorker.exe");
        using var hostile = Process.Start(new ProcessStartInfo(hostileExecutable, hostileArguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, WorkingDirectory = workerDirectory });
        var hostileConnected = hostilePipe.WaitForConnectionAsync();
        var hostileConnectedInTime = await Task.WhenAny(hostileConnected, Task.Delay(5_000)) == hostileConnected;
        if (hostileConnectedInTime) await hostileConnected;
        uint kernelHostilePid = 0;
        var kernelHostilePidObserved = hostileConnectedInTime && Native.GetNamedPipeClientProcessId(hostilePipe.SafePipeHandle, out kernelHostilePid);
        var hostileRaw = hostileConnectedInTime ? await ReadBoundedLineAsync(hostilePipe, 256 * 1024) : "{}";
        using var hostileDocument = JsonDocument.Parse(hostileRaw);
        var hostileCryptographicallyValidAsClaimedWorker = hostileConnectedInTime && VerifyChannelMessage(hostileDocument.RootElement, channelKey, process.ProcessId);
        var wrongProcessRejected = hostile != null && kernelHostilePidObserved && kernelHostilePid != process.ProcessId && hostileCryptographicallyValidAsClaimedWorker;
        if (hostile != null && !hostile.WaitForExit(5_000)) hostile.Kill(true);
        var allExpected = results.Count >= 10 && results.All(result => result.Denied == string.Equals(result.Expected, "denied", StringComparison.Ordinal));
        var outsideWriteAbsent = !File.Exists(outsideWrite);
        var ok = authenticated && completed && allExpected && outsideWriteAbsent && signatureValid && wrongKeyRejected && firstUseAccepted && replayRejected && wrongProcessRejected;
        return new ProbeEvidence
        {
            Schema = "dynamic-revit-phase2-sandbox-evidence/v0", Ok = ok, StartedUtc = started, CompletedUtc = DateTimeOffset.UtcNow,
            Os = Environment.OSVersion.VersionString, SandboxProfile = profile.ProfileName, AppContainerSid = profile.Sid.Value,
            Configuration = new[] { "zero AppContainer capabilities", "reparse-free read/execute-only content-addressed runtime image", "separate low-integrity writable task scratch", "complete allowlisted runtime dependency manifest hashed before launch", "task SID ACL", "only explicitly inherited anonymous input-pipe handle", "kernel-observed named-pipe output client PID", "environment allowlist", "one-process job", "256 MiB process and job memory", "30 second per-process CPU time", "job UI restrictions", "kill-on-job-close", "30 second probe IPC deadline", "PID + 256-bit nonce + correlation + payload-hash HMAC-bound typed pipe message", "Microsoft-signed-native-image policy enabled before generated code" },
            TaskDirectory = root, WorkerPid = process.ProcessId, PipeClientPid = pipePid, AuthenticatedPipe = authenticated,
            RuntimeImageDirectory = workspace.RuntimeDirectory, RuntimeImageIdentity = workerPackageHash, RuntimeDependencyCount = workspace.RuntimeImage.Files.Count,
            Admission = admission, AdmissionSignatureValid = signatureValid, WrongKeyRejected = wrongKeyRejected, WrongProcessRejected = wrongProcessRejected, ReplayRejected = replayRejected,
            WrongProcessPipeConnected = hostileConnectedInTime, WrongProcessKernelPid = kernelHostilePid, WrongProcessClaimedMessageValid = hostileCryptographicallyValidAsClaimedWorker, WrongProcessFailureDetail = hostile?.StandardError.ReadToEnd(),
            Results = results, Failure = ok ? null : "One or more sandbox or authentication expectations were not observed.", ManagedWorkerStarted = File.Exists(Path.Combine(scratch, "managed-startup-marker.txt"))
        };
    }

    private static string LauncherPackageHash()
    {
        return DynamicRuntimePackageDirectoryIdentity.Compute(AppContext.BaseDirectory);
    }
    private static string PackageHash(IEnumerable<string> files)
    {
        var canonical = string.Join("\n", files.OrderBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase).Select(path => Path.GetFileName(path) + ":" + DynamicWire.Sha256(File.ReadAllBytes(path))));
        if (canonical.Length == 0) throw new InvalidOperationException("Runtime package identity has no files.");
        return DynamicWire.Sha256(canonical);
    }
    private static bool VerifyChannelMessage(JsonElement message, byte[] key, uint expectedPid)
    {
        if (key.Length != 32 || !message.TryGetProperty("pid", out var pid) || pid.GetUInt32() != expectedPid || !message.TryGetProperty("payloadBase64", out var payloadBase64Property) || !message.TryGetProperty("payloadHash", out var payloadHashProperty) || !message.TryGetProperty("mac", out var macProperty)) return false;
        byte[] payloadBytes;
        try { payloadBytes = Convert.FromBase64String(payloadBase64Property.GetString() ?? ""); }
        catch (FormatException) { return false; }
        if (payloadBytes.Length > 3 * 1024 * 1024) return false;
        var payloadHash = DynamicWire.Sha256(payloadBytes);
        if (!FixedEquals(payloadHash, payloadHashProperty.GetString() ?? "")) return false;
        var canonical = expectedPid + "\n" + (message.GetProperty("nonce").GetString() ?? "") + "\n" + (message.GetProperty("correlation").GetString() ?? "") + "\n" + payloadHash;
        using var hmac = new HMACSHA256(key);
        var expected = "hmac-sha256:" + Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        return FixedEquals(expected, macProperty.GetString() ?? "");
    }
    private static JsonElement DecodePayload(JsonElement message)
    {
        var payloadBytes = Convert.FromBase64String(message.GetProperty("payloadBase64").GetString() ?? "");
        if (payloadBytes.Length > 3 * 1024 * 1024) throw new InvalidOperationException("Sandboxed worker payload exceeded the 3 MiB decoded-payload limit.");
        using var document = JsonDocument.Parse(payloadBytes);
        return document.RootElement.Clone();
    }
    private static async Task<string> ReadBoundedLineAsync(Stream stream, int maximumBytes)
    {
        var buffer = new byte[16 * 1024];
        using var output = new MemoryStream();
        while (true)
        {
            var count = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length));
            if (count == 0) break;
            var newline = Array.IndexOf(buffer, (byte)'\n', 0, count);
            var take = newline >= 0 ? newline : count;
            if (output.Length + take > maximumBytes) throw new InvalidOperationException("Sandboxed worker response exceeded the 4 MiB trusted-supervisor limit.");
            output.Write(buffer, 0, take);
            if (newline >= 0) break;
        }
        if (output.Length == 0) throw new InvalidOperationException("Sandboxed worker returned an empty response.");
        return Encoding.UTF8.GetString(output.ToArray()).TrimEnd('\r');
    }
    private static bool FixedEquals(string left, string right)
    {
        var a = Encoding.UTF8.GetBytes(left); var b = Encoding.UTF8.GetBytes(right); if (a.Length != b.Length) return false;
        var diff = 0; for (var i = 0; i < a.Length; i++) diff |= a[i] ^ b[i]; return diff == 0;
    }
}

internal sealed class ProbeResult { public string Action { get; set; } = ""; public string Expected { get; set; } = ""; public bool Denied { get; set; } public string Observed { get; set; } = ""; public string? ExceptionType { get; set; } }
internal sealed class LiveTaskConfig
{
    public string WorkerDirectory { get; set; } = ""; public string EvidencePath { get; set; } = ""; public string BridgeUrl { get; set; } = "http://127.0.0.1:5000"; public string OperatorTokenFile { get; set; } = ""; public string SourceFile { get; set; } = "";
    public string TargetRevitYear { get; set; } = ""; public string? Category { get; set; } public int Limit { get; set; } = 200; public string[] Parameters { get; set; } = Array.Empty<string>(); public int OperationBudget { get; set; } = 16; public int WorkerDeadlineMs { get; set; } = 10_000; public bool Apply { get; set; } public int ApplyDeadlineMs { get; set; } = 5000;
    public bool ResultReference { get; set; } public DynamicBuildingSystemsSelectorV1? BuildingSystemsSelector { get; set; }
    public string[] ResultReferenceTargetUniqueIds { get; set; } = Array.Empty<string>(); public DynamicEffectBudgetV1? ResultReferenceEffectBudget { get; set; }
    public string? ContextRuleFile { get; set; } public string? ContextRuleVerificationKeyFile { get; set; }
    public string ContextCompanyId { get; set; } = ""; public string ContextUserId { get; set; } = "";
    public DynamicEffectBudgetV1? CoreEffectBudget { get; set; } public int CorePlannedExecutionMilliseconds { get; set; } = 1000;
}
internal sealed class ContextRuleExecutionInput
{
    public long DocumentRevision { get; set; } public DynamicVerifiedContextRuleV1 Rule { get; set; } = new();
    public DynamicObservationSelectorV1 Selector { get; set; } = new(); public IReadOnlyList<DynamicObservationEnvelopeV1> Pages { get; set; } = Array.Empty<DynamicObservationEnvelopeV1>();
    public List<string> ObservationReceiptBodies { get; set; } = new();
}
internal sealed class ResultReferenceObservationInput
{
    public string SnapshotId { get; set; } = ""; public string SnapshotHash { get; set; } = ""; public string ScopeHash { get; set; } = ""; public long DocumentRevision { get; set; }
    public DynamicBuildingSystemsSelectorV1 Selector { get; set; } = new(); public IReadOnlyList<DynamicBuildingSystemsEnvelopeV1> Pages { get; set; } = Array.Empty<DynamicBuildingSystemsEnvelopeV1>();
    public IReadOnlyList<DynamicTrustedElementFactV1> TrustedExternalTargets { get; set; } = Array.Empty<DynamicTrustedElementFactV1>();
    public List<string> ObservationReceiptBodies { get; set; } = new(); public string FactsReceiptBody { get; set; } = "";
}
internal sealed class LiveEvidence
{
    public string Schema { get; set; } = "dynamic-revit-phase2-live-evidence/v0"; public bool Ok { get; set; } public DateTimeOffset StartedUtc { get; set; } public DateTimeOffset CompletedUtc { get; set; }
    public string SandboxProfile { get; set; } = ""; public string TaskDirectory { get; set; } = ""; public string RegistrationReceipt { get; set; } = ""; public string SnapshotReceipt { get; set; } = ""; public JsonElement WorkerOutput { get; set; } public DynamicWorkerAdmission? Admission { get; set; } public string PreviewReceipt { get; set; } = ""; public string? ApplyAuthorizationReceipt { get; set; } public DynamicProgramAdmissionV1? V1Admission { get; set; } public string? ApplyReceipt { get; set; } public List<string> HostAuthenticationReceipts { get; set; } = new(); public HostReplayEvidence? ReplayEvidence { get; set; } public string? Failure { get; set; }
    public string RuntimeImageDirectory { get; set; } = ""; public string RuntimeImageIdentity { get; set; } = ""; public int RuntimeDependencyCount { get; set; }
    public List<string> BuildingSystemsObservationReceipts { get; set; } = new(); public string? ResultReferenceFactsReceipt { get; set; }
    public List<string> ContextObservationReceipts { get; set; } = new(); public DynamicVerifiedContextRuleV1? ContextRule { get; set; }
    public string TargetRevitYear { get; set; } = ""; public string ExpectedHostExecutable { get; set; } = ""; public string ObservedHostExecutable { get; set; } = "";
    public static LiveEvidence Failed(DateTimeOffset started, string profile, string task, RuntimeImage runtimeImage, string registration, string snapshot, JsonElement worker, string failure) => new() { Ok = false, StartedUtc = started, CompletedUtc = DateTimeOffset.UtcNow, SandboxProfile = profile, TaskDirectory = task, RuntimeImageDirectory = runtimeImage.Directory, RuntimeImageIdentity = runtimeImage.Identity, RuntimeDependencyCount = runtimeImage.Files.Count, RegistrationReceipt = registration, SnapshotReceipt = snapshot, WorkerOutput = worker, Failure = failure };
}
internal sealed class HostReplayEvidence
{
    public string Schema { get; set; } = "dynamic-revit-host-replay-evidence/v0"; public bool FirstSubmissionAccepted { get; set; } public bool SecondSubmissionRejected { get; set; }
    public bool SameSignedAdmission { get; set; } public bool FreshSnapshotGrant { get; set; } public bool SameSnapshotBinding { get; set; } public int StatusCode { get; set; } public string ResponseBody { get; set; } = "";
}
internal sealed record HttpPostResult(bool Success, int StatusCode, string Body);
internal sealed record BootstrapCompletion(string Receipt, string ExpectedImage, string ObservedImage);
internal sealed class ProbeEvidence
{
    public string Schema { get; set; } = "dynamic-revit-phase2-sandbox-evidence/v0"; public bool Ok { get; set; }
    public DateTimeOffset StartedUtc { get; set; } public DateTimeOffset CompletedUtc { get; set; } public string Os { get; set; } = "";
    public string SandboxProfile { get; set; } = ""; public string AppContainerSid { get; set; } = ""; public string[] Configuration { get; set; } = Array.Empty<string>();
    public string TaskDirectory { get; set; } = ""; public uint WorkerPid { get; set; } public uint PipeClientPid { get; set; } public bool AuthenticatedPipe { get; set; }
    public string RuntimeImageDirectory { get; set; } = ""; public string RuntimeImageIdentity { get; set; } = ""; public int RuntimeDependencyCount { get; set; }
    public DynamicWorkerAdmission? Admission { get; set; } public bool AdmissionSignatureValid { get; set; } public bool WrongKeyRejected { get; set; } public bool WrongProcessRejected { get; set; } public bool ReplayRejected { get; set; }
    public bool WrongProcessPipeConnected { get; set; } public uint WrongProcessKernelPid { get; set; } public bool WrongProcessClaimedMessageValid { get; set; } public string? WrongProcessFailureDetail { get; set; }
    public List<ProbeResult> Results { get; set; } = new(); public string? Failure { get; set; }
    public bool ManagedWorkerStarted { get; set; } public string? WorkerFailureDetail { get; set; }
    public static ProbeEvidence Failed(string profile, string sid, string failure, string task, DateTimeOffset started, uint pid, RuntimeImage runtimeImage, bool managedStarted, string? workerFailure) => new() { Ok = false, SandboxProfile = profile, AppContainerSid = sid, Failure = failure, TaskDirectory = task, RuntimeImageDirectory = runtimeImage.Directory, RuntimeImageIdentity = runtimeImage.Identity, RuntimeDependencyCount = runtimeImage.Files.Count, StartedUtc = started, CompletedUtc = DateTimeOffset.UtcNow, Os = Environment.OSVersion.VersionString, WorkerPid = pid, ManagedWorkerStarted = managedStarted, WorkerFailureDetail = workerFailure };
}

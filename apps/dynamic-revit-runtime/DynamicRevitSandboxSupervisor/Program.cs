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
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true, WriteIndented = true };
    private static readonly JsonSerializerOptions WireJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true, WriteIndented = false };

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
        var workerDirectory = Path.GetFullPath(config.WorkerDirectory);
        var evidencePath = Path.GetFullPath(config.EvidencePath);
        using var workspace = TaskWorkspace.Create(evidencePath, "live-tasks", workerDirectory);
        var taskRoot = workspace.Root;
        var scratch = workspace.ScratchDirectory;
        var source = await File.ReadAllTextAsync(config.SourceFile);
        var token = (await File.ReadAllTextAsync(config.OperatorTokenFile)).Trim();
        if (token.Length < 16) throw new InvalidOperationException("Operator token file is empty or invalid.");
        var writeGrant = ReadWriteGrant(config.OperatorTokenFile);
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
        var workerInput = JsonSerializer.Serialize(new { schema = "dynamic-revit-worker-input/v0", source, input = new DynamicTaskInput { Document = document, Elements = elements, OperationBudget = config.OperationBudget }, deadlineMs = config.WorkerDeadlineMs }, Json);

        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var correlation = Guid.NewGuid().ToString("N");
        var channelKey = RandomNumberGenerator.GetBytes(32);
        var outputPipeName = "RevitOperator.DynamicRuntime.Worker." + Guid.NewGuid().ToString("N");
        using var pipe = profile.CreateAuthenticatedPipe(outputPipeName);
        using var inputPipe = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
        var inputPipeHandle = inputPipe.GetClientHandleAsString();
        var executable = Path.Combine(workspace.RuntimeDirectory, "DynamicRevitWorker.exe");
        var arguments = "--sandbox-execute --input-pipe " + inputPipeHandle + " --output-named-pipe " + outputPipeName;
        var workerHash = workspace.RuntimeImage.VerifyBeforeLaunch();
        using var worker = profile.Launch(executable, arguments, scratch, memoryMb: 256, cpuTimeLimit: TimeSpan.FromMilliseconds(Math.Max(config.WorkerDeadlineMs, 1_000) + 5_000), inheritedHandles: new[] { new IntPtr(long.Parse(inputPipeHandle, System.Globalization.CultureInfo.InvariantCulture)) });
        var startupNonceHash = DynamicWire.Sha256(nonce);
        var taskDirectoryIdentity = DynamicWire.Sha256(Path.GetFullPath(taskRoot));
        var registrationCore = JsonSerializer.Serialize(new { runtimeInstanceId = runtimeId, signingKeyBase64 = Convert.ToBase64String(signingKey), launcherExecutableHash = launcherHash, workerExecutableHash = workerHash, sandboxProfile = profile.ProfileName, workerProcessId = checked((int)worker.ProcessId), startupNonceHash, taskDirectoryIdentity, expiresUnixSeconds = runtimeExpires }, WireJson);
        var registrationCorrelation = Guid.NewGuid().ToString("N");
        var registrationAuthExpires = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
        var registrationRequest = JsonSerializer.Serialize(new { runtimeInstanceId = runtimeId, signingKeyBase64 = Convert.ToBase64String(signingKey), launcherExecutableHash = launcherHash, workerExecutableHash = workerHash, sandboxProfile = profile.ProfileName, workerProcessId = checked((int)worker.ProcessId), startupNonceHash, taskDirectoryIdentity, expiresUnixSeconds = runtimeExpires, correlationId = registrationCorrelation, authExpiresUnixSeconds = registrationAuthExpires, requestMac = DynamicWire.SignSessionMessage(hostSessionKey, "register-worker", runtimeId, registrationCorrelation, registrationAuthExpires, DynamicWire.Sha256(registrationCore)) }, WireJson);
        var registrationEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/register", token, writeGrant, registrationRequest, registrationCorrelation);
        registration = UnwrapAuthenticated(registrationEnvelope, hostSessionKey, runtimeId, "register-worker-receipt", out var registrationAuthentication);
        hostAuthentications.Add(registrationAuthentication);
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
        var graph = output.GetProperty("graph").Clone();
        var graphHash = graph.GetProperty("graphHash").GetString()!;
        if (!FixedEquals(snapshotInputHash, graph.GetProperty("inputHash").GetString() ?? "")) throw new InvalidOperationException("Worker graph is not bound to the exact issued snapshot DTO input.");
        var admission = new DynamicWorkerAdmission
        {
            RuntimeInstanceId = runtimeId, LauncherExecutableHash = launcherHash, WorkerExecutableHash = workerHash, SandboxProfile = profile.ProfileName,
            WorkerProcessId = checked((int)worker.ProcessId), StartupNonceHash = startupNonceHash, TaskDirectoryIdentity = taskDirectoryIdentity,
            SourceHash = sourceHash, ProgramHash = programHash, SdkHash = sdkHash, OperationGraphHash = graphHash, DocumentFingerprint = document.ProjectFingerprint, DocumentSessionId = document.SessionId,
            CorrelationId = correlation, ExpiresUnixSeconds = DateTimeOffset.UtcNow.AddMinutes(2).ToUnixTimeSeconds()
        };
        admission.Signature = DynamicWire.SignAdmission(admission, signingKey);
        if (graph.GetProperty("operations").GetArrayLength() == 0)
        {
            var readReceipt = JsonSerializer.Serialize(new { schema = "dynamic-revit-read-report-receipt/v0", ok = true, sourceHash, programHash, sdkHash, inputHash = snapshotInputHash, graphHash, documentFingerprint = document.ProjectFingerprint, documentSessionId = document.SessionId, workerIdentity = admission, report = output.GetProperty("report").Clone(), logs = output.GetProperty("logs").Clone() }, Json);
            return new LiveEvidence { Schema = "dynamic-revit-phase2-live-evidence/v0", Ok = true, StartedUtc = started, CompletedUtc = DateTimeOffset.UtcNow, SandboxProfile = profile.ProfileName, TaskDirectory = taskRoot, RuntimeImageDirectory = workspace.RuntimeDirectory, RuntimeImageIdentity = workerHash, RuntimeDependencyCount = workspace.RuntimeImage.Files.Count, RegistrationReceipt = registration, SnapshotReceipt = snapshotRaw, WorkerOutput = output.Clone(), Admission = admission, PreviewReceipt = readReceipt, HostAuthenticationReceipts = hostAuthentications, TargetRevitYear = selectedHost.RevitYear, ExpectedHostExecutable = bootstrap.ExpectedImage, ObservedHostExecutable = bootstrap.ObservedImage };
        }
        var previewRequest = JsonSerializer.Serialize(new { schema = "dynamic-revit-preview-request/v0", phase = "preview", sourceHash, programHash, sdkHash, documentFingerprint = document.ProjectFingerprint, documentSessionId = document.SessionId, snapshotToken, operationBudget = config.OperationBudget, graph, admission }, Json);
        var previewEnvelope = await Post(config.BridgeUrl, "/revit/dynamic-runtime/preview", token, writeGrant, previewRequest, correlation);
        var previewRaw = UnwrapAuthenticated(previewEnvelope, hostSessionKey, runtimeId, "preview-receipt", out var previewAuthentication);
        hostAuthentications.Add(previewAuthentication);
        using var previewDoc = JsonDocument.Parse(previewRaw);
        var ok = previewDoc.RootElement.TryGetProperty("ok", out var okProperty) && okProperty.GetBoolean();
        HostReplayEvidence? replay = null;
        if (ok && replayAdmission)
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
        return new LiveEvidence { Schema = "dynamic-revit-phase2-live-evidence/v0", Ok = ok, StartedUtc = started, CompletedUtc = DateTimeOffset.UtcNow, SandboxProfile = profile.ProfileName, TaskDirectory = taskRoot, RuntimeImageDirectory = workspace.RuntimeDirectory, RuntimeImageIdentity = workerHash, RuntimeDependencyCount = workspace.RuntimeImage.Files.Count, RegistrationReceipt = registration, SnapshotReceipt = snapshotRaw, WorkerOutput = output.Clone(), Admission = admission, PreviewReceipt = previewRaw, HostAuthenticationReceipts = hostAuthentications, ReplayEvidence = replay, TargetRevitYear = selectedHost.RevitYear, ExpectedHostExecutable = bootstrap.ExpectedImage, ObservedHostExecutable = bootstrap.ObservedImage, Failure = ok ? null : replayAdmission && replay is not null && !replay.SecondSubmissionRejected ? "Revit host accepted a replayed signed worker admission." : "Revit preview returned a structured failure." };
    }

    private static async Task<string> Post(string baseUrl, string path, string token, string writeGrant, string json, string correlation)
    {
        var response = await SendPost(baseUrl, path, token, writeGrant, json, correlation);
        if (!response.Success) throw new InvalidOperationException("Bridge " + path + " returned " + response.StatusCode + ": " + response.Body);
        return response.Body;
    }

    private static async Task<HttpPostResult> SendPost(string baseUrl, string path, string token, string writeGrant, string json, string correlation)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        using var request = new HttpRequestMessage(HttpMethod.Post, baseUrl.TrimEnd('/') + path) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        request.Headers.TryAddWithoutValidation("X-Operator-Token", token);
        request.Headers.TryAddWithoutValidation("X-Operator-Write-Grant", writeGrant);
        request.Headers.TryAddWithoutValidation("X-Operator-Correlation-Id", correlation);
        using var response = await client.SendAsync(request);
        var body = await response.Content.ReadAsStringAsync();
        return new HttpPostResult(response.IsSuccessStatusCode, (int)response.StatusCode, body);
    }

    private static string ReadWriteGrant(string operatorTokenFile)
    {
        var grantPath = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(operatorTokenFile))!, "write_grant.json");
        if (!File.Exists(grantPath)) throw new InvalidOperationException("Operator write-grant file is missing. Issue a session grant before running a live task.");
        using var document = JsonDocument.Parse(File.ReadAllText(grantPath).TrimStart('\ufeff'));
        var token = document.RootElement.TryGetProperty("token", out var property) ? property.GetString()?.Trim() : null;
        if (string.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("Operator write-grant file is empty or invalid.");
        return token;
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
        var directory = AppContext.BaseDirectory;
        var files = Directory.EnumerateFiles(directory, "DynamicRevitSandboxSupervisor.*", SearchOption.TopDirectoryOnly)
            .Concat(new[] { Path.Combine(directory, "DynamicRevitSdk.dll") }.Where(File.Exists));
        return PackageHash(files);
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
    public string TargetRevitYear { get; set; } = ""; public string? Category { get; set; } public int Limit { get; set; } = 200; public string[] Parameters { get; set; } = Array.Empty<string>(); public int OperationBudget { get; set; } = 16; public int WorkerDeadlineMs { get; set; } = 10_000;
}
internal sealed class LiveEvidence
{
    public string Schema { get; set; } = "dynamic-revit-phase2-live-evidence/v0"; public bool Ok { get; set; } public DateTimeOffset StartedUtc { get; set; } public DateTimeOffset CompletedUtc { get; set; }
    public string SandboxProfile { get; set; } = ""; public string TaskDirectory { get; set; } = ""; public string RegistrationReceipt { get; set; } = ""; public string SnapshotReceipt { get; set; } = ""; public JsonElement WorkerOutput { get; set; } public DynamicWorkerAdmission? Admission { get; set; } public string PreviewReceipt { get; set; } = ""; public List<string> HostAuthenticationReceipts { get; set; } = new(); public HostReplayEvidence? ReplayEvidence { get; set; } public string? Failure { get; set; }
    public string RuntimeImageDirectory { get; set; } = ""; public string RuntimeImageIdentity { get; set; } = ""; public int RuntimeDependencyCount { get; set; }
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

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    internal static class DynamicRuntimeBootstrapRegistry
    {
        private sealed class BootstrapRequest { public string? challengeNonce { get; set; } public string? runtimeInstanceId { get; set; } public string? sessionKeyBase64 { get; set; } public string? launcherExecutableHash { get; set; } }
        private sealed class Session { public byte[] Key = Array.Empty<byte>(); public DateTime ExpiresUtc; public int LauncherProcessId; public string LauncherHash = ""; }
        private static readonly ConcurrentDictionary<string, Session> Sessions = new ConcurrentDictionary<string, Session>(StringComparer.Ordinal);
        public static object Begin()
        {
            var pipeName = "RevitOperator.DynamicRuntime.Bootstrap." + Guid.NewGuid().ToString("N");
            var challenge = Convert.ToBase64String(RandomBytes(32));
            var expires = DateTimeOffset.UtcNow.AddSeconds(30).ToUnixTimeSeconds();
            var revitProcessId = Process.GetCurrentProcess().Id;
            var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 64 * 1024, 64 * 1024);
            _ = Task.Run(async () => await AcceptBootstrap(pipe, challenge, expires, revitProcessId).ConfigureAwait(false));
            return new { schema = "dynamic-revit-bootstrap-challenge/v0", pipe_name = pipeName, challenge_nonce = challenge, revit_process_id = revitProcessId, expires_unix_seconds = expires };
        }
        private static async Task AcceptBootstrap(NamedPipeServerStream pipe, string challenge, long expires, int revitProcessId)
        {
            using (pipe)
            {
                try
                {
                    var connection = pipe.WaitForConnectionAsync();
                    if (await Task.WhenAny(connection, Task.Delay(TimeSpan.FromSeconds(30))).ConfigureAwait(false) != connection) return;
                    await connection.ConfigureAwait(false);
                    if (!NativePipe.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var observedLauncherPid) || observedLauncherPid <= 0) throw new InvalidOperationException("Dynamic bootstrap could not establish the kernel-observed launcher PID.");
                    var raw = await ReadBoundedLine(pipe, 64 * 1024).ConfigureAwait(false);
                    using var document = JsonDocument.Parse(raw);
                    var names = document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement.EnumerateObject().Select(property => property.Name).ToArray() : Array.Empty<string>();
                    var expected = new[] { "challengeNonce", "runtimeInstanceId", "sessionKeyBase64", "launcherExecutableHash" };
                    if (names.Length != expected.Length || names.Distinct(StringComparer.Ordinal).Count() != names.Length || names.Any(name => !expected.Contains(name, StringComparer.Ordinal))) throw new InvalidOperationException("Dynamic bootstrap request has an invalid field set.");
                    var request = JsonSerializer.Deserialize<BootstrapRequest>(raw) ?? throw new InvalidOperationException("Dynamic bootstrap request is invalid.");
                    if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() > expires || !FixedEquals(request.challengeNonce, challenge) || string.IsNullOrWhiteSpace(request.runtimeInstanceId) || request.runtimeInstanceId!.Length > 128 || !DynamicRuntimePreviewHandler.IsHash(request.launcherExecutableHash)) throw new InvalidOperationException("Dynamic bootstrap request challenge, runtime, or launcher identity is invalid.");
                    var key = Convert.FromBase64String(request.sessionKeyBase64 ?? "");
                    if (key.Length != 32) throw new InvalidOperationException("Dynamic bootstrap session key must be 256 bits.");
                    var observedLauncherHash = PackageHashForProcess(checked((int)observedLauncherPid));
                    var pinnedLauncherHash = Environment.GetEnvironmentVariable("REVIT_OPERATOR_DYNAMIC_RUNTIME_LAUNCHER_SHA256") ?? "";
                    if (!FixedEquals(observedLauncherHash, request.launcherExecutableHash) || !FixedEquals(pinnedLauncherHash, request.launcherExecutableHash)) throw new InvalidOperationException("Dynamic bootstrap launcher package did not match the kernel-observed or laboratory-pinned package.");
                    Sessions[request.runtimeInstanceId] = new Session { Key = key, ExpiresUtc = DateTime.UtcNow.AddMinutes(10), LauncherProcessId = checked((int)observedLauncherPid), LauncherHash = observedLauncherHash };
                    foreach (var expired in Sessions.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Sessions.TryRemove(expired, out _);
                    var proofHash = DynamicWire.Sha256(request.runtimeInstanceId + "\n" + observedLauncherPid + "\n" + revitProcessId + "\n" + observedLauncherHash);
                    var proof = DynamicWire.SignSessionMessage(key, "bootstrap", request.runtimeInstanceId, challenge, expires, proofHash);
                    var receipt = JsonSerializer.Serialize(new { schema = "dynamic-revit-bootstrap-receipt/v0", ok = true, runtimeInstanceId = request.runtimeInstanceId, launcherProcessId = checked((int)observedLauncherPid), revitProcessId, expiresUnixSeconds = expires, launcherExecutableHash = observedLauncherHash, proofHash, hostProofMac = proof });
                    using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
                    await writer.WriteLineAsync(receipt).ConfigureAwait(false);
                }
                catch { }
            }
        }
        private static async Task<string> ReadBoundedLine(Stream stream, int maxBytes)
        {
            var bytes = new List<byte>(Math.Min(maxBytes, 4096));
            var buffer = new byte[1];
            while (bytes.Count <= maxBytes)
            {
                var read = await stream.ReadAsync(buffer, 0, 1).ConfigureAwait(false);
                if (read == 0) throw new EndOfStreamException("Dynamic bootstrap pipe closed before a complete request.");
                if (buffer[0] == (byte)'\n') return Encoding.UTF8.GetString(bytes.ToArray()).TrimEnd('\r');
                bytes.Add(buffer[0]);
            }
            throw new InvalidOperationException("Dynamic bootstrap request exceeded the 64 KiB limit.");
        }
        private static string PackageHashForProcess(int processId)
        {
            using var process = Process.GetProcessById(processId);
            var executable = process.MainModule?.FileName ?? throw new InvalidOperationException("Dynamic bootstrap launcher image is unavailable.");
            var directory = Path.GetDirectoryName(Path.GetFullPath(executable)) ?? throw new InvalidOperationException("Dynamic bootstrap launcher directory is unavailable.");
            return DynamicRuntimePackageDirectoryIdentity.Compute(directory);
        }
        private static bool FixedEquals(string? left, string? right)
        {
            var a = Encoding.UTF8.GetBytes(left ?? ""); var b = Encoding.UTF8.GetBytes(right ?? ""); if (a.Length != b.Length) return false;
            var difference = 0; for (var i = 0; i < a.Length; i++) difference |= a[i] ^ b[i]; return difference == 0;
        }
        private static byte[] RandomBytes(int count) { var bytes = new byte[count]; using var random = RandomNumberGenerator.Create(); random.GetBytes(bytes); return bytes; }
        public static void VerifyRequest(string runtimeId, string purpose, string correlation, long expiresUnix, string payloadHash, string signature)
        {
            if (!Sessions.TryGetValue(runtimeId ?? "", out var session) || session.ExpiresUtc <= DateTime.UtcNow) throw new InvalidOperationException("Dynamic launcher session is not authenticated or has expired.");
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (expiresUnix < now || expiresUnix > now + 120 || !DynamicWire.VerifySessionMessage(session.Key, purpose, runtimeId, correlation, expiresUnix, payloadHash, signature)) throw new InvalidOperationException("Dynamic launcher session request authentication failed.");
        }
        public static object AuthenticateReceipt(string runtimeId, string purpose, object receipt)
        {
            if (!Sessions.TryGetValue(runtimeId ?? "", out var session) || session.ExpiresUtc <= DateTime.UtcNow) throw new InvalidOperationException("Dynamic launcher session is not authenticated or has expired.");
            var receiptJson = JsonSerializer.Serialize(receipt);
            var receiptHash = DynamicWire.Sha256(receiptJson);
            var expires = DateTimeOffset.UtcNow.AddMinutes(2).ToUnixTimeSeconds();
            var mac = DynamicWire.SignSessionMessage(session.Key, purpose, runtimeId, purpose, expires, receiptHash);
            using var document = JsonDocument.Parse(receiptJson);
            return new { schema = "dynamic-revit-authenticated-receipt/v0", runtime_instance_id = runtimeId, purpose, expires_unix_seconds = expires, receipt_hash = receiptHash, host_receipt_mac = mac, receipt = document.RootElement.Clone() };
        }
    }

    internal static class NativePipe
    {
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);
    }

    public sealed class DynamicRuntimeBootstrapHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            using var document = JsonDocument.Parse(jsonData);
            if (document.RootElement.ValueKind != JsonValueKind.Object || document.RootElement.EnumerateObject().Any()) throw new ArgumentException("Dynamic bootstrap request must be an empty object.");
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.Begin());
        }
    }

    internal static class DynamicRuntimeAdmissionRegistry
    {
        private sealed class RuntimeKey
        {
            public byte[] Key = Array.Empty<byte>(); public DateTime ExpiresUtc; public string LauncherHash = "";
            public string WorkerExecutableHash = ""; public string WorkerRuntimePackageHash = ""; public string CompilerRuntimeHash = ""; public string SdkArtifactHash = "";
            public string SandboxProfile = ""; public int WorkerProcessId; public string StartupNonceHash = ""; public string TaskDirectoryIdentity = "";
        }
        private static readonly ConcurrentDictionary<string, RuntimeKey> Keys = new ConcurrentDictionary<string, RuntimeKey>(StringComparer.Ordinal);
        private static readonly ConcurrentDictionary<string, byte> UsedCorrelations = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        public static void Register(string runtimeId, string keyBase64, string launcherHash, string workerExecutableHash, string workerRuntimePackageHash, string compilerRuntimeHash, string sdkArtifactHash, string sandboxProfile, int workerProcessId, string startupNonceHash, string taskDirectoryIdentity, long expiresUnixSeconds)
        {
            var trustedLauncherHash = Environment.GetEnvironmentVariable("REVIT_OPERATOR_DYNAMIC_RUNTIME_LAUNCHER_SHA256") ?? "";
            var trustedWorkerHash = Environment.GetEnvironmentVariable("REVIT_OPERATOR_DYNAMIC_RUNTIME_WORKER_SHA256") ?? "";
            var runtimeValid = !string.IsNullOrWhiteSpace(runtimeId) && runtimeId.Length <= 128;
            var launcherFormatValid = DynamicRuntimePreviewHandler.IsHash(launcherHash);
            var workerExecutableFormatValid = DynamicRuntimePreviewHandler.IsHash(workerExecutableHash);
            var workerPackageFormatValid = DynamicRuntimePreviewHandler.IsHash(workerRuntimePackageHash);
            var compilerRuntimeFormatValid = DynamicRuntimePreviewHandler.IsHash(compilerRuntimeHash);
            var sdkArtifactFormatValid = DynamicRuntimePreviewHandler.IsHash(sdkArtifactHash);
            var launcherPinValid = string.Equals(launcherHash, trustedLauncherHash, StringComparison.Ordinal);
            var workerPinValid = string.Equals(workerRuntimePackageHash, trustedWorkerHash, StringComparison.Ordinal);
            var profileValid = sandboxProfile == "windows-lpac-v1-zero-capabilities";
            var workerProcessValid = workerProcessId > 0;
            var startupNonceValid = DynamicRuntimePreviewHandler.IsHash(startupNonceHash);
            var taskDirectoryValid = DynamicRuntimePreviewHandler.IsHash(taskDirectoryIdentity);
            if (!runtimeValid || !launcherFormatValid || !workerExecutableFormatValid || !workerPackageFormatValid || !compilerRuntimeFormatValid || !sdkArtifactFormatValid || !launcherPinValid || !workerPinValid || !profileValid || !workerProcessValid || !startupNonceValid || !taskDirectoryValid)
                throw new ArgumentException("Dynamic runtime registration is invalid or does not match the laboratory-pinned launcher/worker package and LPAC profile. Checks: runtime=" + runtimeValid + ", launcherFormat=" + launcherFormatValid + ", workerExecutableFormat=" + workerExecutableFormatValid + ", workerPackageFormat=" + workerPackageFormatValid + ", compilerRuntimeFormat=" + compilerRuntimeFormatValid + ", sdkArtifactFormat=" + sdkArtifactFormatValid + ", launcherPin=" + launcherPinValid + ", workerPin=" + workerPinValid + ", profile=" + profileValid + ", workerProcess=" + workerProcessValid + ", startupNonce=" + startupNonceValid + ", taskDirectory=" + taskDirectoryValid + ".");
            var key = Convert.FromBase64String(keyBase64 ?? "");
            if (key.Length != 32) throw new ArgumentException("Dynamic runtime signing key must be 256 bits.");
            var expires = DateTimeOffset.FromUnixTimeSeconds(expiresUnixSeconds).UtcDateTime;
            if (expires <= DateTime.UtcNow || expires > DateTime.UtcNow.AddMinutes(10)) throw new ArgumentException("Dynamic runtime registration expiration is invalid.");
            Keys[runtimeId] = new RuntimeKey { Key = key, ExpiresUtc = expires, LauncherHash = launcherHash, WorkerExecutableHash = workerExecutableHash, WorkerRuntimePackageHash = workerRuntimePackageHash, CompilerRuntimeHash = compilerRuntimeHash, SdkArtifactHash = sdkArtifactHash, SandboxProfile = sandboxProfile, WorkerProcessId = workerProcessId, StartupNonceHash = startupNonceHash, TaskDirectoryIdentity = taskDirectoryIdentity };
            foreach (var expired in Keys.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Keys.TryRemove(expired, out _);
        }
        public static void VerifyAndConsume(DynamicWorkerAdmission admission, string sourceHash, string programHash, string sdkHash, string graphHash, string documentFingerprint, string documentSession)
        {
            if (admission == null || admission.Schema != "dynamic-revit-worker-admission/v0" || !Keys.TryGetValue(admission.RuntimeInstanceId, out var runtime) || runtime.ExpiresUtc <= DateTime.UtcNow) throw new InvalidOperationException("Dynamic worker runtime is not registered or has expired.");
            if (!string.Equals(sdkHash, DynamicRevitSdkVersion.ManifestHash, StringComparison.Ordinal)) throw new InvalidOperationException("Dynamic worker SDK manifest does not match the trusted host SDK manifest.");
            if (!string.Equals(admission.WorkerExecutableHash, runtime.WorkerExecutableHash, StringComparison.Ordinal) || admission.WorkerProcessId != runtime.WorkerProcessId || !string.Equals(admission.StartupNonceHash, runtime.StartupNonceHash, StringComparison.Ordinal) || !string.Equals(admission.TaskDirectoryIdentity, runtime.TaskDirectoryIdentity, StringComparison.Ordinal)) throw new InvalidOperationException("Dynamic worker provenance does not match the launcher-registered executable, process, nonce, or task directory.");
            DynamicWorkerAdmissionPolicy.Validate(admission, runtime.Key, runtime.LauncherHash, runtime.SandboxProfile, sourceHash, programHash, sdkHash, graphHash, documentFingerprint, documentSession, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            if (string.IsNullOrWhiteSpace(admission.CorrelationId) || !UsedCorrelations.TryAdd(admission.RuntimeInstanceId + "\n" + admission.CorrelationId, 0)) throw new InvalidOperationException("Dynamic worker admission was replayed.");
        }

        internal static DynamicRuntimeV1Identity RequireV1Identity(string runtimeId)
        {
            if (!Keys.TryGetValue(runtimeId ?? "", out var runtime) || runtime.ExpiresUtc <= DateTime.UtcNow)
                throw new InvalidOperationException("Dynamic worker runtime is not registered or has expired.");
            return new DynamicRuntimeV1Identity
            {
                Key = (byte[])runtime.Key.Clone(), LauncherHash = runtime.LauncherHash, WorkerExecutableHash = runtime.WorkerExecutableHash,
                WorkerRuntimePackageHash = runtime.WorkerRuntimePackageHash, CompilerRuntimeHash = runtime.CompilerRuntimeHash, SdkArtifactHash = runtime.SdkArtifactHash,
                SandboxProfile = runtime.SandboxProfile, WorkerProcessId = runtime.WorkerProcessId,
                StartupNonceHash = runtime.StartupNonceHash, TaskDirectoryIdentity = runtime.TaskDirectoryIdentity
            };
        }
    }

    internal sealed class DynamicRuntimeV1Identity
    {
        public byte[] Key = Array.Empty<byte>(); public string LauncherHash = ""; public string WorkerExecutableHash = "";
        public string WorkerRuntimePackageHash = ""; public string CompilerRuntimeHash = ""; public string SdkArtifactHash = ""; public string SandboxProfile = "";
        public int WorkerProcessId; public string StartupNonceHash = ""; public string TaskDirectoryIdentity = "";
        public string AuthenticatedWorkerIdentityHash => DynamicWire.Sha256(WorkerExecutableHash + "\n" + WorkerRuntimePackageHash + "\n" + CompilerRuntimeHash + "\n" + SdkArtifactHash + "\n" + WorkerProcessId.ToString(CultureInfo.InvariantCulture) + "\n" + StartupNonceHash + "\n" + TaskDirectoryIdentity);
    }

    public sealed class DynamicRuntimeRegistrationHandler : IRequestHandler
    {
        private sealed class Request { public string? runtimeInstanceId { get; set; } public string? signingKeyBase64 { get; set; } public string? launcherExecutableHash { get; set; } public string? workerExecutableHash { get; set; } public string? workerRuntimePackageHash { get; set; } public string? compilerRuntimeHash { get; set; } public string? sdkArtifactHash { get; set; } public string? sandboxProfile { get; set; } public int workerProcessId { get; set; } public string? startupNonceHash { get; set; } public string? taskDirectoryIdentity { get; set; } public long expiresUnixSeconds { get; set; } public string? correlationId { get; set; } public long authExpiresUnixSeconds { get; set; } public string? requestMac { get; set; } }
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            ValidateShape(jsonData, new[] { "runtimeInstanceId", "signingKeyBase64", "launcherExecutableHash", "workerExecutableHash", "workerRuntimePackageHash", "compilerRuntimeHash", "sdkArtifactHash", "sandboxProfile", "workerProcessId", "startupNonceHash", "taskDirectoryIdentity", "expiresUnixSeconds", "correlationId", "authExpiresUnixSeconds", "requestMac" });
            var request = JsonSerializer.Deserialize<Request>(jsonData) ?? throw new ArgumentException("Dynamic runtime registration is invalid.");
            var core = JsonSerializer.Serialize(new { runtimeInstanceId = request.runtimeInstanceId, signingKeyBase64 = request.signingKeyBase64, launcherExecutableHash = request.launcherExecutableHash, workerExecutableHash = request.workerExecutableHash, workerRuntimePackageHash = request.workerRuntimePackageHash, compilerRuntimeHash = request.compilerRuntimeHash, sdkArtifactHash = request.sdkArtifactHash, sandboxProfile = request.sandboxProfile, workerProcessId = request.workerProcessId, startupNonceHash = request.startupNonceHash, taskDirectoryIdentity = request.taskDirectoryIdentity, expiresUnixSeconds = request.expiresUnixSeconds });
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.runtimeInstanceId ?? "", "register-worker", request.correlationId ?? "", request.authExpiresUnixSeconds, DynamicWire.Sha256(core), request.requestMac ?? "");
            DynamicRuntimeAdmissionRegistry.Register(request.runtimeInstanceId ?? "", request.signingKeyBase64 ?? "", request.launcherExecutableHash ?? "", request.workerExecutableHash ?? "", request.workerRuntimePackageHash ?? "", request.compilerRuntimeHash ?? "", request.sdkArtifactHash ?? "", request.sandboxProfile ?? "", request.workerProcessId, request.startupNonceHash ?? "", request.taskDirectoryIdentity ?? "", request.expiresUnixSeconds);
            var receipt = new { schema = "dynamic-revit-runtime-registration-receipt/v0", ok = true, runtime_instance_id = request.runtimeInstanceId, expires_unix_seconds = request.expiresUnixSeconds };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.runtimeInstanceId ?? "", "register-worker-receipt", receipt));
        }
        private static void ValidateShape(string json, string[] fields)
        {
            using var document = JsonDocument.Parse(json);
            var names = document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement.EnumerateObject().Select(property => property.Name).ToArray() : Array.Empty<string>();
            if (names.Length != fields.Length || names.Distinct(StringComparer.Ordinal).Count() != names.Length || names.Any(name => !fields.Contains(name, StringComparer.Ordinal))) throw new ArgumentException("Dynamic runtime registration has an invalid field set.");
        }
    }

    /// <summary>Experimental DTO-only endpoint. It deliberately returns no Revit object references or raw paths.</summary>
    public sealed class DynamicRuntimeSnapshotHandler : IRequestHandler
    {
        private sealed class SnapshotGrant
        {
            public string DocumentFingerprint { get; set; } = "";
            public string DocumentSessionId { get; set; } = "";
            public HashSet<string> TargetIds { get; set; } = new HashSet<string>(StringComparer.Ordinal);
            public Dictionary<string, string> TargetStateHashes { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
            public string[] ParameterNames { get; set; } = Array.Empty<string>();
            public string InputHash { get; set; } = "";
            public DateTime ExpiresUtc { get; set; }
        }
        private static readonly ConcurrentDictionary<string, SnapshotGrant> Grants = new ConcurrentDictionary<string, SnapshotGrant>(StringComparer.Ordinal);
        private sealed class Request { public string? category { get; set; } public int? limit { get; set; } public string[]? parameters { get; set; } public int? operationBudget { get; set; } public string? runtimeInstanceId { get; set; } public string? correlationId { get; set; } public long authExpiresUnixSeconds { get; set; } public string? requestMac { get; set; } }
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            ValidateShape(jsonData);
            var request = string.IsNullOrWhiteSpace(jsonData) ? new Request() : JsonSerializer.Deserialize<Request>(jsonData) ?? new Request();
            var core = JsonSerializer.Serialize(new { category = request.category, limit = request.limit, parameters = request.parameters, operationBudget = request.operationBudget });
            DynamicRuntimeBootstrapRegistry.VerifyRequest(request.runtimeInstanceId ?? "", "snapshot", request.correlationId ?? "", request.authExpiresUnixSeconds, DynamicWire.Sha256(core), request.requestMac ?? "");
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            var limit = request.limit ?? 200;
            if (limit < 1 || limit > 1000) throw new ArgumentException("limit must be 1 through 1000.");
            var operationBudget = request.operationBudget ?? 32;
            if (operationBudget < 1 || operationBudget > 256) throw new ArgumentException("operationBudget must be 1 through 256.");
            var requestedParameters = (request.parameters ?? Array.Empty<string>()).Where(p => !string.IsNullOrWhiteSpace(p)).Select(p => p.Trim()).Distinct(StringComparer.Ordinal).Take(17).ToArray();
            if (requestedParameters.Length > 16 || requestedParameters.Any(parameter => parameter.Length > 128)) throw new ArgumentException("At most 16 bounded parameter names are allowed.");
            var collector = new FilteredElementCollector(doc).WhereElementIsNotElementType();
            if (!string.IsNullOrWhiteSpace(request.category))
            {
                if (!Enum.TryParse<BuiltInCategory>(request.category, true, out var category)) throw new ArgumentException("Snapshot category must be a BuiltInCategory token.");
                collector.OfCategory(category);
            }
            var elements = collector.Take(limit).Select(element => ToDto(doc, element, requestedParameters)).ToArray();
            var document = new DynamicDocumentDto { ProjectFingerprint = Fingerprint(doc), SessionId = Session(doc), Title = doc.Title ?? "", ActiveViewId = ElementIdCompat.GetValue(app.ActiveUIDocument.ActiveView.Id), ActiveViewName = app.ActiveUIDocument.ActiveView.Name ?? "" };
            var input = new DynamicTaskInput { Document = document, Elements = elements, OperationBudget = operationBudget };
            var inputHash = DynamicWire.InputHash(input);
            var token = "experimental:" + Guid.NewGuid().ToString("N");
            Grants[token] = new SnapshotGrant
            {
                DocumentFingerprint = document.ProjectFingerprint,
                DocumentSessionId = document.SessionId,
                InputHash = inputHash,
                TargetIds = new HashSet<string>(elements.Select(element => element.UniqueId), StringComparer.Ordinal),
                TargetStateHashes = elements.ToDictionary(element => element.UniqueId, ElementStateHash, StringComparer.Ordinal),
                ParameterNames = requestedParameters,
                ExpiresUtc = DateTime.UtcNow.AddMinutes(2)
            };
            foreach (var expired in Grants.Where(pair => pair.Value.ExpiresUtc <= DateTime.UtcNow).Select(pair => pair.Key).ToArray()) Grants.TryRemove(expired, out _);
            var receipt = new { schema = "dynamic-revit-snapshot/v0", sdk = DynamicRevitSdkVersion.Value, input_hash = inputHash, document, snapshot_token = token, elements };
            return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.runtimeInstanceId ?? "", "snapshot-receipt", receipt));
        }

        private static void ValidateShape(string json)
        {
            using var document = JsonDocument.Parse(json);
            var fields = new HashSet<string>(new[] { "category", "limit", "parameters", "operationBudget", "runtimeInstanceId", "correlationId", "authExpiresUnixSeconds", "requestMac" }, StringComparer.Ordinal);
            var names = document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement.EnumerateObject().Select(property => property.Name).ToArray() : Array.Empty<string>();
            if (names.Length != fields.Count || names.Distinct(StringComparer.Ordinal).Count() != names.Length || names.Any(name => !fields.Contains(name))) throw new ArgumentException("Dynamic snapshot request has an invalid field set.");
        }

        internal static bool ConsumeGrant(Document document, string? token, string fingerprint, string session, string inputHash, IEnumerable<string> targetIds)
        {
            if (string.IsNullOrWhiteSpace(token) || !Grants.TryRemove(token, out var grant)) return false;
            if (document == null || grant.ExpiresUtc <= DateTime.UtcNow || !Equal(grant.DocumentFingerprint, fingerprint) ||
                !Equal(grant.DocumentSessionId, session) || !Equal(grant.InputHash, inputHash)) return false;
            foreach (var id in targetIds.Distinct(StringComparer.Ordinal))
            {
                if (!grant.TargetIds.Contains(id) || !grant.TargetStateHashes.TryGetValue(id, out var expected)) return false;
                var element = document.GetElement(id);
                if (element == null || !Equal(expected, ElementStateHash(ToDto(document, element, grant.ParameterNames)))) return false;
            }
            return true;
        }

        internal static string Fingerprint(Document doc)
        {
            string? projectUniqueId = null;
            try { projectUniqueId = doc.ProjectInformation?.UniqueId; } catch { }
            return "sha256:" + OperatorRevitBatchBinding.ComputeProjectFingerprint(doc.Title, doc.PathName, projectUniqueId);
        }
        internal static string Session(Document doc) => OperatorNativeDocumentSessionAuthority.GetSessionId(doc);
        private static string Hash(string value) { using var sha = SHA256.Create(); return "sha256:" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant(); }
        private static string ElementStateHash(DynamicElementDto element)
            => DynamicWire.InputHash(new DynamicTaskInput
            {
                Document = new DynamicDocumentDto(),
                Elements = new[] { element },
                OperationBudget = 1
            });
        private static bool Equal(string? left, string? right) => string.Equals(left, right, StringComparison.Ordinal);
        private static DynamicElementDto ToDto(Document doc, Element element, string[] parameterNames)
        {
            var result = new DynamicElementDto { UniqueId = element.UniqueId ?? "", ElementId = ElementIdCompat.GetValue(element.Id), Category = element.Category?.Name ?? "", TypeName = Safe(() => element.Name), IsPinned = SafeBool(() => element.Pinned), IsGrouped = element.GroupId != ElementId.InvalidElementId };
            if (element is FamilyInstance instance)
            {
                result.FamilyName = Safe(() => instance.Symbol?.FamilyName);
                result.HostUniqueId = Safe(() => instance.Host?.UniqueId);
            }
            foreach (var name in parameterNames)
            {
                var parameter = SafeParameter(element, name);
                if (parameter == null) continue;
                result.Parameters[name] = ReadParameter(parameter);
                if (!parameter.IsReadOnly && parameter.StorageType == StorageType.String) result.WritableParameters = result.WritableParameters.Concat(new[] { name }).ToArray();
            }
            result.Location = Location(element);
            result.LocationKind = element.Location is LocationPoint ? "point" : element.Location is LocationCurve ? "curve" : null;
            result.BoundingBox = Box(element);
            return result;
        }
        private static Parameter? SafeParameter(Element element, string name) { try { return element.LookupParameter(name); } catch { return null; } }
        private static string? ReadParameter(Parameter parameter) { try { return parameter.StorageType == StorageType.String ? parameter.AsString() : parameter.AsValueString(); } catch { return null; } }
        private static DynamicPointDto? Location(Element element)
        {
            try
            {
                if (element.Location is LocationPoint point) return Point(point.Point);
                if (element.Location is LocationCurve curve) return Point(curve.Curve.Evaluate(0.5, true));
            }
            catch { }
            return null;
        }
        private static DynamicBoxDto? Box(Element element) { try { var box = element.get_BoundingBox(null); return box == null ? null : new DynamicBoxDto { Min = Point(box.Min), Max = Point(box.Max) }; } catch { return null; } }
        private static DynamicPointDto Point(XYZ point) => new DynamicPointDto { X = point.X, Y = point.Y, Z = point.Z };
        private static string? Safe(Func<string?> getter) { try { return getter(); } catch { return null; } }
        private static bool SafeBool(Func<bool> getter) { try { return getter(); } catch { return false; } }
    }

    /// <summary>Preview-only execution boundary. Program DLLs are never accepted or loaded here.</summary>
    public sealed class DynamicRuntimePreviewHandler : IRequestHandler
    {
        private sealed class Request
        {
            public string? schema { get; set; }
            public string? phase { get; set; }
            public string? sourceHash { get; set; }
            public string? programHash { get; set; }
            public string? sdkHash { get; set; }
            public string? documentFingerprint { get; set; }
            public string? documentSessionId { get; set; }
            public string? snapshotToken { get; set; }
            public int? operationBudget { get; set; }
            public DynamicOperationGraph? graph { get; set; }
            public DynamicWorkerAdmission? admission { get; set; }
        }
        private sealed class ElementState { public long Id; public string UniqueId = ""; public string Hash = ""; }
        private sealed class PendingChange { public XYZ? Point; public string? ParameterValue; }
        private const int ExecutionDeadlineMilliseconds = 5000;
        private const int RollbackBaselineElementLimit = 25000;
        private static readonly JsonSerializerOptions WireJson = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var stopwatch = Stopwatch.StartNew();
            ValidateExactRequest(jsonData);
            var request = JsonSerializer.Deserialize<Request>(jsonData, WireJson) ?? throw new ArgumentException("Dynamic preview request is invalid.");
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active document.");
            if (request.schema != "dynamic-revit-preview-request/v0" || request.phase != "preview") throw new ArgumentException("Only dynamic-revit preview/v0 requests are supported.");
            if (!Equal(request.documentFingerprint, DynamicRuntimeSnapshotHandler.Fingerprint(doc)) || !Equal(request.documentSessionId, DynamicRuntimeSnapshotHandler.Session(doc))) throw new InvalidOperationException("Dynamic preview document binding changed.");
            if (!Hash(request.sourceHash) || !Hash(request.programHash) || !Hash(request.sdkHash)) throw new ArgumentException("Dynamic preview hashes are invalid.");
            var graph = request.graph ?? throw new ArgumentException("Dynamic preview graph is required.");
            var budget = request.operationBudget ?? 32;
            ValidateGraph(graph, budget);
            if (!DynamicRuntimeSnapshotHandler.ConsumeGrant(doc, request.snapshotToken, request.documentFingerprint!, request.documentSessionId!, graph.InputHash, graph.Operations.Select(operation => operation.TargetUniqueId))) throw new InvalidOperationException("Dynamic preview snapshot capability is invalid, expired, replayed, stale, not bound to this exact DTO input, or out of scope.");
            DynamicRuntimeAdmissionRegistry.VerifyAndConsume(request.admission!, request.sourceHash!, request.programHash!, request.sdkHash!, graph.GraphHash, request.documentFingerprint!, request.documentSessionId!);
            var warnings = new List<string>();
            var failures = new List<DynamicCapturedFailure>();
            var projected = new List<object>();
            var attempted = new List<object>();
            var baseline = CaptureDocumentBaseline(doc, stopwatch);
            var requestedTargetElementIds = graph.Operations
                .Select(operation => doc.GetElement(operation.TargetUniqueId) ?? throw new InvalidOperationException("Target no longer exists before preview: " + operation.TargetUniqueId))
                .Select(element => ElementIdCompat.GetValue(element.Id))
                .Distinct()
                .ToArray();
            var rollbackTruth = false;
            var rollbackStatus = TransactionStatus.Uninitialized;
            var addedElementIds = new HashSet<long>();
            var modifiedElementIds = new HashSet<long>();
            var deletedElementIds = new HashSet<long>();
            string? changeTrackingError = null;
            EventHandler<DocumentChangedEventArgs>? changed = (sender, args) =>
            {
                try
                {
                    var changedDocument = args.GetDocument();
                    if (!Equal(DynamicRuntimeSnapshotHandler.Fingerprint(changedDocument), DynamicRuntimeSnapshotHandler.Fingerprint(doc))) return;
                    foreach (var id in args.GetAddedElementIds()) addedElementIds.Add(ElementIdCompat.GetValue(id));
                    foreach (var id in args.GetModifiedElementIds()) modifiedElementIds.Add(ElementIdCompat.GetValue(id));
                    foreach (var id in args.GetDeletedElementIds()) deletedElementIds.Add(ElementIdCompat.GetValue(id));
                }
                catch (Exception ex) { changeTrackingError = ex.Message; }
            };
            TransactionGroup? group = null;
            try
            {
                group = new TransactionGroup(doc, "Dynamic Revit Runtime Preview");
                if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Unable to start dynamic preview transaction group.");
                app.Application.DocumentChanged += changed;
                foreach (var operation in graph.Operations)
                {
                    CheckDeadline(stopwatch);
                    var element = doc.GetElement(operation.TargetUniqueId) ?? throw new InvalidOperationException("Target no longer exists: " + operation.TargetUniqueId);
                    if (element.Pinned || element.GroupId != ElementId.InvalidElementId) throw new InvalidOperationException("Pinned or grouped target is not eligible: " + operation.TargetUniqueId);
                    if (operation.Kind == "move_element" && !(element.Location is LocationPoint)) throw new InvalidOperationException("Only LocationPoint targets are eligible for experimental movement: " + operation.TargetUniqueId);
                    var before = CaptureBefore(element, operation);
                    attempted.Add(new { operation_id = operation.OperationId, kind = operation.Kind, unique_id = operation.TargetUniqueId });
                    using (var transaction = new Transaction(doc, "Dynamic " + operation.Kind))
                    {
                        var operationFailures = new List<DynamicCapturedFailure>();
                        if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Unable to start dynamic operation transaction.");
                        try
                        {
                            transaction.SetFailureHandlingOptions(DynamicFailureHandlingUtil.ConfigureFailureCapture(transaction, operationFailures));
                            Apply(doc, element, operation);
                            var status = transaction.Commit();
                            if (status != TransactionStatus.Committed) throw new InvalidOperationException("Dynamic operation did not commit: " + status + ".");
                            projected.Add(CaptureCommittedChange(element, operation, before));
                            warnings.AddRange(operationFailures.Where(f => f.severity == "warning").Select(f => f.message));
                            CheckDeadline(stopwatch);
                        }
                        finally { failures.AddRange(operationFailures); if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); }
                    }
                }
                app.Application.DocumentChanged -= changed;
                changed = null;
                if (changeTrackingError != null) throw new InvalidOperationException("DocumentChanged capture was incomplete: " + changeTrackingError);
                var changedElementIds = addedElementIds.Concat(modifiedElementIds).Concat(deletedElementIds).Distinct().ToArray();
                if (changedElementIds.Length > budget) throw new InvalidOperationException("Dynamic preview changed-element budget exceeded.");
                rollbackStatus = group.RollBack();
                if (rollbackStatus != TransactionStatus.RolledBack) throw new InvalidOperationException("Preview rollback did not report RolledBack: " + rollbackStatus + ".");
                var rollbackVerifiedElementIds = changedElementIds.Concat(requestedTargetElementIds).Distinct().ToArray();
                rollbackTruth = VerifyRollback(doc, baseline, rollbackVerifiedElementIds);
                if (!rollbackTruth) throw new InvalidOperationException("Preview rollback verification failed.");
                var previewId = "preview_" + Guid.NewGuid().ToString("N");
                var receipt = new { schema = "dynamic-revit-preview-receipt/v0", ok = true, preview_id = previewId, source_hash = request.sourceHash, program_hash = request.programHash, sdk_hash = request.sdkHash, input_hash = graph.InputHash, graph_hash = graph.GraphHash, document_fingerprint = request.documentFingerprint, document_session_id = request.documentSessionId, worker_identity = request.admission, operation_count = graph.Operations.Count, target_ids = graph.Operations.Select(operation => operation.TargetUniqueId).ToArray(), projected_changed_element_ids = changedElementIds.OrderBy(id => id).ToArray(), rollback_verified_element_ids = rollbackVerifiedElementIds.OrderBy(id => id).ToArray(), change_tracking = new { complete = true, added = addedElementIds.OrderBy(id => id).ToArray(), modified = modifiedElementIds.OrderBy(id => id).ToArray(), deleted = deletedElementIds.OrderBy(id => id).ToArray() }, projected_changes = projected, failures = failures.Take(64).ToArray(), warnings = warnings.Distinct().Take(64).ToArray(), rollback_status = rollbackStatus.ToString(), rollback_truth = true, elapsed_milliseconds = stopwatch.ElapsedMilliseconds };
                var previewReceiptHash = DynamicWire.Sha256(JsonSerializer.Serialize(receipt));
                DynamicRuntimeApplyState.RegisterPreview(previewId, previewReceiptHash, request.admission!.RuntimeInstanceId, request.sourceHash!, request.programHash!, graph, doc);
                return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.admission!.RuntimeInstanceId, "preview-receipt", receipt));
            }
            catch (Exception ex)
            {
                try
                {
                    if (changed != null) { app.Application.DocumentChanged -= changed; changed = null; }
                    if (group != null && group.GetStatus() == TransactionStatus.Started) rollbackStatus = group.RollBack();
                    else if (group != null) rollbackStatus = group.GetStatus();
                    var changedElementIds = addedElementIds.Concat(modifiedElementIds).Concat(deletedElementIds).Distinct().ToArray();
                    var rollbackVerifiedElementIds = changedElementIds.Concat(requestedTargetElementIds).Distinct().ToArray();
                    rollbackTruth = rollbackStatus == TransactionStatus.RolledBack && changeTrackingError == null && VerifyRollback(doc, baseline, rollbackVerifiedElementIds);
                }
                catch { rollbackTruth = false; }
                var changedIds = addedElementIds.Concat(modifiedElementIds).Concat(deletedElementIds).Distinct().OrderBy(id => id).ToArray();
                var rollbackVerifiedIds = changedIds.Concat(requestedTargetElementIds).Distinct().OrderBy(id => id).ToArray();
                var receipt = new { schema = "dynamic-revit-preview-receipt/v0", ok = false, source_hash = request.sourceHash, program_hash = request.programHash, sdk_hash = request.sdkHash, input_hash = graph.InputHash, graph_hash = graph.GraphHash, document_fingerprint = request.documentFingerprint, document_session_id = request.documentSessionId, worker_identity = request.admission, operation_count = graph.Operations.Count, attempted_operations = attempted, projected_changed_element_ids = changedIds, rollback_verified_element_ids = rollbackVerifiedIds, change_tracking = new { complete = changeTrackingError == null, error = changeTrackingError, added = addedElementIds.OrderBy(id => id).ToArray(), modified = modifiedElementIds.OrderBy(id => id).ToArray(), deleted = deletedElementIds.OrderBy(id => id).ToArray() }, committed_projected_changes = projected, failures = failures.Take(64).ToArray(), warnings = warnings.Distinct().Take(64).ToArray(), failure = ex.Message, rollback_status = rollbackStatus.ToString(), rollback_truth = rollbackTruth, elapsed_milliseconds = stopwatch.ElapsedMilliseconds };
                return Task.FromResult(DynamicRuntimeBootstrapRegistry.AuthenticateReceipt(request.admission!.RuntimeInstanceId, "preview-receipt", receipt));
            }
            finally { if (changed != null) app.Application.DocumentChanged -= changed; group?.Dispose(); }
        }
        private static void Apply(Document doc, Element element, DynamicOperation operation)
        {
            if (operation.Kind == "move_element")
            {
                var vector = operation.VectorFeet!;
                ElementTransformUtils.MoveElement(doc, element.Id, new XYZ(vector[0], vector[1], vector[2]));
                return;
            }
            if (operation.Kind == "set_parameter")
            {
                var parameter = element.LookupParameter(operation.Parameter!) ?? throw new InvalidOperationException("Parameter unavailable: " + operation.Parameter);
                if (parameter.IsReadOnly || parameter.StorageType != StorageType.String) throw new InvalidOperationException("Parameter is not writable text: " + operation.Parameter);
                if (!parameter.Set(operation.Value!)) throw new InvalidOperationException("Parameter set failed: " + operation.Parameter);
                return;
            }
            throw new InvalidOperationException("Unsupported dynamic operation: " + operation.Kind);
        }
        private static PendingChange CaptureBefore(Element element, DynamicOperation operation)
        {
            var state = new PendingChange();
            if (operation.Kind == "move_element" && element.Location is LocationPoint point) state.Point = point.Point;
            if (operation.Kind == "set_parameter") state.ParameterValue = element.LookupParameter(operation.Parameter!)?.AsString();
            return state;
        }
        private static object CaptureCommittedChange(Element element, DynamicOperation operation, PendingChange before)
        {
            if (operation.Kind == "move_element")
            {
                if (before.Point == null || !(element.Location is LocationPoint point)) throw new InvalidOperationException("Moved target has no observable LocationPoint after commit.");
                return new { operation_id = operation.OperationId, kind = operation.Kind, unique_id = operation.TargetUniqueId, before = PointValue(before.Point), after = PointValue(point.Point), requested_vector_feet = operation.VectorFeet };
            }
            var parameter = element.LookupParameter(operation.Parameter!) ?? throw new InvalidOperationException("Parameter disappeared after commit: " + operation.Parameter);
            return new { operation_id = operation.OperationId, kind = operation.Kind, unique_id = operation.TargetUniqueId, parameter = operation.Parameter, before = before.ParameterValue, after = parameter.AsString() };
        }
        private static object PointValue(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };
        private static Dictionary<long, ElementState> CaptureDocumentBaseline(Document doc, Stopwatch stopwatch)
        {
            var baseline = new Dictionary<long, ElementState>();
            foreach (var element in new FilteredElementCollector(doc).WhereElementIsNotElementType())
            {
                if (baseline.Count >= RollbackBaselineElementLimit) throw new InvalidOperationException("Document exceeds the Phase-2 rollback baseline limit of " + RollbackBaselineElementLimit + " elements.");
                if ((baseline.Count & 63) == 0) CheckDeadline(stopwatch);
                baseline.Add(ElementIdCompat.GetValue(element.Id), CaptureElementState(element));
            }
            CheckDeadline(stopwatch);
            return baseline;
        }
        private static ElementState CaptureElementState(Element element)
        {
            var id = ElementIdCompat.GetValue(element.Id);
            var fields = new List<string> { id.ToString(CultureInfo.InvariantCulture), element.UniqueId ?? "", ElementIdCompat.GetValue(element.GetTypeId()).ToString(CultureInfo.InvariantCulture), element.Pinned ? "1" : "0", ElementIdCompat.GetValue(element.GroupId).ToString(CultureInfo.InvariantCulture) };
            if (element.Location is LocationPoint point) fields.Add("point:" + Coordinate(point.Point));
            else if (element.Location is LocationCurve curve) fields.Add("curve:" + Coordinate(curve.Curve.GetEndPoint(0)) + ":" + Coordinate(curve.Curve.GetEndPoint(1)));
            foreach (Parameter parameter in element.Parameters)
            {
                try
                {
                    var parameterId = ElementIdCompat.GetValue(parameter.Id).ToString(CultureInfo.InvariantCulture);
                    var storageType = parameter.StorageType;
                    var value = storageType == StorageType.String ? parameter.AsString() ?? "" : storageType == StorageType.Integer ? parameter.AsInteger().ToString(CultureInfo.InvariantCulture) : storageType == StorageType.Double ? parameter.AsDouble().ToString("R", CultureInfo.InvariantCulture) : storageType == StorageType.ElementId ? ElementIdCompat.GetValue(parameter.AsElementId()).ToString(CultureInfo.InvariantCulture) : "";
                    fields.Add("p:" + parameterId + ":" + storageType + ":" + value);
                }
                catch (Exception ex) { fields.Add("parameter-capture-error:" + ex.GetType().Name); }
            }
            fields.Sort(StringComparer.Ordinal);
            using var sha = SHA256.Create();
            var hash = "sha256:" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", fields)))).Replace("-", "").ToLowerInvariant();
            return new ElementState { Id = id, UniqueId = element.UniqueId ?? "", Hash = hash };
        }
        internal static string TrustedElementStateHash(Element element) => CaptureElementState(element).Hash;
        private static string Coordinate(XYZ point) => point.X.ToString("R", CultureInfo.InvariantCulture) + "," + point.Y.ToString("R", CultureInfo.InvariantCulture) + "," + point.Z.ToString("R", CultureInfo.InvariantCulture);
        private static bool VerifyRollback(Document doc, IReadOnlyDictionary<long, ElementState> baseline, IEnumerable<long> changedIds)
        {
            foreach (var id in changedIds.Distinct())
            {
                var current = doc.GetElement(ElementIdCompat.Create(id));
                if (!baseline.TryGetValue(id, out var prior)) { if (current != null) return false; continue; }
                if (current == null) return false;
                var restored = CaptureElementState(current);
                if (!string.Equals(prior.UniqueId, restored.UniqueId, StringComparison.Ordinal) || !string.Equals(prior.Hash, restored.Hash, StringComparison.Ordinal)) return false;
            }
            return true;
        }
        private static void CheckDeadline(Stopwatch stopwatch)
        {
            if (stopwatch.ElapsedMilliseconds > ExecutionDeadlineMilliseconds) throw new TimeoutException("Dynamic preview exceeded the host execution deadline of " + ExecutionDeadlineMilliseconds + " ms.");
        }
        private static void ValidateGraph(DynamicOperationGraph graph, int budget)
        {
            DynamicOperationGraphAdmission.Validate(graph, budget, budget);
        }
        private static void ValidateExactRequest(string json)
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object) throw new ArgumentException("Dynamic preview request must be an object.");
            var expected = new HashSet<string>(new[] { "schema", "phase", "sourceHash", "programHash", "sdkHash", "documentFingerprint", "documentSessionId", "snapshotToken", "operationBudget", "graph", "admission" }, StringComparer.Ordinal);
            if (!HasExactProperties(document.RootElement, expected)) throw new ArgumentException("Dynamic preview request has an invalid field set.");
            var graph = document.RootElement.GetProperty("graph");
            var graphFields = new HashSet<string>(new[] { "schema", "inputHash", "operations", "graphHash" }, StringComparer.Ordinal);
            if (!HasExactProperties(graph, graphFields)) throw new ArgumentException("Dynamic preview graph has an invalid field set.");
            var operationFields = new HashSet<string>(new[] { "operationId", "kind", "targetUniqueId", "vectorFeet", "parameter", "value" }, StringComparer.Ordinal);
            if (graph.GetProperty("operations").ValueKind != JsonValueKind.Array || graph.GetProperty("operations").EnumerateArray().Any(operation => !HasExactProperties(operation, operationFields))) throw new ArgumentException("Dynamic preview operation has an invalid field set.");
            var admission = document.RootElement.GetProperty("admission");
            var admissionFields = new HashSet<string>(new[] { "schema", "runtimeInstanceId", "launcherExecutableHash", "workerExecutableHash", "sandboxProfile", "workerProcessId", "startupNonceHash", "taskDirectoryIdentity", "sourceHash", "programHash", "sdkVersion", "sdkHash", "operationGraphHash", "documentFingerprint", "documentSessionId", "correlationId", "expiresUnixSeconds", "signature" }, StringComparer.Ordinal);
            if (!HasExactProperties(admission, admissionFields)) throw new ArgumentException("Dynamic worker admission has an invalid field set.");
        }
        private static bool HasExactProperties(JsonElement value, HashSet<string> expected)
        {
            if (value.ValueKind != JsonValueKind.Object) return false;
            var names = value.EnumerateObject().Select(property => property.Name).ToArray();
            return names.Length == expected.Count && names.Distinct(StringComparer.Ordinal).Count() == names.Length && names.All(expected.Contains);
        }
        internal static bool IsHash(string? value) => value != null && System.Text.RegularExpressions.Regex.IsMatch(value, "^sha256:[0-9a-f]{64}$");
        private static bool Hash(string? value) => IsHash(value);
        private static bool Equal(string? left, string right) => string.Equals(left, right, StringComparison.Ordinal);
    }
}

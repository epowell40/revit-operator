using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Runtime.Loader;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using RevitOperator.DynamicRevitSdk;

namespace RevitOperator.DynamicRevitWorker;

internal sealed class WorkerInput
{
    public string Schema { get; set; } = "dynamic-revit-worker-input/v0";
    public string Source { get; set; } = "";
    public DynamicTaskInput Input { get; set; } = new();
    public int DeadlineMs { get; set; } = 10_000;
    public long? ResultReferenceDocumentRevision { get; set; }
    public string ResultReferenceSnapshotHash { get; set; } = "";
    public string ResultReferenceScopeHash { get; set; } = "";
    public IReadOnlyList<DynamicBuildingSystemsEnvelopeV1> BuildingSystemsPages { get; set; } = Array.Empty<DynamicBuildingSystemsEnvelopeV1>();
    public IReadOnlyList<DynamicTrustedElementFactV1> TrustedExternalTargets { get; set; } = Array.Empty<DynamicTrustedElementFactV1>();
    public DynamicVerifiedContextRuleV1? VerifiedContextRule { get; set; }
    public IReadOnlyList<DynamicObservationEnvelopeV1> ContextObservationPages { get; set; } = Array.Empty<DynamicObservationEnvelopeV1>();
}

internal sealed class WorkerOutput
{
    public string Schema { get; set; } = "dynamic-revit-worker-output/v0";
    public bool Ok { get; set; }
    public string SourceHash { get; set; } = "";
    public string? ProgramHash { get; set; }
    public string? CompiledAssemblyHash { get; set; }
    public string SdkHash { get; set; } = "";
    public string ExecutionStatus { get; set; } = "failed";
    public string? ExecutionIdentityHash { get; set; }
    public bool DeterministicReplayVerified { get; set; }
    public string DiagnosticBundleHash { get; set; } = "";
    public long CompileElapsedMs { get; set; }
    public long ExecutionElapsedMs { get; set; }
    public DynamicOperationGraph? Graph { get; set; }
    public DynamicResultReferenceProgramResultV1? ResultReferenceProgramResult { get; set; }
    public DynamicCoreProgramResultV1? CoreProgramResult { get; set; }
    public string[] Logs { get; set; } = Array.Empty<string>();
    public IReadOnlyDictionary<string, string> Report { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
    public WorkerDiagnostic[] Diagnostics { get; set; } = Array.Empty<WorkerDiagnostic>();
}

internal sealed class WorkerDiagnostic
{
    public string Code { get; set; } = "";
    public string Message { get; set; } = "";
    public string Phase { get; set; } = "";
    public string Severity { get; set; } = "error";
    public string RepairAction { get; set; } = "";
    public int? Line { get; set; }
    public int? Column { get; set; }
    public int? EndLine { get; set; }
    public int? EndColumn { get; set; }
    public string? StepId { get; set; }
    public string? AssertionId { get; set; }
    public bool Retryable { get; set; }
}

internal static class WorkerDiagnosticProtocol
{
    public static void Prepare(WorkerOutput output)
    {
        if (output.Diagnostics.Length > 32) output.Diagnostics = output.Diagnostics.Take(32).ToArray();
        foreach (var diagnostic in output.Diagnostics)
        {
            diagnostic.Code = Bound(diagnostic.Code, 128, "WORKER_DIAGNOSTIC_INVALID");
            diagnostic.Message = Bound(diagnostic.Message, 2_048, "Worker diagnostic message was empty.");
            if (string.IsNullOrWhiteSpace(diagnostic.Phase)) diagnostic.Phase = PhaseFor(diagnostic.Code);
            if (string.IsNullOrWhiteSpace(diagnostic.RepairAction)) diagnostic.RepairAction = RepairFor(diagnostic.Code);
            diagnostic.Phase = Bound(diagnostic.Phase, 64, "worker");
            diagnostic.Severity = Bound(diagnostic.Severity, 16, "error");
            diagnostic.RepairAction = Bound(diagnostic.RepairAction, 96, "inspect_diagnostic");
            diagnostic.StepId = BoundNullable(diagnostic.StepId, 128);
            diagnostic.AssertionId = BoundNullable(diagnostic.AssertionId, 128);
            if (!diagnostic.Retryable) diagnostic.Retryable = Repairable(diagnostic.Code);
        }
        var canonical = string.Join("\n", output.Diagnostics.Select(diagnostic => string.Join("|", new[]
        {
            diagnostic.Code, diagnostic.Phase, diagnostic.Severity, diagnostic.RepairAction,
            diagnostic.Line?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "",
            diagnostic.Column?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "",
            diagnostic.EndLine?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "",
            diagnostic.EndColumn?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "",
            diagnostic.StepId ?? "", diagnostic.AssertionId ?? "", diagnostic.Retryable ? "1" : "0",
            DynamicWire.Sha256(diagnostic.Message)
        })));
        output.DiagnosticBundleHash = DynamicWire.Sha256("dynamic-revit-worker-diagnostics/v1\n" + canonical);
    }

    private static bool Repairable(string code) =>
        code.StartsWith("CS", StringComparison.Ordinal) || code is "POLICY_SOURCE_FORBIDDEN" or "REVIT_REFERENCE_FORBIDDEN" or
        "PROGRAM_INTERFACE_REQUIRED" or "POLICY_SYMBOL_FORBIDDEN" or "METADATA_REFERENCE_FORBIDDEN" or "PINVOKE_FORBIDDEN" or
        "PROGRAM_ASSERTION_FAILED" or "PROGRAM_EXCEPTION" or "NONDETERMINISTIC_PROGRAM" or "WORKER_DEADLINE" or
        "INPUT_BUDGET" or "REPORT_BUDGET";

    private static string PhaseFor(string code) => code switch
    {
        var value when value.StartsWith("CS", StringComparison.Ordinal) => "compile",
        "POLICY_SOURCE_FORBIDDEN" or "REVIT_REFERENCE_FORBIDDEN" or "PROGRAM_INTERFACE_REQUIRED" or "POLICY_SYMBOL_FORBIDDEN" => "source_admission",
        "METADATA_REFERENCE_FORBIDDEN" or "PINVOKE_FORBIDDEN" => "metadata_admission",
        "PROGRAM_ASSERTION_FAILED" or "PROGRAM_EXCEPTION" or "WORKER_DEADLINE" => "execute",
        "NONDETERMINISTIC_PROGRAM" => "deterministic_replay",
        "REPORT_BUDGET" => "output_validation",
        "WORKER_SCHEMA" or "SOURCE_SIZE" or "DEADLINE" or "INPUT_BUDGET" or "WORKER_INPUT_FAILURE" => "input_validation",
        "SANDBOX_EXECUTION_FAILURE" => "sandbox",
        _ => "worker"
    };

    private static string RepairFor(string code) => code switch
    {
        var value when value.StartsWith("CS", StringComparison.Ordinal) => "edit_source",
        "POLICY_SOURCE_FORBIDDEN" or "REVIT_REFERENCE_FORBIDDEN" or "POLICY_SYMBOL_FORBIDDEN" or "METADATA_REFERENCE_FORBIDDEN" or "PINVOKE_FORBIDDEN" => "remove_forbidden_api",
        "PROGRAM_INTERFACE_REQUIRED" => "implement_one_supported_program_interface",
        "PROGRAM_ASSERTION_FAILED" => "revise_plan_or_request_facts",
        "PROGRAM_EXCEPTION" => "inspect_trace_and_repair_source",
        "NONDETERMINISTIC_PROGRAM" => "remove_nondeterminism",
        "WORKER_DEADLINE" => "reduce_scope_or_optimize",
        "INPUT_BUDGET" or "REPORT_BUDGET" => "reduce_scope_or_output",
        "WORKER_SCHEMA" or "SOURCE_SIZE" or "DEADLINE" or "WORKER_INPUT_FAILURE" => "correct_invocation",
        "SANDBOX_EXECUTION_FAILURE" => "inspect_runtime_package_or_retry",
        _ => "inspect_diagnostic"
    };

    private static string Bound(string? value, int maximum, string fallback)
    {
        var text = string.IsNullOrWhiteSpace(value) ? fallback : value;
        return text.Length <= maximum ? text : text[..maximum];
    }

    private static string? BoundNullable(string? value, int maximum) =>
        string.IsNullOrWhiteSpace(value) ? null : value!.Length <= maximum ? value : value[..maximum];
}

internal static class Program
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = false };

    public static int Main(string[] args)
    {
        if (args.Length == 10 && args[0] == "--sandbox-probe" && args[1] == "--input" && args[3] == "--pipe" && args[5] == "--nonce" && args[7] == "--channel-key" && args[9].Length > 0)
            return SandboxProbe.Run(args[2], args[4], args[6], args[8], args[9]);
        if (args.Length == 5 && args[0] == "--sandbox-execute" && args[1] == "--input-pipe" && args[3] == "--output-named-pipe")
            return SandboxPipeExecution.Run(args[2], args[4]);
        if (args.Length == 8 && args[0] == "--hostile-pipe-attempt" && args[1] == "--pipe" && args[3] == "--nonce" && args[5] == "--channel-key")
        {
            try { SandboxPipe.Send(args[2], args[4], args[7], Convert.FromBase64String(args[6]), new { forged = true }); return 0; }
            catch (Exception ex) { Console.Error.WriteLine(ex.GetType().FullName + ": " + ex.Message); return 1; }
        }
        if (args.Length == 11 && args[0] == "--hostile-named-pipe-attempt" && args[1] == "--pipe" && args[3] == "--nonce" && args[5] == "--channel-key" && args[7] == "--correlation" && args[9] == "--claim-pid")
        {
            try { SandboxPipe.SendNamedClaimed(args[2], args[4], args[8], Convert.FromBase64String(args[6]), uint.Parse(args[10], System.Globalization.CultureInfo.InvariantCulture), new { forged = true }); return 0; }
            catch (Exception ex) { Console.Error.WriteLine(ex.GetType().FullName + ": " + ex.Message); return 1; }
        }
        if (args.SequenceEqual(new[] { "--self-test" }, StringComparer.Ordinal)) return SelfTest.Run();
        if (args.SequenceEqual(new[] { "--result-reference-self-test" }, StringComparer.Ordinal)) return SelfTest.ResultReferenceScenario();
        if (args.SequenceEqual(new[] { "--repair-scenario" }, StringComparer.Ordinal)) return SelfTest.RepairScenario();
        if (args.Length != 2 || args[0] != "--input")
        {
            Console.Error.WriteLine("Usage: DynamicRevitWorker --input <worker-input.json>");
            return 2;
        }
        try
        {
            var raw = File.ReadAllText(args[1]);
            var input = JsonSerializer.Deserialize<WorkerInput>(raw, Json) ?? throw new InvalidOperationException("Worker input is empty.");
            RuntimeMitigations.EnableMicrosoftSignedNativeImagesOnly();
            var output = WorkerExecutor.Execute(input);
            WorkerDiagnosticProtocol.Prepare(output);
            Console.WriteLine(JsonSerializer.Serialize(output, Json));
            return output.Ok ? 0 : 1;
        }
        catch (Exception ex)
        {
            var output = new WorkerOutput { Ok = false, Diagnostics = new[] { new WorkerDiagnostic { Code = "WORKER_INPUT_FAILURE", Message = ex.Message } } };
            WorkerDiagnosticProtocol.Prepare(output);
            Console.WriteLine(JsonSerializer.Serialize(output, Json));
            return 1;
        }
    }
}

internal sealed class SandboxProbeInput
{
    public string ScratchPath { get; set; } = "";
    public string OutsideReadPath { get; set; } = "";
    public string OutsideEnumeratePath { get; set; } = "";
    public string OutsideWritePath { get; set; } = "";
    public string SecretEnvironmentName { get; set; } = "";
    public int LoopbackPort { get; set; }
}

internal sealed class SandboxProbeResult
{
    public string Action { get; set; } = "";
    public string Expected { get; set; } = "denied";
    public bool Denied { get; set; }
    public string Observed { get; set; } = "";
    public string? ExceptionType { get; set; }
}

internal static class SandboxPipe
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static void Send(string pipeName, string nonce, string correlation, byte[] channelKey, object payload)
    {
        var payloadJson = JsonSerializer.Serialize(payload, Json);
        var payloadBytes = Encoding.UTF8.GetBytes(payloadJson);
        var payloadHash = DynamicWire.Sha256(payloadBytes);
        var canonical = Environment.ProcessId + "\n" + nonce + "\n" + correlation + "\n" + payloadHash;
        using var hmac = new HMACSHA256(channelKey);
        var mac = "hmac-sha256:" + Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        using var pipe = new AnonymousPipeClientStream(PipeDirection.Out, pipeName);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: false) { AutoFlush = true };
        writer.WriteLine(JsonSerializer.Serialize(new { schema = "dynamic-revit-sandbox-message/v0", pid = Environment.ProcessId, nonce, correlation, payloadHash, mac, payloadBase64 = Convert.ToBase64String(payloadBytes) }, Json));
    }
    public static void SendNamed(string pipeName, string nonce, string correlation, byte[] channelKey, object payload)
        => SendNamedClaimed(pipeName, nonce, correlation, channelKey, checked((uint)Environment.ProcessId), payload);
    public static void SendNamedClaimed(string pipeName, string nonce, string correlation, byte[] channelKey, uint claimedPid, object payload)
    {
        var payloadJson = JsonSerializer.Serialize(payload, Json);
        var payloadBytes = Encoding.UTF8.GetBytes(payloadJson);
        var payloadHash = DynamicWire.Sha256(payloadBytes);
        var canonical = claimedPid + "\n" + nonce + "\n" + correlation + "\n" + payloadHash;
        using var hmac = new HMACSHA256(channelKey);
        var mac = "hmac-sha256:" + Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous);
        pipe.Connect(5_000);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: false) { AutoFlush = true };
        writer.WriteLine(JsonSerializer.Serialize(new { schema = "dynamic-revit-sandbox-message/v0", pid = claimedPid, nonce, correlation, payloadHash, mac, payloadBase64 = Convert.ToBase64String(payloadBytes) }, Json));
    }
}

internal static class SandboxPipeExecution
{
    public static int Run(string inputPipeName, string outputPipeName)
    {
        var nonce = "";
        var correlation = "";
        var channelKey = Array.Empty<byte>();
        try
        {
            using var inputPipe = new AnonymousPipeClientStream(PipeDirection.In, inputPipeName);
            using var reader = new StreamReader(inputPipe, Encoding.UTF8, false, 64 * 1024, leaveOpen: false);
            var raw = reader.ReadLine() ?? throw new InvalidOperationException("Worker input channel is empty.");
            if (Encoding.UTF8.GetByteCount(raw) > 4 * 1024 * 1024) throw new InvalidOperationException("Worker input exceeds the 4 MiB limit.");
            using var envelope = JsonDocument.Parse(raw);
            if (envelope.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("Worker input envelope is invalid.");
            nonce = envelope.RootElement.GetProperty("nonce").GetString() ?? throw new InvalidOperationException("Worker nonce is missing.");
            correlation = envelope.RootElement.GetProperty("correlation").GetString() ?? throw new InvalidOperationException("Worker correlation is missing.");
            channelKey = Convert.FromBase64String(envelope.RootElement.GetProperty("channelKeyBase64").GetString() ?? "");
            if (channelKey.Length != 32) throw new InvalidOperationException("Worker channel key must be 256 bits.");
            var request = envelope.RootElement.GetProperty("request").Deserialize<WorkerInput>(Compiler.Json) ?? throw new InvalidOperationException("Worker request is missing.");
            RuntimeMitigations.EnableMicrosoftSignedNativeImagesOnly();
            var output = WorkerExecutor.Execute(request);
            WorkerDiagnosticProtocol.Prepare(output);
            SandboxPipe.SendNamed(outputPipeName, nonce, correlation, channelKey, output);
            return output.Ok ? 0 : 1;
        }
        catch (Exception ex)
        {
            try
            {
                var output = new WorkerOutput { Ok = false, Diagnostics = new[] { new WorkerDiagnostic { Code = "SANDBOX_EXECUTION_FAILURE", Message = ex.Message } } };
                WorkerDiagnosticProtocol.Prepare(output);
                SandboxPipe.SendNamed(outputPipeName, nonce, correlation, channelKey, output);
            }
            catch { }
            return 1;
        }
    }
}

internal static class SandboxProbe
{
    public static int Run(string inputPath, string pipeName, string nonce, string channelKeyBase64, string correlation)
    {
        try
        {
            var input = JsonSerializer.Deserialize<SandboxProbeInput>(File.ReadAllText(inputPath), Compiler.Json) ?? throw new InvalidOperationException("Probe input is empty.");
            File.WriteAllText(Path.Combine(input.ScratchPath, "managed-startup-marker.txt"), "managed worker started");
            _ = DynamicWire.Sha256("preload-sdk");
            using (var preloadHmac = new HMACSHA256(new byte[32])) _ = preloadHmac.ComputeHash(new byte[1]);
            RuntimeMitigations.EnableMicrosoftSignedNativeImagesOnly();
            var results = new List<SandboxProbeResult>
            {
                Attempt("read_arbitrary_profile_file", () => File.ReadAllText(input.OutsideReadPath)),
                Attempt("enumerate_unrelated_user_directory", () => string.Join("\n", Directory.EnumerateFileSystemEntries(input.OutsideEnumeratePath).Take(2))),
                Attempt("write_outside_task_scratch", () => { File.WriteAllText(input.OutsideWritePath, "sandbox escape"); return "write succeeded"; }),
                Attempt("open_loopback_network_connection", () => { using var client = new TcpClient(); var connect = client.ConnectAsync("127.0.0.1", input.LoopbackPort); if (!connect.Wait(2_000)) throw new TimeoutException("network connect did not complete within 2 seconds"); connect.GetAwaiter().GetResult(); return "connect succeeded"; }),
                Attempt("start_cmd_absolute", () => Start(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "cmd.exe"), "/c exit 0")),
                Attempt("start_powershell_absolute", () => Start(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile -Command exit")),
                Attempt("start_notepad_absolute", () => Start(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "notepad.exe"), "")),
                Attempt("start_copied_helper_from_scratch", () => Start(Environment.ProcessPath!, "--self-test")),
                Attempt("load_unsigned_native_image_from_scratch", () => { var copy = Path.Combine(input.ScratchPath, "unsigned-native-probe.dll"); File.Copy(Environment.ProcessPath!, copy, true); var handle = NativeLibrary.Load(copy); NativeLibrary.Free(handle); return "unsigned native image loaded"; }),
                Attempt("read_unrelated_registry", () => Registry.CurrentUser.OpenSubKey(@"Software\Microsoft")?.SubKeyCount.ToString() ?? "missing"),
                ObserveEnvironment(input.SecretEnvironmentName),
                Attempt("write_inside_task_scratch", () => { var path = Path.Combine(input.ScratchPath, "inside-write.txt"); File.WriteAllText(path, "ok"); return File.ReadAllText(path); }, expectedDenied: false)
            };
            SandboxPipe.Send(pipeName, nonce, correlation, Convert.FromBase64String(channelKeyBase64), new { schema = "dynamic-revit-sandbox-probe/v0", results });
            return results.All(result => result.Denied == (result.Expected == "denied")) ? 0 : 1;
        }
        catch (Exception ex)
        {
            try { File.WriteAllText(Path.Combine(Path.GetDirectoryName(inputPath)!, "probe-failure.txt"), ex.ToString()); } catch { }
            return 1;
        }
    }

    private static SandboxProbeResult ObserveEnvironment(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return new SandboxProbeResult { Action = "read_unrelated_environment_secret", Expected = "denied", Denied = string.IsNullOrEmpty(value), Observed = string.IsNullOrEmpty(value) ? "secret absent from allowlisted environment" : "secret exposed" };
    }

    private static SandboxProbeResult Attempt(string action, Func<string> body, bool expectedDenied = true)
    {
        try { return new SandboxProbeResult { Action = action, Expected = expectedDenied ? "denied" : "allowed", Denied = false, Observed = body() }; }
        catch (Exception ex) { return new SandboxProbeResult { Action = action, Expected = expectedDenied ? "denied" : "allowed", Denied = true, Observed = ex.Message, ExceptionType = ex.GetType().FullName }; }
    }

    private static string Start(string fileName, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(fileName, arguments) { UseShellExecute = false, CreateNoWindow = true });
        if (process == null) return "no process";
        process.WaitForExit(1_000);
        if (!process.HasExited) process.Kill(true);
        return "process started pid=" + process.Id;
    }
}

internal static class RuntimeMitigations
{
    [StructLayout(LayoutKind.Sequential)] private struct BinarySignaturePolicy { public uint Flags; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetProcessMitigationPolicy(int policy, ref BinarySignaturePolicy buffer, nuint length);
    public static void EnableMicrosoftSignedNativeImagesOnly()
    {
        var policy = new BinarySignaturePolicy { Flags = 1u };
        if (!SetProcessMitigationPolicy(8, ref policy, (nuint)Marshal.SizeOf<BinarySignaturePolicy>())) throw new InvalidOperationException("Unable to enable the Microsoft-signed-native-image process policy: " + Marshal.GetLastWin32Error());
    }
}

internal static class WorkerExecutor
{
    public static WorkerOutput Execute(WorkerInput request)
    {
        var source = request.Source?.Replace("\r\n", "\n").Replace("\r", "\n") ?? "";
        var output = new WorkerOutput { SourceHash = DynamicWire.Sha256(source), SdkHash = DynamicRevitSdkVersion.ManifestHash };
        try
        {
        if (request.Schema != "dynamic-revit-worker-input/v0") return Fail(output, "WORKER_SCHEMA", "Unsupported worker input schema.");
        if (source.Length is < 1 or > 128_000) return Fail(output, "SOURCE_SIZE", "Source must be between 1 and 128000 characters.");
        if (request.DeadlineMs is < 100 or > 30_000) return Fail(output, "DEADLINE", "Deadline must be 100 through 30000 ms.");
        if (request.Input.OperationBudget is < 1 or > 256 || request.Input.Elements.Count > 5_000) return Fail(output, "INPUT_BUDGET", "Input budget or element count is outside the experimental bounds.");

        var compileClock = Stopwatch.StartNew();
        var admission = StaticAdmission.Check(source);
        if (admission.Length > 0) { output.Diagnostics = admission; return output; }
        var compilation = Compiler.Compile(source);
        output.CompileElapsedMs = compileClock.ElapsedMilliseconds;
        if (compilation.Diagnostics.Length > 0) { output.Diagnostics = compilation.Diagnostics; return output; }
        output.ProgramHash = DynamicWire.Sha256(Convert.ToBase64String(compilation.Assembly!));
        output.CompiledAssemblyHash = DynamicWire.Sha256(compilation.Assembly!);
        var metadata = StaticAdmission.CheckMetadata(compilation.Assembly!);
        if (metadata.Length > 0) { output.Diagnostics = metadata; return output; }

        using var timeout = new CancellationTokenSource(request.DeadlineMs);
        try
        {
            var executionClock = Stopwatch.StartNew();
            // Each replay receives its own JSON-round-tripped immutable snapshot so generated code
            // cannot influence the verification pass by mutating shared DTO instances. The two
            // collectible load contexts run concurrently: deterministic replay costs CPU, but does
            // not normally double wall-clock latency.
            var firstRequest = CloneExecutionRequest(request);
            var secondRequest = CloneExecutionRequest(request);
            var firstTask = Task.Run(() => ExecuteRequest(compilation.Assembly!, firstRequest), timeout.Token);
            var secondTask = Task.Run(() => ExecuteRequest(compilation.Assembly!, secondRequest), timeout.Token);
            var task = Task.WhenAll(firstTask, secondTask);
            if (!task.Wait(request.DeadlineMs)) return Fail(output, "WORKER_DEADLINE", "Program exceeded its worker deadline.");
            var pair = task.GetAwaiter().GetResult();
            output.ExecutionElapsedMs = executionClock.ElapsedMilliseconds;
            NormalizeAndValidate(pair[0], firstRequest);
            NormalizeAndValidate(pair[1], secondRequest);
            var firstIdentity = ExecutionIdentity(pair[0]);
            var secondIdentity = ExecutionIdentity(pair[1]);
            if (!string.Equals(firstIdentity, secondIdentity, StringComparison.Ordinal))
                return Fail(output, "NONDETERMINISTIC_PROGRAM", "Identical immutable inputs produced different execution outputs.");
            output.ExecutionIdentityHash = firstIdentity;
            output.DeterministicReplayVerified = true;
            var result = pair[0];
            var report = result.Legacy?.Report ?? result.ResultReference?.Report ?? result.Core?.Report;
            if (report == null || report.Count > 64 || report.Any(pair => string.IsNullOrWhiteSpace(pair.Key) || pair.Key.Length > 128 || pair.Value == null || pair.Value.Length > 1024)) return Fail(output, "REPORT_BUDGET", "Structured report exceeds the bounded SDK contract.");
            if (result.Legacy != null)
            {
                output.Graph = result.Legacy.Graph;
                output.Logs = result.Legacy.Logs.Take(64).ToArray();
            }
            else if (result.ResultReference != null)
            {
                var reference = result.ResultReference ?? throw new InvalidOperationException("Generated result-reference program returned no result.");
                output.ResultReferenceProgramResult = reference;
                output.Logs = reference.Logs.Take(64).ToArray();
                output.ExecutionStatus = reference.FactRequest == null ? "completed" : "needs_facts";
            }
            else
            {
                var core = result.Core ?? throw new InvalidOperationException("Generated core program returned no result.");
                output.CoreProgramResult = core; output.Logs = core.Logs.Take(64).ToArray();
            }
            output.Report = new Dictionary<string, string>(report, StringComparer.Ordinal);
            if (output.ExecutionStatus == "failed") output.ExecutionStatus = "completed";
            output.Ok = true;
            return output;
        }
        catch (Exception ex)
        {
            var assertion = FindAssertion(ex);
            if (assertion != null)
            {
                output.Diagnostics = new[] { new WorkerDiagnostic
                {
                    Code = "PROGRAM_ASSERTION_FAILED", Message = assertion.Message, StepId = assertion.StepId,
                    AssertionId = assertion.AssertionId, Retryable = true
                } };
                return output;
            }
            var root = ex.GetBaseException();
            return Fail(output, "PROGRAM_EXCEPTION", root.Message);
        }
        }
        finally
        {
            WorkerDiagnosticProtocol.Prepare(output);
        }
    }

    private static DynamicProgramAssertionException? FindAssertion(Exception error)
    {
        if (error is DynamicProgramAssertionException assertion) return assertion;
        if (error is AggregateException aggregate)
            return aggregate.Flatten().InnerExceptions.Select(FindAssertion).FirstOrDefault(value => value != null);
        return error.InnerException == null ? null : FindAssertion(error.InnerException);
    }

    private static WorkerInput CloneExecutionRequest(WorkerInput request) =>
        JsonSerializer.Deserialize<WorkerInput>(JsonSerializer.Serialize(request, Compiler.Json), Compiler.Json)
        ?? throw new InvalidOperationException("Worker execution snapshot could not be cloned.");

    private static ExecutedProgram ExecuteRequest(byte[] assembly, WorkerInput request) => ExecuteAssembly(assembly, request.Input,
        request.ResultReferenceDocumentRevision, request.ResultReferenceSnapshotHash, request.ResultReferenceScopeHash,
        request.BuildingSystemsPages, request.TrustedExternalTargets, request.VerifiedContextRule, request.ContextObservationPages);

    private static void NormalizeAndValidate(ExecutedProgram result, WorkerInput request)
    {
        ValidateStructuredOutput(result);
        if (result.Legacy != null)
        {
            result.Legacy.Graph.InputHash = DynamicWire.InputHash(request.Input);
            result.Legacy.Graph.GraphHash = DynamicWire.GraphHash(result.Legacy.Graph);
            return;
        }
        if (result.ResultReference != null)
        {
            var reference = result.ResultReference;
            if (request.ResultReferenceDocumentRevision == null) throw new InvalidOperationException("Result-reference programs require an exact document revision.");
            if (reference.Schema != DynamicResultReferenceContractV1.ProgramResultSchema || reference.ContractManifestHash != DynamicResultReferenceManifestV1.ManifestHash)
                throw new InvalidOperationException("Result-reference program result contract was substituted.");
            if (reference.FactRequest != null)
            {
                if (reference.Graph.Nodes.Count != 0) throw new InvalidOperationException("A needs-facts result cannot also return executable graph nodes.");
                DynamicExecutionProtocolV1.ValidateFactRequest(reference.FactRequest);
                DynamicExecutionProtocolV1.ValidateTrace(reference.ExecutionTrace, null, reference.FactRequest);
                DynamicExecutionProtocolV1.ValidateTraceFactReferences(reference.ExecutionTrace, request.BuildingSystemsPages);
            }
            else
            {
                DynamicResultReferencePolicyV1.ValidateWorkerOutput(reference.Graph, DynamicWire.InputHash(request.Input), request.Input.Document.ProjectFingerprint,
                    request.Input.Document.SessionId, request.ResultReferenceDocumentRevision.Value);
                DynamicExecutionProtocolV1.ValidateTrace(reference.ExecutionTrace, reference.Graph, null);
                DynamicExecutionProtocolV1.ValidateTraceFactReferences(reference.ExecutionTrace, request.BuildingSystemsPages);
            }
            return;
        }
        var core = result.Core ?? throw new InvalidOperationException("Generated program returned no supported result.");
        if (request.ResultReferenceDocumentRevision == null || request.VerifiedContextRule == null) throw new InvalidOperationException("Core programs require an exact verified context rule and document revision.");
        if (core.Schema != "dynamic-revit-core-program-result/v1") throw new InvalidOperationException("Core program result contract was substituted.");
        DynamicContextRulePolicyV1.ValidateBinding(request.VerifiedContextRule);
        if (core.Graph.InputHash != DynamicWire.InputHash(request.Input) || core.Graph.DocumentFingerprint != request.Input.Document.ProjectFingerprint ||
            core.Graph.DocumentRevision != request.ResultReferenceDocumentRevision.Value || core.Graph.ContextRuleRecordId != request.VerifiedContextRule.RecordId ||
            core.Graph.ContextRuleRecordHash != request.VerifiedContextRule.RecordHash || core.Graph.ContextRuleBindingHash != request.VerifiedContextRule.BindingHash ||
            core.Graph.GraphHash != DynamicOperationGraphV1Admission.GraphHash(core.Graph))
            throw new InvalidOperationException("Core graph is not bound to the exact verified rule and worker input.");
    }

    private static string ExecutionIdentity(ExecutedProgram result)
    {
        var report = result.Legacy?.Report ?? result.ResultReference?.Report ?? result.Core?.Report ??
            throw new InvalidOperationException("Generated program report is missing.");
        var logs = result.Legacy?.Logs ?? result.ResultReference?.Logs ?? result.Core?.Logs ?? Array.Empty<string>();
        var outputIdentity = result.Legacy != null ? "legacy\n" + result.Legacy.Graph.GraphHash :
            result.ResultReference != null ? "result-reference\n" +
                (result.ResultReference.FactRequest?.RequestHash ?? result.ResultReference.Graph.GraphHash) + "\n" +
                result.ResultReference.ExecutionTrace.TraceHash :
            "core\n" + result.Core!.Graph.GraphHash;
        var logIdentity = string.Concat(logs.Select(DynamicWire.Sha256));
        var reportIdentity = string.Concat(report.OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => DynamicWire.Sha256(pair.Key) + DynamicWire.Sha256(pair.Value)));
        return DynamicWire.Sha256(outputIdentity + "\nlogs:" + logIdentity + "\nreport:" + reportIdentity);
    }

    private static void ValidateStructuredOutput(ExecutedProgram result)
    {
        var report = result.Legacy?.Report ?? result.ResultReference?.Report ?? result.Core?.Report ??
            throw new InvalidOperationException("Generated program report is missing.");
        var logs = result.Legacy?.Logs ?? result.ResultReference?.Logs ?? result.Core?.Logs ??
            throw new InvalidOperationException("Generated program logs are missing.");
        if (logs.Count > 64 || logs.Any(value => value == null || value.Length > 512))
            throw new InvalidOperationException("Generated program logs exceed the bounded SDK contract.");
        if (report.Count > 64 || report.Any(pair => string.IsNullOrWhiteSpace(pair.Key) || pair.Key.Length > 128 ||
            pair.Value == null || pair.Value.Length > 1024))
            throw new InvalidOperationException("Structured report exceeds the bounded SDK contract.");
    }

    private sealed class ExecutedProgram
    {
        internal DynamicProgramResult? Legacy;
        internal DynamicResultReferenceProgramResultV1? ResultReference;
        internal DynamicCoreProgramResultV1? Core;
    }

    private static ExecutedProgram ExecuteAssembly(byte[] assembly, DynamicTaskInput input, long? resultReferenceDocumentRevision = null,
        string resultReferenceSnapshotHash = "", string resultReferenceScopeHash = "",
        IEnumerable<DynamicBuildingSystemsEnvelopeV1>? buildingSystemsPages = null,
        IEnumerable<DynamicTrustedElementFactV1>? trustedExternalTargets = null,
        DynamicVerifiedContextRuleV1? verifiedContextRule = null,
        IEnumerable<DynamicObservationEnvelopeV1>? contextObservationPages = null)
    {
        var alc = new AssemblyLoadContext("dynamic-revit-worker", isCollectible: true);
        try
        {
            using var stream = new MemoryStream(assembly);
            var loaded = alc.LoadFromStream(stream);
            var types = loaded.GetTypes().Where(t => !t.IsAbstract && t.IsPublic &&
                (typeof(IDynamicRevitProgram).IsAssignableFrom(t) || typeof(IDynamicResultReferenceRevitProgramV1).IsAssignableFrom(t) || typeof(IDynamicCoreRevitProgramV1).IsAssignableFrom(t))).ToArray();
            if (types.Length != 1) throw new InvalidOperationException("Source must contain exactly one public supported dynamic Revit program implementation.");
            if (new[] { typeof(IDynamicRevitProgram).IsAssignableFrom(types[0]), typeof(IDynamicResultReferenceRevitProgramV1).IsAssignableFrom(types[0]), typeof(IDynamicCoreRevitProgramV1).IsAssignableFrom(types[0]) }.Count(value => value) != 1)
                throw new InvalidOperationException("A generated program may implement only one dynamic Revit program contract.");
            var instance = Activator.CreateInstance(types[0]) ?? throw new InvalidOperationException("Program cannot be constructed.");
            if (instance is IDynamicResultReferenceRevitProgramV1 referenceProgram)
            {
                if (resultReferenceDocumentRevision == null) throw new InvalidOperationException("Result-reference programs require an exact document revision.");
                var context = new DynamicResultReferenceProgramContextV1(input, resultReferenceDocumentRevision.Value,
                    resultReferenceSnapshotHash, resultReferenceScopeHash,
                    buildingSystemsPages ?? Array.Empty<DynamicBuildingSystemsEnvelopeV1>(),
                    trustedExternalTargets ?? Array.Empty<DynamicTrustedElementFactV1>());
                return new ExecutedProgram { ResultReference = referenceProgram.Execute(context) ?? context.Complete() };
            }
            if (instance is IDynamicCoreRevitProgramV1 coreProgram)
            {
                if (resultReferenceDocumentRevision == null || verifiedContextRule == null) throw new InvalidOperationException("Core programs require exact verified context and document revision.");
                var context = new DynamicCoreProgramContextV1(input, resultReferenceDocumentRevision.Value, verifiedContextRule,
                    contextObservationPages ?? Array.Empty<DynamicObservationEnvelopeV1>());
                return new ExecutedProgram { Core = coreProgram.Execute(context) ?? context.Complete() };
            }
            var legacy = (IDynamicRevitProgram)instance; var legacyContext = new DynamicRevitContext(input);
            return new ExecutedProgram { Legacy = legacy.Execute(legacyContext) ?? legacyContext.Complete() };
        }
        finally { alc.Unload(); }
    }

    private static WorkerOutput Fail(WorkerOutput output, string code, string message)
    {
        output.Diagnostics = new[] { new WorkerDiagnostic { Code = code, Message = message } };
        return output;
    }
}

internal static class Compiler
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = false };
    internal sealed class Result { public byte[]? Assembly { get; set; } public WorkerDiagnostic[] Diagnostics { get; set; } = Array.Empty<WorkerDiagnostic>(); }
    public static Result Compile(string source)
    {
        var baseReferences = new[] { typeof(object).Assembly, typeof(Enumerable).Assembly, typeof(IDynamicRevitProgram).Assembly, typeof(Console).Assembly }
            .Select(a => a.Location)
            .Concat(new[] { "netstandard.dll", "System.Runtime.dll", "System.Collections.dll" }.Select(name => Path.Combine(Path.GetDirectoryName(typeof(object).Assembly.Location)!, name)).Where(File.Exists))
            .Concat(((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator)
                .Where(path => string.Equals(Path.GetFileName(path), "netstandard.dll", StringComparison.OrdinalIgnoreCase) || string.Equals(Path.GetFileName(path), "System.Runtime.dll", StringComparison.OrdinalIgnoreCase)))
            .Distinct(StringComparer.OrdinalIgnoreCase);
        var refs = baseReferences.Select(path => MetadataReference.CreateFromFile(path)).Cast<MetadataReference>().ToArray();
        var compilation = CSharpCompilation.Create("DynamicRevitProgram", new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp12)) }, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release, allowUnsafe: false, deterministic: true));
        var semanticDiagnostics = StaticAdmission.CheckSemantic(compilation);
        if (semanticDiagnostics.Length > 0) return new Result { Diagnostics = semanticDiagnostics };
        using var stream = new MemoryStream();
        var emit = compilation.Emit(stream);
        if (!emit.Success)
        {
            return new Result { Diagnostics = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(32).Select(d =>
            {
                var span = d.Location.GetLineSpan();
                return new WorkerDiagnostic
                {
                    Code = d.Id,
                    Message = d.GetMessage(),
                    Phase = "compile",
                    Severity = "error",
                    RepairAction = "edit_source",
                    Retryable = true,
                    Line = span.IsValid ? span.StartLinePosition.Line + 1 : null,
                    Column = span.IsValid ? span.StartLinePosition.Character + 1 : null,
                    EndLine = span.IsValid ? span.EndLinePosition.Line + 1 : null,
                    EndColumn = span.IsValid ? span.EndLinePosition.Character + 1 : null
                };
            }).ToArray() };
        }
        return new Result { Assembly = stream.ToArray() };
    }
}

internal static class StaticAdmission
{
    private static readonly string[] BannedTokens = { "System.IO", "System.Net", "System.Diagnostics", "Microsoft.Win32", "System.Reflection", "DllImport", "unsafe", "extern", "AssemblyLoadContext", "Assembly.Load", "Environment.", "Process.", "Activator.", "Type.GetType", "NativeLibrary", "typeof", "GetType(", "GetMethod(", "GetProperty(", "GetField(", ".Invoke(", ".Assembly", "GetEnvironmentVariable", "dynamic", "Marshal", "GCHandle", "ThreadPool", "System.Threading.Timer", "System.Timers.Timer", "Parallel." };
    public static WorkerDiagnostic[] Check(string source)
    {
        var diagnostics = new List<WorkerDiagnostic>();
        foreach (var token in BannedTokens.Where(token => source.IndexOf(token, StringComparison.Ordinal) >= 0)) diagnostics.Add(new WorkerDiagnostic { Code = "POLICY_SOURCE_FORBIDDEN", Message = "Untrusted worker source may not use " + token + "." });
        if (source.IndexOf("Autodesk.Revit", StringComparison.OrdinalIgnoreCase) >= 0) diagnostics.Add(new WorkerDiagnostic { Code = "REVIT_REFERENCE_FORBIDDEN", Message = "Generated programs may not reference Autodesk.Revit APIs." });
        if (!source.Contains("IDynamicRevitProgram", StringComparison.Ordinal) && !source.Contains("IDynamicResultReferenceRevitProgramV1", StringComparison.Ordinal) && !source.Contains("IDynamicCoreRevitProgramV1", StringComparison.Ordinal))
            diagnostics.Add(new WorkerDiagnostic { Code = "PROGRAM_INTERFACE_REQUIRED", Message = "Program must implement exactly one supported dynamic Revit program interface." });
        return diagnostics.Take(32).ToArray();
    }
    public static WorkerDiagnostic[] CheckSemantic(CSharpCompilation compilation)
    {
        var forbiddenNamespaces = new[] { "System.IO", "System.Net", "System.Diagnostics", "System.Reflection", "System.Runtime.InteropServices", "Microsoft.Win32", "Microsoft.CodeAnalysis" };
        var forbiddenTypes = new[] { "System.Environment", "System.AppDomain", "System.Activator", "System.Type", "System.Threading.Thread", "System.Threading.ThreadPool", "System.Threading.Timer", "System.Timers.Timer", "System.Threading.Tasks.Task", "System.Threading.Tasks.Parallel", "System.Runtime.Loader.AssemblyLoadContext" };
        var diagnostics = new List<WorkerDiagnostic>();
        foreach (var tree in compilation.SyntaxTrees)
        {
            var model = compilation.GetSemanticModel(tree);
            foreach (var node in tree.GetRoot().DescendantNodes().Where(node => node is InvocationExpressionSyntax || node is ObjectCreationExpressionSyntax || node is MemberAccessExpressionSyntax || node is TypeOfExpressionSyntax))
            {
                var symbol = model.GetSymbolInfo(node).Symbol ?? model.GetTypeInfo(node).Type;
                if (symbol == null) continue;
                var type = symbol is ITypeSymbol typeSymbol ? typeSymbol : symbol.ContainingType;
                var typeName = type?.ToDisplayString() ?? "";
                var ns = type?.ContainingNamespace?.ToDisplayString() ?? symbol.ContainingNamespace?.ToDisplayString() ?? "";
                if (forbiddenNamespaces.Any(prefix => ns.Equals(prefix, StringComparison.Ordinal) || ns.StartsWith(prefix + ".", StringComparison.Ordinal)) || forbiddenTypes.Contains(typeName, StringComparer.Ordinal))
                {
                    var line = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                    diagnostics.Add(new WorkerDiagnostic { Code = "POLICY_SYMBOL_FORBIDDEN", Message = "Generated code may not bind to " + (typeName.Length > 0 ? typeName : ns) + ".", Line = line });
                }
            }
        }
        return diagnostics.GroupBy(diagnostic => (diagnostic.Code, diagnostic.Message, diagnostic.Line)).Select(group => group.First()).Take(32).ToArray();
    }
    public static WorkerDiagnostic[] CheckMetadata(byte[] assembly)
    {
        using var pe = new PEReader(new MemoryStream(assembly));
        var reader = pe.GetMetadataReader();
        var diagnostics = new List<WorkerDiagnostic>();
        foreach (var handle in reader.AssemblyReferences)
        {
            var name = reader.GetString(reader.GetAssemblyReference(handle).Name);
            if (!name.StartsWith("System.", StringComparison.Ordinal) && name != "System.Private.CoreLib" && name != "DynamicRevitSdk") diagnostics.Add(new WorkerDiagnostic { Code = "METADATA_REFERENCE_FORBIDDEN", Message = "Unexpected assembly reference: " + name });
        }
        foreach (var typeHandle in reader.TypeDefinitions)
        foreach (var methodHandle in reader.GetTypeDefinition(typeHandle).GetMethods())
            if ((reader.GetMethodDefinition(methodHandle).Attributes & MethodAttributes.PinvokeImpl) != 0) diagnostics.Add(new WorkerDiagnostic { Code = "PINVOKE_FORBIDDEN", Message = "P/Invoke metadata is forbidden." });
        return diagnostics.ToArray();
    }
}

internal static class SelfTest
{
    public static int ResultReferenceScenario()
    {
        const string source = "using System.Collections.Generic; using RevitOperator.DynamicRevitSdk; " +
            "public sealed class X : IDynamicResultReferenceRevitProgramV1 { public DynamicResultReferenceProgramResultV1 Execute(DynamicResultReferenceProgramContextV1 c) { " +
            "var observed = c.BuildingSystemsFacts[0]; var target = c.ExternalTarget(observed.Element.UniqueId); " +
            "c.Report(\"snapshot\", c.ResultReferenceSnapshotHash); c.Report(\"scope\", c.ResultReferenceScopeHash); " +
            "c.Plan.AddOperation(\"copy_element\", new[] { target }, null, new[] { new DynamicResultOutputSpecV1 { OutputSlot=\"copy\", ExpectedCategoryStableId=target.ExpectedCategoryStableId, ExpectedTypeUniqueId=target.ExpectedTypeUniqueId } }, new Dictionary<string,string> { [\"transform\"]=\"identity\" }); return c.Complete(); } }";
        var fingerprint = DynamicWire.Sha256("worker-self-test-document"); var snapshot = DynamicWire.Sha256("worker-self-test-snapshot");
        var page = BuildingSystemsPage(fingerprint, snapshot); var trusted = TrustedExternal(fingerprint);
        var input = new DynamicTaskInput { Document = new DynamicDocumentDto { ProjectFingerprint = fingerprint, SessionId = "worker-session" } };
        var request = new WorkerInput { Source = source, Input = input, ResultReferenceDocumentRevision = 9,
            ResultReferenceSnapshotHash = page.SnapshotHash, ResultReferenceScopeHash = page.ScopeHash,
            BuildingSystemsPages = new[] { page }, TrustedExternalTargets = new[] { trusted } };
        var output = WorkerExecutor.Execute(request);
        var graph = output.ResultReferenceProgramResult?.Graph;
        using var wire = JsonDocument.Parse(JsonSerializer.Serialize(output, Compiler.Json));
        var wireResult = wire.RootElement.GetProperty("resultReferenceProgramResult");
        var wrongSnapshot = WorkerExecutor.Execute(new WorkerInput { Source = source, Input = input, ResultReferenceDocumentRevision = 9,
            ResultReferenceSnapshotHash = DynamicWire.Sha256("wrong"), ResultReferenceScopeHash = page.ScopeHash,
            BuildingSystemsPages = new[] { page }, TrustedExternalTargets = new[] { trusted } });
        var foreignTarget = TrustedExternal(DynamicWire.Sha256("foreign-document"));
        var wrongTarget = WorkerExecutor.Execute(new WorkerInput { Source = source, Input = input, ResultReferenceDocumentRevision = 9,
            ResultReferenceSnapshotHash = page.SnapshotHash, ResultReferenceScopeHash = page.ScopeHash,
            BuildingSystemsPages = new[] { page }, TrustedExternalTargets = new[] { foreignTarget } });
        var ok = output.Ok && !wrongSnapshot.Ok && !wrongTarget.Ok && output.Graph == null && graph?.Nodes.Count == 1 &&
            graph.Nodes[0].ExternalTargets.Single().TargetUniqueId == trusted.UniqueId &&
            graph.GraphHash == DynamicResultReferencePolicyV1.GraphHash(graph) &&
            wireResult.GetProperty("schema").GetString() == DynamicResultReferenceContractV1.ProgramResultSchema &&
            wireResult.GetProperty("contractManifestHash").GetString() == DynamicResultReferenceManifestV1.ManifestHash &&
            wireResult.GetProperty("graph").GetProperty("graphHash").GetString() == graph.GraphHash;
        Console.WriteLine(JsonSerializer.Serialize(new { schema = "dynamic-revit-worker-result-reference-self-test/v1", ok, graphHash = graph?.GraphHash, diagnostics = output.Diagnostics }, Compiler.Json));
        return ok ? 0 : 1;
    }

    private static DynamicBuildingSystemsEnvelopeV1 BuildingSystemsPage(string fingerprint, string snapshot)
    {
        var type = new DynamicStableReferenceV1 { Kind = "type", StableId = "revit-element:type", UniqueId = "type", ElementId = 2 };
        var family = new DynamicStableReferenceV1 { Kind = "family", StableId = "revit-element:family", UniqueId = "family", ElementId = 3 };
        var element = new DynamicStableReferenceV1 { Kind = "element", StableId = "revit-element:equipment", UniqueId = "equipment", ElementId = 1 };
        var origin = new DynamicPointV1 { X = 1, Y = 2, Z = 3 };
        var transform = new DynamicTransformV1 { Origin = origin, BasisX = new DynamicPointV1 { X = 1 }, BasisY = new DynamicPointV1 { Y = 1 }, BasisZ = new DynamicPointV1 { Z = 1 } };
        var fact = new DynamicBuildingSystemsFactV1 { Kind = "equipment", Element = element, Family = family, Type = type, Location = origin, Orientation = transform,
            Asset = new DynamicBuildingAssetFactV1 { AssetClass = "equipment", Location = origin, Orientation = transform, Family = family, Type = type } };
        return DynamicBuildingSystemsObservationPolicyV1.BuildPage(new DynamicBuildingSystemsSelectorV1 { PageSize = 1 }, fingerprint, "worker-session", 9, snapshot, new[] { fact });
    }

    private static DynamicTrustedElementFactV1 TrustedExternal(string fingerprint) => new()
    {
        UniqueId = "equipment", ElementId = 1, DocumentFingerprint = fingerprint, CategoryStableId = "category:none", TypeUniqueId = "type",
        StateHash = DynamicWire.Sha256("worker-self-test-state"), Exists = true, Verified = true, Visible = true
    };

    public static int Run()
    {
        const string sdk = "using RevitOperator.DynamicRevitSdk; ";
        var harmful = new[]
        {
            sdk + "using System.IO; public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { File.ReadAllText(\"x\"); return c.Complete(); } }",
            sdk + "using N = System.Net; public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { var x = new N.Http.HttpClient(); return c.Complete(); } }",
            sdk + "public unsafe class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { return c.Complete(); } }",
            sdk + "public class X : IDynamicRevitProgram { [System.Runtime.InteropServices.DllImport(\"kernel32\")] static extern int GetTickCount(); public DynamicProgramResult Execute(DynamicRevitContext c) { GetTickCount(); return c.Complete(); } }",
            sdk + "using E = System.Environment; public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { var x = E.GetEnvironmentVariable(\"SECRET\"); return c.Complete(); } }",
            sdk + "public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { var x = typeof(object).Assembly; return c.Complete(); } }",
            sdk + "public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { dynamic x = 1; return c.Complete(); } }",
            sdk + "using P = System.Diagnostics.Process; public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { P.Start(\"cmd\"); return c.Complete(); } }",
            sdk + "using R = Microsoft.Win32.Registry; public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { var x = R.CurrentUser; return c.Complete(); } }",
            sdk + "using A = System.Reflection.Assembly; public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { A.Load(new byte[0]); return c.Complete(); } }",
            sdk + "using L = System.Runtime.InteropServices.NativeLibrary; public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { L.Load(\"x\"); return c.Complete(); } }",
            sdk + "using T = System.Threading.Thread; public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { new T(() => {}).Start(); return c.Complete(); } }",
            sdk + "public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { var t = System.Type.GetType(\"System.IO.File\"); return c.Complete(); } }",
            sdk + "public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { var x = System.\\u0049O.File.ReadAllText(\"x\"); return c.Complete(); } }",
            sdk + "using D = System.AppDomain; public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { var x = D.CurrentDomain.GetAssemblies(); return c.Complete(); } }"
            ,sdk + "public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { System.Threading.ThreadPool.QueueUserWorkItem(_ => {}); return c.Complete(); } }"
            ,sdk + "public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { var x = new System.Threading.Timer(_ => {}); return c.Complete(); } }"
            ,sdk + "public class X : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { System.Threading.Tasks.Parallel.For(0, 1, _ => {}); return c.Complete(); } }"
        };
        var failures = harmful.Where(source => WorkerExecutor.Execute(new WorkerInput { Source = source, Input = new DynamicTaskInput() }).Ok).ToArray();
        Console.WriteLine(JsonSerializer.Serialize(new { schema = "dynamic-revit-worker-security-self-test/v0", ok = failures.Length == 0, cases = harmful.Length, failures = failures.Length }, Compiler.Json));
        return failures.Length == 0 ? 0 : 1;
    }

    public static int RepairScenario()
    {
        const string prefix = "using System.Linq; using RevitOperator.DynamicRevitSdk; ";
        var first = prefix + "public sealed class First : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { foreach (var e in c.Elements.Where(e => e.WritableParameters.Contains(\"Comments\"))) c.Plan.SetParameter(e, \"Comments\", \"Reviewed\"); return c.Complete(); } }";
        var repaired = prefix + "public sealed class Repaired : IDynamicRevitProgram { public DynamicProgramResult Execute(DynamicRevitContext c) { foreach (var e in c.Elements.Where(e => !e.IsPinned && e.WritableParameters.Contains(\"Comments\"))) c.Plan.SetParameter(e, \"Comments\", \"Reviewed\"); return c.Complete(); } }";
        var input = new DynamicTaskInput
        {
            OperationBudget = 8,
            Elements = new[]
            {
                new DynamicElementDto { UniqueId = "pinned-target", IsPinned = true, WritableParameters = new[] { "Comments" } },
                new DynamicElementDto { UniqueId = "eligible-target", IsPinned = false, WritableParameters = new[] { "Comments" } }
            }
        };
        var initial = WorkerExecutor.Execute(new WorkerInput { Source = first, Input = input });
        var fixedOutput = WorkerExecutor.Execute(new WorkerInput { Source = repaired, Input = input });
        var ok = initial.Ok && fixedOutput.Ok && initial.ProgramHash != fixedOutput.ProgramHash && initial.Graph?.Operations.Count == 2 && fixedOutput.Graph?.Operations.Count == 1 && fixedOutput.Graph.Operations[0].TargetUniqueId == "eligible-target";
        Console.WriteLine(JsonSerializer.Serialize(new { schema = "dynamic-revit-worker-repair-scenario/v0", ok, first_program_hash = initial.ProgramHash, repaired_program_hash = fixedOutput.ProgramHash, first_targets = initial.Graph?.Operations.Select(o => o.TargetUniqueId).ToArray(), repaired_targets = fixedOutput.Graph?.Operations.Select(o => o.TargetUniqueId).ToArray(), first_diagnostics = initial.Diagnostics, repaired_diagnostics = fixedOutput.Diagnostics }, Compiler.Json));
        return ok ? 0 : 1;
    }
}

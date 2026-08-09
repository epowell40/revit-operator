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
}

internal sealed class WorkerOutput
{
    public string Schema { get; set; } = "dynamic-revit-worker-output/v0";
    public bool Ok { get; set; }
    public string SourceHash { get; set; } = "";
    public string? ProgramHash { get; set; }
    public string SdkHash { get; set; } = "";
    public DynamicOperationGraph? Graph { get; set; }
    public DynamicResultReferenceProgramResultV1? ResultReferenceProgramResult { get; set; }
    public string[] Logs { get; set; } = Array.Empty<string>();
    public IReadOnlyDictionary<string, string> Report { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
    public WorkerDiagnostic[] Diagnostics { get; set; } = Array.Empty<WorkerDiagnostic>();
}

internal sealed class WorkerDiagnostic { public string Code { get; set; } = ""; public string Message { get; set; } = ""; public int? Line { get; set; } }

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
            var output = WorkerExecutor.Execute(input);
            Console.WriteLine(JsonSerializer.Serialize(output, Json));
            return output.Ok ? 0 : 1;
        }
        catch (Exception ex)
        {
            Console.WriteLine(JsonSerializer.Serialize(new WorkerOutput { Ok = false, Diagnostics = new[] { new WorkerDiagnostic { Code = "WORKER_INPUT_FAILURE", Message = ex.Message } } }, Json));
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
    private sealed class InputEnvelope { public string Nonce { get; set; } = ""; public string Correlation { get; set; } = ""; public string ChannelKeyBase64 { get; set; } = ""; public WorkerInput Request { get; set; } = new(); }
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
            var envelope = JsonSerializer.Deserialize<InputEnvelope>(raw, Compiler.Json) ?? throw new InvalidOperationException("Worker input envelope is empty.");
            nonce = envelope.Nonce;
            correlation = envelope.Correlation;
            channelKey = Convert.FromBase64String(envelope.ChannelKeyBase64);
            if (channelKey.Length != 32) throw new InvalidOperationException("Worker channel key must be 256 bits.");
            var output = WorkerExecutor.Execute(envelope.Request);
            SandboxPipe.SendNamed(outputPipeName, nonce, correlation, channelKey, output);
            return output.Ok ? 0 : 1;
        }
        catch (Exception ex)
        {
            try { SandboxPipe.SendNamed(outputPipeName, nonce, correlation, channelKey, new WorkerOutput { Ok = false, Diagnostics = new[] { new WorkerDiagnostic { Code = "SANDBOX_EXECUTION_FAILURE", Message = ex.Message } } }); } catch { }
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
        if (request.Schema != "dynamic-revit-worker-input/v0") return Fail(output, "WORKER_SCHEMA", "Unsupported worker input schema.");
        if (source.Length is < 1 or > 128_000) return Fail(output, "SOURCE_SIZE", "Source must be between 1 and 128000 characters.");
        if (request.DeadlineMs is < 100 or > 30_000) return Fail(output, "DEADLINE", "Deadline must be 100 through 30000 ms.");
        if (request.Input.OperationBudget is < 1 or > 256 || request.Input.Elements.Count > 5_000) return Fail(output, "INPUT_BUDGET", "Input budget or element count is outside the experimental bounds.");

        var admission = StaticAdmission.Check(source);
        if (admission.Length > 0) { output.Diagnostics = admission; return output; }
        var compilation = Compiler.Compile(source);
        if (compilation.Diagnostics.Length > 0) { output.Diagnostics = compilation.Diagnostics; return output; }
        output.ProgramHash = DynamicWire.Sha256(Convert.ToBase64String(compilation.Assembly!));
        var metadata = StaticAdmission.CheckMetadata(compilation.Assembly!);
        if (metadata.Length > 0) { output.Diagnostics = metadata; return output; }

        RuntimeMitigations.EnableMicrosoftSignedNativeImagesOnly();
        using var timeout = new CancellationTokenSource(request.DeadlineMs);
        try
        {
            var task = Task.Run(() => ExecuteAssembly(compilation.Assembly!, request.Input, request.ResultReferenceDocumentRevision), timeout.Token);
            if (!task.Wait(request.DeadlineMs)) return Fail(output, "WORKER_DEADLINE", "Program exceeded its worker deadline.");
            var result = task.GetAwaiter().GetResult();
            var report = result.Legacy?.Report ?? result.ResultReference?.Report;
            if (report == null || report.Count > 64 || report.Any(pair => string.IsNullOrWhiteSpace(pair.Key) || pair.Key.Length > 128 || pair.Value == null || pair.Value.Length > 1024)) return Fail(output, "REPORT_BUDGET", "Structured report exceeds the bounded SDK contract.");
            if (result.Legacy != null)
            {
                result.Legacy.Graph.InputHash = DynamicWire.InputHash(request.Input);
                result.Legacy.Graph.GraphHash = DynamicWire.GraphHash(result.Legacy.Graph);
                output.Graph = result.Legacy.Graph;
                output.Logs = result.Legacy.Logs.Take(64).ToArray();
            }
            else
            {
                var reference = result.ResultReference ?? throw new InvalidOperationException("Generated result-reference program returned no result.");
                if (request.ResultReferenceDocumentRevision == null) return Fail(output, "RESULT_REFERENCE_REVISION", "Result-reference programs require an exact document revision.");
                DynamicResultReferencePolicyV1.ValidateWorkerOutput(reference.Graph, DynamicWire.InputHash(request.Input), request.Input.Document.ProjectFingerprint,
                    request.Input.Document.SessionId, request.ResultReferenceDocumentRevision.Value);
                if (reference.Schema != DynamicResultReferenceContractV1.ProgramResultSchema || reference.ContractManifestHash != DynamicResultReferenceManifestV1.ManifestHash)
                    return Fail(output, "RESULT_REFERENCE_CONTRACT", "Result-reference program result contract was substituted.");
                output.ResultReferenceProgramResult = reference;
                output.Logs = reference.Logs.Take(64).ToArray();
            }
            output.Report = new Dictionary<string, string>(report, StringComparer.Ordinal);
            output.Ok = true;
            return output;
        }
        catch (Exception ex)
        {
            return Fail(output, "PROGRAM_EXCEPTION", ex.GetBaseException().Message);
        }
    }

    private sealed class ExecutedProgram
    {
        internal DynamicProgramResult? Legacy;
        internal DynamicResultReferenceProgramResultV1? ResultReference;
    }

    private static ExecutedProgram ExecuteAssembly(byte[] assembly, DynamicTaskInput input, long? resultReferenceDocumentRevision = null)
    {
        var alc = new AssemblyLoadContext("dynamic-revit-worker", isCollectible: true);
        try
        {
            using var stream = new MemoryStream(assembly);
            var loaded = alc.LoadFromStream(stream);
            var types = loaded.GetTypes().Where(t => !t.IsAbstract && t.IsPublic &&
                (typeof(IDynamicRevitProgram).IsAssignableFrom(t) || typeof(IDynamicResultReferenceRevitProgramV1).IsAssignableFrom(t))).ToArray();
            if (types.Length != 1) throw new InvalidOperationException("Source must contain exactly one public supported dynamic Revit program implementation.");
            if (typeof(IDynamicRevitProgram).IsAssignableFrom(types[0]) && typeof(IDynamicResultReferenceRevitProgramV1).IsAssignableFrom(types[0]))
                throw new InvalidOperationException("A generated program may implement only one dynamic Revit program contract.");
            var instance = Activator.CreateInstance(types[0]) ?? throw new InvalidOperationException("Program cannot be constructed.");
            if (instance is IDynamicResultReferenceRevitProgramV1 referenceProgram)
            {
                if (resultReferenceDocumentRevision == null) throw new InvalidOperationException("Result-reference programs require an exact document revision.");
                var context = new DynamicResultReferenceProgramContextV1(input, resultReferenceDocumentRevision.Value);
                return new ExecutedProgram { ResultReference = referenceProgram.Execute(context) ?? context.Complete() };
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
            return new Result { Diagnostics = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(32).Select(d => new WorkerDiagnostic { Code = d.Id, Message = d.GetMessage(), Line = d.Location.GetLineSpan().StartLinePosition.Line + 1 }).ToArray() };
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
        if (!source.Contains("IDynamicRevitProgram", StringComparison.Ordinal) && !source.Contains("IDynamicResultReferenceRevitProgramV1", StringComparison.Ordinal))
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
            "var a = c.Plan.AddOperation(\"create_family_instance\", null, null, new[] { new DynamicResultOutputSpecV1 { OutputSlot=\"primary\", ExpectedCategoryStableId=\"category:generic-model\", ExpectedTypeUniqueId=\"type:generic-a\" } }, new Dictionary<string,string> { [\"family_type_identity\"]=\"type:generic-a\", [\"placement\"]=\"0,0,0\" }); " +
            "c.Plan.AddOperation(\"copy_element\", null, new[] { a.Reference(\"primary\") }, new[] { new DynamicResultOutputSpecV1 { OutputSlot=\"copy\", ExpectedCategoryStableId=\"category:generic-model\", ExpectedTypeUniqueId=\"type:generic-a\" } }, new Dictionary<string,string> { [\"transform\"]=\"identity\" }); return c.Complete(); } }";
        var input = new DynamicTaskInput { Document = new DynamicDocumentDto { ProjectFingerprint = DynamicWire.Sha256("worker-self-test-document"), SessionId = "worker-session" } };
        var output = WorkerExecutor.Execute(new WorkerInput { Source = source, Input = input, ResultReferenceDocumentRevision = 9 });
        var graph = output.ResultReferenceProgramResult?.Graph;
        using var wire = JsonDocument.Parse(JsonSerializer.Serialize(output, Compiler.Json));
        var wireResult = wire.RootElement.GetProperty("resultReferenceProgramResult");
        var ok = output.Ok && output.Graph == null && graph?.Nodes.Count == 2 &&
            graph.Nodes[1].ResultReferences.Single().ResultId == graph.Nodes[0].Outputs.Single().ResultId &&
            graph.GraphHash == DynamicResultReferencePolicyV1.GraphHash(graph) &&
            wireResult.GetProperty("schema").GetString() == DynamicResultReferenceContractV1.ProgramResultSchema &&
            wireResult.GetProperty("contractManifestHash").GetString() == DynamicResultReferenceManifestV1.ManifestHash &&
            wireResult.GetProperty("graph").GetProperty("graphHash").GetString() == graph.GraphHash;
        Console.WriteLine(JsonSerializer.Serialize(new { schema = "dynamic-revit-worker-result-reference-self-test/v1", ok, graphHash = graph?.GraphHash, diagnostics = output.Diagnostics }, Compiler.Json));
        return ok ? 0 : 1;
    }

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

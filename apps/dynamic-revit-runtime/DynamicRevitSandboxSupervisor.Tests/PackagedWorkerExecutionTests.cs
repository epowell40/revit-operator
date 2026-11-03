using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

// Explicit packaged-runtime integration tests: no model, provider or native host.
// Run with OPERATOR_TEST_PACKAGED_WORKER pointing to an exact published worker.
public sealed class PackagedWorkerFactAttribute : FactAttribute
{
    public PackagedWorkerFactAttribute()
    {
        if (!OperatingSystem.IsWindows()) Skip = "Windows LPAC required.";
        else if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OPERATOR_TEST_PACKAGED_WORKER")))
            Skip = "Set OPERATOR_TEST_PACKAGED_WORKER to run real packaged-worker integration.";
    }
}

public sealed class PackagedWorkerExecutionTests
{
    [PackagedWorkerFact]
    public Task TwoThousandRowReadReturnsTwentyMatchesAndExitsCleanly() => Run(false);

    [PackagedWorkerFact]
    public Task GeneratedExceptionReturnsAuthenticatedDiagnosticAndExitsWithFailure() => Run(true);

    [PackagedWorkerFact]
    public Task NativeProgramCompilesThroughPinnedImageAndAuthenticatedPipeWithoutExecuting() => Run(false, true);

    [PackagedWorkerFact]
    public Task NativeProgramCompilesAgainstInstalledNet48RuntimeReferencesWithExactStagedIdentity() => Run(false, true, true);

    private static async Task Run(bool throwFromProgram, bool nativeCompile = false, bool installedFramework = false)
    {
        var evidenceRoot = Path.Combine(Path.GetTempPath(), "DynamicWorkerTests", Guid.NewGuid().ToString("N"), new string('a', 80), new string('b', 80));
        string? taskRoot = null;
        try
        {
            var nativeReferences = nativeCompile ? new[] { "mscorlib", "System", "System.Core", "RevitAPI" }.Select(name =>
            {
                var file=name=="RevitAPI"?NativeProgramCompilerTests.RevitApi:Path.Combine(NativeProgramCompilerTests.Framework,name+".dll");
                if(installedFramework && name!="RevitAPI")
                    file=name=="mscorlib"
                        ?Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"Microsoft.NET","Framework64","v4.0.30319","mscorlib.dll")
                        :Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"Microsoft.NET","assembly","GAC_MSIL",name,"v4.0_4.0.0.0__b77a5c561934e089",name+".dll");
                return new NativeReferenceSource(name,file,DynamicWire.Sha256(File.ReadAllBytes(file)));
            }).ToArray() : null;
            using var workspace = TaskWorkspace.Create(Path.Combine(evidenceRoot, "evidence.json"), "tests",
                Environment.GetEnvironmentVariable("OPERATOR_TEST_PACKAGED_WORKER")!, nativeReferences);
            if(nativeCompile)
            {
                Assert.Equal(4,workspace.RuntimeImage.Files.Count(f=>f.RelativePath.Replace('\\','/').StartsWith("native-target/2024/",StringComparison.Ordinal)));
                var installedWorker=Environment.GetEnvironmentVariable("OPERATOR_TEST_PACKAGED_WORKER")!;
                Assert.Equal(DynamicRuntimePackageDirectoryIdentity.ComputeWithNativeTarget2024(installedWorker,
                    DynamicRuntimePackageDirectoryIdentity.Compute(installedWorker),nativeReferences!.ToDictionary(r=>r.Name,r=>r.SourcePath)),workspace.RuntimeImage.Identity);
            }
            taskRoot = workspace.Root;
            using var profile = WindowsSandboxProfile.Create(true);
            profile.GrantTaskLayout(workspace.Root, workspace.RuntimeDirectory, workspace.ScratchDirectory);
            using var input = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
            var name = "RevitOperator.DynamicRuntime.Test." + Guid.NewGuid().ToString("N");
            using var output = profile.CreateAuthenticatedPipe(name);
            var handle = input.GetClientHandleAsString();
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var correlation = Guid.NewGuid().ToString("N");
            var key = RandomNumberGenerator.GetBytes(32);
            workspace.RuntimeImage.VerifyBeforeLaunch();
            using var worker = profile.Launch(Path.Combine(workspace.RuntimeDirectory, "DynamicRevitWorker.exe"),
                "--sandbox-execute --input-pipe " + handle + " --output-named-pipe " + name,
                workspace.ScratchDirectory, 256, TimeSpan.FromSeconds(30), new[] { new IntPtr(long.Parse(handle)) });
            input.DisposeLocalCopyOfClientHandle();
            var source = """
                using System; using System.Linq; using RevitOperator.DynamicRevitSdk;
                public sealed class CustomRead : IDynamicRevitProgram {
                  public DynamicProgramResult Execute(DynamicRevitContext c) {
                    var matches = c.Elements.Where(e => e.Parameters.TryGetValue("Name", out var name) && string.Equals(name, "Toilet", StringComparison.OrdinalIgnoreCase)).ToArray();
                    c.Report("Inspected", c.Elements.Count.ToString()); c.Report("Matched", matches.Length.ToString());
                    c.Report("FirstId", matches.OrderBy(e => e.ElementId).First().UniqueId); return c.Complete();
                  }
                }
                """;
            if (throwFromProgram) source = source.Replace("return c.Complete();", "throw new System.InvalidOperationException(\"canary-failure\");");
            if (nativeCompile) source="using System; using Autodesk.Revit.DB; public static class NativeTask { public static string Execute(Document doc) { throw new InvalidOperationException(\"NATIVE_SOURCE_MUST_NOT_RUN_HERE\"); } }";
            var rows = Enumerable.Range(1, 2000).Select(i => new DynamicElementDto { ElementId = i, UniqueId = "room-" + i, Category = "Rooms",
                Parameters = new Dictionary<string, string?> { ["Name"] = i % 100 == 0 ? "Toilet" : "Office" } }).ToArray();
            using var writer = Program.CreateWorkerInputWriter(input);
            object request = nativeCompile ? new { schema="dynamic-revit-worker-input/v0",source,deadlineMs=10000,
                nativeCompilation=new {entryType="NativeTask",mode="write",revitYear=2024,references=nativeReferences!.Select(r=>new {name=r.Name,version=System.Reflection.AssemblyName.GetAssemblyName(r.SourcePath).Version!.ToString(),sha256=r.Sha256}).ToArray()} }
                : new { schema = "dynamic-revit-worker-input/v0", source, input = new DynamicTaskInput { Elements = rows, OperationBudget = 1 }, deadlineMs = 10000 };
            await writer.WriteLineAsync(JsonSerializer.Serialize(new { turnIndex = 0, nonce, correlation, channelKeyBase64 = Convert.ToBase64String(key),request },
                new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase })).WaitAsync(TimeSpan.FromSeconds(15));
            await output.WaitForConnectionAsync().WaitAsync(TimeSpan.FromSeconds(15));
            Assert.True(Native.GetNamedPipeClientProcessId(output.SafePipeHandle, out var pid));
            Assert.Equal(worker.ProcessId, pid);
            using var reader = new StreamReader(output, Encoding.UTF8);
            var raw = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.NotNull(raw); Assert.True(raw.Length < 4 * 1024 * 1024);
            using var envelope = JsonDocument.Parse(raw); var e = envelope.RootElement;
            var bytes = Convert.FromBase64String(e.GetProperty("payloadBase64").GetString()!);
            var hash = DynamicWire.Sha256(bytes);
            var mac = "hmac-sha256:" + Convert.ToHexString(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(pid + "\n" + nonce + "\n" + correlation + "\n" + hash))).ToLowerInvariant();
            Assert.Equal(pid, e.GetProperty("pid").GetUInt32());
            Assert.Equal(nonce, e.GetProperty("nonce").GetString());
            Assert.Equal(correlation, e.GetProperty("correlation").GetString());
            Assert.Equal(hash, e.GetProperty("payloadHash").GetString());
            Assert.Equal(mac, e.GetProperty("mac").GetString());
            using var payload = JsonDocument.Parse(bytes); var result = payload.RootElement;
            var receiptRoot=Environment.GetEnvironmentVariable("OPERATOR_TEST_WORKER_RECEIPTS");
            if(!string.IsNullOrWhiteSpace(receiptRoot))
            {
                Directory.CreateDirectory(receiptRoot);
                File.WriteAllText(Path.Combine(receiptRoot,(nativeCompile?"native-compile":throwFromProgram?"exception":"read")+"-"+correlation+".json"),raw);
            }
            Assert.True(result.GetProperty("ok").GetBoolean()==!throwFromProgram,result.GetProperty("diagnostics").GetRawText());
            if(nativeCompile)
            {
                Assert.Equal("compiled_native",result.GetProperty("executionStatus").GetString());
                Assert.False(result.GetProperty("deterministicReplayVerified").GetBoolean());
                Assert.Equal(0,result.GetProperty("executionElapsedMs").GetInt64());
                var artifact=result.GetProperty("nativeProgramArtifact").Deserialize<DynamicNativeProgramArtifactV1>(new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase})!;
                Assert.Equal(DynamicWire.Sha256(source),artifact.SourceHash);Assert.False(artifact.ExecutionAuthorized);
                Assert.NotEmpty(DynamicNativeProgramArtifactPolicyV1.ArtifactHash(artifact));
                Assert.Equal(JsonValueKind.Null,result.GetProperty("graph").ValueKind);
                workspace.RuntimeImage.VerifyBeforeLaunch();
            }
            else if (throwFromProgram) Assert.Contains("canary-failure", result.GetProperty("diagnostics").GetRawText());
            else
            {
                var report = result.GetProperty("report");
                Assert.Equal("2000", report.GetProperty("Inspected").GetString());
                Assert.Equal("20", report.GetProperty("Matched").GetString());
                Assert.Equal("room-100", report.GetProperty("FirstId").GetString());
                Assert.Empty(result.GetProperty("graph").GetProperty("operations").EnumerateArray());
            }
            writer.Dispose(); input.Close();
            Assert.True(worker.Wait(TimeSpan.FromSeconds(5)), "Worker must exit after publishing its result.");
            Assert.Equal(throwFromProgram ? 1 : 0, worker.ExitCode);
        }
        finally
        {
            if (taskRoot != null && Directory.Exists(taskRoot)) TaskRetention.SafeDeleteTree(taskRoot);
            if (Directory.Exists(evidenceRoot)) TaskRetention.SafeDeleteTree(evidenceRoot);
        }
    }
}

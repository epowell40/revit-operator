using System.Reflection;
using System.Text.Json;
using RevitOperator.DynamicRevitSdk;
using RevitOperator.DynamicRevitWorker;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

public sealed class NativeCompileTransportTests
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly string[] Names = { "mscorlib", "System", "System.Core", "RevitAPI" };
    private static readonly string Source = "using System; using Autodesk.Revit.DB; public static class NativeTask { public static string Execute(Document doc) { throw new InvalidOperationException(\"MUST_NOT_EXECUTE_IN_WORKER\"); } }";

    private static WorkerInput Request(string mode = "write", bool cache = false, int year = 2024)
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "native-target", "2024");
        Directory.CreateDirectory(dir);
        var references = Names.Select(name =>
        {
            var original = name == "RevitAPI" ? NativeProgramCompilerTests.RevitApi : Path.Combine(NativeProgramCompilerTests.Framework, name + ".dll");
            var bytes = File.ReadAllBytes(original); var target = Path.Combine(dir, name + ".dll");
            if (!File.Exists(target)) { File.WriteAllBytes(target, bytes); File.SetAttributes(target, File.GetAttributes(target) | FileAttributes.ReadOnly); }
            Assert.Equal(DynamicWire.Sha256(bytes), DynamicWire.Sha256(File.ReadAllBytes(target)));
            return new { name, version = AssemblyName.GetAssemblyName(original).Version!.ToString(), sha256 = DynamicWire.Sha256(bytes) };
        }).ToArray();
        return JsonSerializer.Deserialize<WorkerInput>(JsonSerializer.Serialize(new
        {
            source = Source, nativeCompilation = new { entryType = "NativeTask", mode, revitYear = year, references },
            cachedAssemblyBase64 = cache ? Convert.ToBase64String(new byte[] { 1, 2 }) : null
        }, Json), Json)!;
    }

    [NativeCompileFact]
    public void NativeCompileRequestIsCompilationOnlyEvenIfProgramThrows()
    {
        var output = WorkerExecutor.Execute(Request());
        Assert.True(output.Ok, string.Join(";", output.Diagnostics.Select(d => d.Code + ":" + d.Message)));
        Assert.Equal("compiled_native", output.ExecutionStatus);
        Assert.False(output.DeterministicReplayVerified); Assert.Equal(0, output.ExecutionElapsedMs);
        Assert.Null(output.Graph); Assert.Null(output.CoreProgramResult); Assert.Null(output.ResultReferenceProgramResult);
        var wire = JsonSerializer.SerializeToElement(output, Json);
        var artifact = wire.GetProperty("nativeProgramArtifact").Deserialize<DynamicNativeProgramArtifactV1>(Json)!;
        Assert.False(artifact.ExecutionAuthorized);
        Assert.Equal(DynamicWire.Sha256(Source), artifact.SourceHash);
        Assert.Equal(DynamicWire.Sha256(artifact.Assembly), artifact.AssemblyHash);
        Assert.Equal(4, artifact.References.Count);
        Assert.True(JsonSerializer.SerializeToUtf8Bytes(output, Json).Length < 4 * 1024 * 1024);
    }

    [NativeCompileFact]
    public void NativeCompilationCannotReuseLegacyAssemblyCacheOrWrongTarget()
    {
        foreach(var request in new[] { Request(cache:true), Request(mode:"apply"), Request(year:2025) })
        {
            var output=WorkerExecutor.Execute(request);
            Assert.False(output.Ok); Assert.Null(output.Graph); Assert.NotEmpty(output.Diagnostics);
            Assert.DoesNotContain(output.Diagnostics,d=>d.Message.Contains("MUST_NOT_EXECUTE_IN_WORKER"));
        }
    }

    [NativeCompileFact]
    public void OrdinaryWorkerDoesNotAcquireNativeCompileOrExecutionPermission()
    {
        var result=WorkerExecutor.Execute(new WorkerInput {Source=Source});
        Assert.False(result.Ok); Assert.Contains(result.Diagnostics,d=>d.Code=="REVIT_REFERENCE_FORBIDDEN");
    }

    [NativeCompileFact]
    public void PinnedHashVersionNameAndRetainedAssemblySubstitutionReject()
    {
        foreach(var field in new[]{"hash","version","name","retained"})
        {
            var request=Request();var refs=request.NativeCompilation!.References.ToArray();
            if(field=="hash") refs[0].Sha256="sha256:"+new string('0',64);
            if(field=="version") refs[0].Version="9.0.0.0";
            if(field=="name") refs[0].Name="../RevitAPI";
            var output=WorkerExecutor.Execute(request,field=="retained"?new byte[]{1}:null);
            Assert.False(output.Ok);Assert.Null(output.NativeProgramArtifact);
            Assert.Contains(output.Diagnostics,d=>d.Code=="NATIVE_COMPILE_TRANSPORT");
        }
    }

    [Fact]
    public void RealStagingUsesSameCompleteOverlayIdentityAsTrustedHostAndDetectsMutation()
    {
        var root=Path.Combine(Path.GetTempPath(),"native-stage227-"+Guid.NewGuid().ToString("N"));
        var source=Path.Combine(root,"base");var refsDirectory=Path.Combine(root,"refs");
        Directory.CreateDirectory(source);Directory.CreateDirectory(refsDirectory);
        File.WriteAllText(Path.Combine(source,"DynamicRevitWorker.exe"),"worker");
        File.WriteAllText(Path.Combine(source,"DynamicRevitSdk.dll"),"sdk");
        File.WriteAllText(Path.Combine(source,"worker.runtimeconfig.json"),"manifest");
        var refs=Names.Select(name=>
        {
            var path=Path.Combine(refsDirectory,name+".dll");File.WriteAllText(path,name+" metadata");
            return new NativeReferenceSource(name,path,DynamicWire.Sha256(File.ReadAllBytes(path)));
        }).ToArray();
        var pin=DynamicRuntimePackageDirectoryIdentity.Compute(source);
        var expected=DynamicRuntimePackageDirectoryIdentity.ComputeWithNativeTarget2024(source,pin,
            refs.ToDictionary(r=>r.Name,r=>r.SourcePath));
        // Deliberate corruption belongs in this fixture's own pool, never the
        // application's shared immutable image cache or another test's image.
        using var lease=RuntimeImagePool.Acquire(Path.Combine(root,"pool"),source,refs);
        Assert.Equal(expected,lease.Image.VerifyBeforeLaunch());
        Assert.NotEqual(pin,lease.Image.Identity);
        var staged=Path.Combine(lease.Image.Directory,"native-target","2024","System.dll");
        File.SetAttributes(staged,FileAttributes.Normal);File.AppendAllText(staged,"changed");
        Assert.Throws<InvalidOperationException>(()=>lease.Image.VerifyBeforeLaunch());
        File.WriteAllText(Path.Combine(source,"unrecognized-policy.json"),"must not silently drop");
        Assert.Throws<InvalidOperationException>(()=>RuntimeImagePool.Acquire(Path.Combine(root,"pool"),source,refs));
    }

    [Fact]
    public void NativeReferenceStagingRejectsWrongHashAndExistingTargetWithoutOverwrite()
    {
        var root=Path.Combine(Path.GetTempPath(),"native-stage225-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);var original=Path.Combine(root,"source.dll");File.WriteAllBytes(original,new byte[]{1,2,3});
        var refs=Names.Select(n=>new NativeReferenceSource(n,original,DynamicWire.Sha256(new byte[]{1,2,3}))).ToArray();
        var output=Path.Combine(root,"runtime");Directory.CreateDirectory(output);
        NativeReferenceStaging.Stage(output,refs);
        Assert.Equal(4,Directory.GetFiles(Path.Combine(output,"native-target","2024")).Length);
        Assert.Throws<InvalidOperationException>(()=>NativeReferenceStaging.Stage(output,refs));
        var other=Path.Combine(root,"wrong");Directory.CreateDirectory(other);
        refs[0]=refs[0] with {Sha256="sha256:"+new string('0',64)};
        Assert.Throws<InvalidOperationException>(()=>NativeReferenceStaging.Stage(other,refs));
        Assert.False(File.Exists(Path.Combine(other,"native-target","2024",refs[0].Name+".dll")));
        // Fixtures remain under the unique temporary root; no broad recursive cleanup.
    }
}

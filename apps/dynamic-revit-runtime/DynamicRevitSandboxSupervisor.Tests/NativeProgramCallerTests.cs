using System.Text.Json;
using RevitOperator.DynamicRevitSdk;
using RevitOperator.DynamicRevitWorker;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

public sealed class NativeProgramCallerTests
{
    [Theory]
    [InlineData("local","general",true)][InlineData("self_hosted","general",true)]
    [InlineData("development","laboratory",true)][InlineData("hosted","general",false)]
    [InlineData("production","general",false)][InlineData("Local","general",false)]
    [InlineData("local","General",false)][InlineData("local","certified",false)]
    [InlineData(null,null,false)]
    public void CompilerRunsAtTheWorkstationWithExplicitSupportedProfile(string? mode,string? profile,bool allowed)
    {
        var error=Record.Exception(()=>Program.ValidateNativeProgramHost(mode,profile));
        if(allowed)Assert.Null(error);else Assert.IsType<InvalidOperationException>(error);
    }
    private static readonly JsonSerializerOptions Json=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase};
    private static string H(string text)=>DynamicWire.Sha256(text);
    private static LiveTaskConfig Config(bool write=false)=>new(){TargetRevitYear="2024",ExpectedDocumentFingerprint=H("doc"),ReadOnly=!write,Apply=write,
        NativeProgram=new(){EntryType="NativeTask",Mode=write?"write":"read",MaxAffectedElements=write?2:0,
            AllowedExistingUniqueIds=write?new[]{"unique-7"}:Array.Empty<string>()}};
    private static DynamicNativeProgramPreparationV1 Preparation(LiveTaskConfig config)=>new(){PreparationId="nativeprogram_test",SourceHash=H("source"),
        Document=new(){ProjectFingerprint=H("doc"),SessionId="session"},WorkerRuntimePackageHash=H("worker"),
        Scope=new(){DocumentFingerprint=H("doc"),DocumentSessionId="session",DocumentRevision=4,NativeScopeHash=H("scope"),DeadlineMs=5000,
            AllowedExistingElementIds=config.Apply?new long[]{7}:Array.Empty<long>(),MaxAffectedElements=config.Apply?2:0},
        References=new[]{"RevitAPI","System","System.Core","mscorlib"}.Select(n=>new DynamicNativeReferenceV1{Name=n,Version="4.0.0.0",Sha256=H(n)}).ToArray(),
        ReferencePaths=new[]{"RevitAPI","System","System.Core","mscorlib"}.ToDictionary(n=>n,n=>Path.GetFullPath(n+".dll"))};
    [Theory][InlineData(false)][InlineData(true)]
    public void ExactNativePreparationBytesRemainBoundToAuthentication(bool write)
    {
        var config=Config(write);var preparation=Preparation(config);
        var raw=JsonSerializer.Serialize(preparation); // native AuthenticateReceipt uses original PascalCase
        var decoded=Program.DecodeNativePreparation(config,H("source"),raw);
        Assert.Equal(raw,decoded.Raw);
        Assert.Equal(H(raw),H(decoded.Raw));
        Assert.NotEqual(H(raw),H(JsonSerializer.Serialize(decoded.Preparation,Json)));
        Assert.Equal(preparation.Document.SessionId,decoded.Preparation.Document.SessionId);
    }
    [Theory][InlineData(false)][InlineData(true)]
    public void PreparationMatchesRequestedReadOrWriteScopeWithoutAnyModelRows(bool write)
    {
        var config=Config(write);var preparation=Preparation(config);
        Program.ValidateNativePreparation(config,H("source"),preparation);
        // Scope names such as listed_elements are metadata, not model rows.
        Assert.DoesNotContain("\"elements\":",JsonSerializer.Serialize(preparation,Json));
    }
    [Theory][InlineData("source")][InlineData("document")][InlineData("session")][InlineData("scope")][InlineData("create")][InlineData("effectScope")]
    [InlineData("budget")][InlineData("deadline")][InlineData("ids")][InlineData("refs")][InlineData("paths")]
    public void SubstitutedOrWidenedPreparationCannotReachCompilation(string field)
    {
        var config=Config();var preparation=Preparation(config);
        switch(field)
        {
            case "source":preparation.SourceHash=H("other");break;
            case "document":preparation.Document.ProjectFingerprint=H("other");break;
            case "session":preparation.Scope.DocumentSessionId="other";break;
            case "scope":preparation.Scope.NativeScopeHash="not hash";break;
            case "effectScope":preparation.Scope.EffectScope="active_document";break;
            case "create":preparation.Scope.AllowCreate=true;break;
            case "budget":preparation.Scope.MaxAffectedElements=2;break;
            case "deadline":preparation.Scope.DeadlineMs=9000;break;
            case "ids":preparation.Scope.AllowedExistingElementIds=new long[]{7};break;
            case "refs":preparation.References=preparation.References.Take(3).ToArray();break;
            case "paths":preparation.ReferencePaths["System"]="relative.dll";break;
        }
        Assert.Throws<InvalidOperationException>(()=>Program.ValidateNativePreparation(config,H("source"),preparation));
    }
    [Fact]
    public void DocumentScopeMustMatchTheExplicitRequestBeforeCompilation()
    {
        var config=Config(true);config.NativeProgram!.EffectScope="active_document";
        config.NativeProgram.AllowedExistingUniqueIds=Array.Empty<string>();config.NativeProgram.MaxAffectedElements=0;
        var preparation=Preparation(config);preparation.Scope.AllowedExistingElementIds=Array.Empty<long>();preparation.Scope.MaxAffectedElements=0;
        Assert.Throws<InvalidOperationException>(()=>Program.ValidateNativePreparation(config,H("source"),preparation));
        preparation.Scope.EffectScope="active_document";
        Program.ValidateNativePreparation(config,H("source"),preparation);
        config.NativeProgram.EffectScope="listed_elements";
        Assert.Throws<InvalidOperationException>(()=>Program.ValidateNativePreparation(config,H("source"),preparation));
    }
    [Theory][InlineData("readCreate")][InlineData("readIds")][InlineData("writeWithoutScope")][InlineData("wide")][InlineData("duplicate")][InlineData("deadline")]
    public void InvalidRequestScopeNeverBecomesAuthority(string field)
    {
        var request=Config(field.StartsWith("write")||field=="wide"||field=="duplicate").NativeProgram!;
        if(field=="readCreate")request.AllowCreate=true;
        if(field=="readIds")request.AllowedExistingUniqueIds=new[]{"id"};
        if(field=="writeWithoutScope")request.AllowedExistingUniqueIds=Array.Empty<string>();
        if(field=="wide")request.MaxAffectedElements=65;
        if(field=="duplicate")request.AllowedExistingUniqueIds=new[]{"id","id"};
        if(field=="deadline")request.DeadlineMs=10001;
        Assert.Throws<InvalidOperationException>(request.Validate);
    }
    [NativeCompileFact]
    public void ActualCompilerArtifactValidatesAndAssemblyBlobStaysOutOfReasoningOutput()
    {
        var source="using Autodesk.Revit.DB; public static class NativeTask {public static string Execute(Document doc){return doc.Title;}}";
        var refs=new[]{"mscorlib","System","System.Core","RevitAPI"}.Select(name=>{
            var bytes=File.ReadAllBytes(name=="RevitAPI"?NativeProgramCompilerTests.RevitApi:Path.Combine(NativeProgramCompilerTests.Framework,name+".dll"));
            return new NativeCompilerReference(name,bytes,DynamicWire.Sha256(bytes));}).ToArray();
        var compiled=NativeProgramCompiler.Compile(source,"NativeTask","read",2024,refs);Assert.Empty(compiled.Diagnostics);
        var artifact=compiled.Artifact!.ToWireArtifact();var config=Config();var preparation=Preparation(config);
        preparation.SourceHash=artifact.SourceHash;preparation.References=artifact.References;
        var output=JsonSerializer.SerializeToElement(new{ok=true,executionStatus="compiled_native",executionElapsedMs=0,
            sourceHash=artifact.SourceHash,programHash=artifact.AssemblyHash,sdkHash=DynamicRevitSdkVersion.ManifestHash,nativeProgramArtifact=artifact},Json);
        var result=Program.ValidateNativeCompilerOutput(output,config.NativeProgram!,preparation,artifact.SourceHash);
        Assert.False(result.ExecutionAuthorized);
        Assert.Throws<InvalidOperationException>(()=>Program.ValidateNativeCompilerOutput(output,config.NativeProgram!,preparation,H("different source")));
        var sanitized=Program.SanitizeWorkerOutput(output);
        Assert.False(sanitized.GetProperty("nativeProgramArtifact").TryGetProperty("assembly",out _));
        Assert.Equal(artifact.AssemblyHash,sanitized.GetProperty("nativeProgramArtifact").GetProperty("assemblyHash").GetString());
        Assert.True(output.GetProperty("nativeProgramArtifact").TryGetProperty("assembly",out _));
        artifact.Assembly[0]^=1;
        var wrong=JsonSerializer.SerializeToElement(new{ok=true,executionStatus="compiled_native",executionElapsedMs=0,
            sourceHash=artifact.SourceHash,programHash=artifact.AssemblyHash,sdkHash=DynamicRevitSdkVersion.ManifestHash,nativeProgramArtifact=artifact},Json);
        Assert.Throws<InvalidOperationException>(()=>Program.ValidateNativeCompilerOutput(wrong,config.NativeProgram!,preparation,artifact.SourceHash));
    }
}

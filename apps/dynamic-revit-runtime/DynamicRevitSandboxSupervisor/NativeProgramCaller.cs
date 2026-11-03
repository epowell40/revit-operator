using System.Text.Json;
using RevitOperator.DynamicRevitSdk;
using RevitOperator.DynamicRevit.RuntimePackaging;

namespace RevitOperator.DynamicRevitSandboxSupervisor;

internal static partial class Program
{
    internal static void ValidateNativeLane(LiveTaskConfig config)
    {
        if(config.NativeProgram==null)return;
        RequireNativeProgramHost();config.NativeProgram.Validate();
        if(!int.TryParse(config.TargetRevitYear,out var targetYear) || !DynamicNativeTargetProfile.Supports(targetYear) || config.ReadOnly!=(config.NativeProgram.Mode=="read") ||
            config.Apply!=(config.NativeProgram.Mode=="write") || config.ResultReference ||
            !string.IsNullOrWhiteSpace(config.ContextRuleFile) || !string.IsNullOrWhiteSpace(config.ContextRuleVerificationKeyFile) ||
            !string.IsNullOrWhiteSpace(config.ContextCompanyId) || !string.IsNullOrWhiteSpace(config.ContextUserId) || config.CoreEffectBudget!=null ||
            !string.IsNullOrWhiteSpace(config.CompilationCacheDirectory) || config.ExpectedDocumentFingerprint==null ||
            !IsNativeHash(config.ExpectedDocumentFingerprint))
            throw new InvalidOperationException("Native programs require one explicit read/write lane, a supported Revit 2023–2027 target, an expected document and no legacy graph/cache/context-rule lane.");
    }
    internal static void RequireNativeProgramHost()
    {
        ValidateNativeProgramHost(Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE"),
            Environment.GetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE"));
    }
    internal static void ValidateNativeProgramHost(string? mode,string? profile)
    {
        if ((mode=="local"||mode=="self_hosted") && profile=="general") return;
        if (mode=="development" && profile=="laboratory") return;
        throw new InvalidOperationException("Native programs require the local/self-hosted General Agent or exact development/laboratory workstation profile.");
    }
    private static bool IsNativeHash(string value)=>value!=null && value.Length==71 && value.StartsWith("sha256:",StringComparison.Ordinal) && value[7..].All(c=>c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static string NativeSourceHash(string source)=>DynamicWire.Sha256(source.Replace("\r\n","\n").Replace("\r","\n"));

    private static async Task<(DynamicNativeProgramPreparationV1 Preparation,string Raw)> PrepareNativeProgram(LiveTaskConfig config,string source,string runtimeId,
        byte[] key,string token,string writeGrant,List<string> authentications)
    {
        var sourceHash=NativeSourceHash(source);var program=config.NativeProgram!;var expectedDocumentFingerprint=config.ExpectedDocumentFingerprint!;
        var core=JsonSerializer.Serialize(new{sourceHash,expectedDocumentFingerprint,program},WireJson);
        var correlationId=Guid.NewGuid().ToString("N");var authExpiresUnixSeconds=DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
        var request=JsonSerializer.Serialize(new{runtimeInstanceId=runtimeId,correlationId,authExpiresUnixSeconds,
            requestMac=DynamicWire.SignSessionMessage(key,"native-program-prepare",runtimeId,correlationId,authExpiresUnixSeconds,DynamicWire.Sha256(core)),
            sourceHash,expectedDocumentFingerprint,program},WireJson);
        var envelope=await Post(config.BridgeUrl,"/revit/dynamic-runtime/native-program-prepare-v1",token,writeGrant,request,correlationId);
        var raw=UnwrapAuthenticated(envelope,key,runtimeId,"native-program-prepare-receipt",out var authentication);authentications.Add(authentication);
        return DecodeNativePreparation(config,sourceHash,raw);
    }

    internal static (DynamicNativeProgramPreparationV1 Preparation,string Raw) DecodeNativePreparation(LiveTaskConfig config,string sourceHash,string raw)
    {
        var preparation=JsonSerializer.Deserialize<DynamicNativeProgramPreparationV1>(raw,Json)??throw new InvalidOperationException("Native preparation was empty.");
        ValidateNativePreparation(config,sourceHash,preparation);
        // Preserve the exact authenticated bytes (including native PascalCase),
        // not a reserialization with the launcher's camelCase options.
        return (preparation,raw);
    }

    internal static void ValidateNativePreparation(LiveTaskConfig config,string sourceHash,DynamicNativeProgramPreparationV1 preparation)
    {
        var request=config.NativeProgram??throw new InvalidOperationException("Native lane is missing.");request.Validate();
        var scope=preparation.Scope;var document=preparation.Document;var names=DynamicNativeTargetProfile.ReferenceNames(int.Parse(config.TargetRevitYear,System.Globalization.CultureInfo.InvariantCulture));
        if(preparation.Schema!="dynamic-revit-native-preparation/v1" || !preparation.PreparationId.StartsWith("nativeprogram_",StringComparison.Ordinal) ||
            preparation.PreparationId.Length>128 || preparation.SourceHash!=sourceHash || !IsNativeHash(sourceHash) ||
            !IsNativeHash(preparation.WorkerRuntimePackageHash) || scope==null || document==null ||
            scope.DocumentFingerprint!=config.ExpectedDocumentFingerprint || document.ProjectFingerprint!=scope.DocumentFingerprint ||
            string.IsNullOrWhiteSpace(scope.DocumentSessionId) || document.SessionId!=scope.DocumentSessionId || scope.DocumentRevision<0 ||
            !IsNativeHash(scope.NativeScopeHash) || scope.EffectScope!=request.EffectScope || scope.AllowCreate!=request.AllowCreate || scope.MaxAffectedElements!=request.MaxAffectedElements ||
            scope.DeadlineMs!=request.DeadlineMs || scope.AllowedExistingElementIds==null ||
            scope.AllowedExistingElementIds.Count!=request.AllowedExistingUniqueIds.Length ||
            scope.AllowedExistingElementIds.Any(id=>id<=0) || scope.AllowedExistingElementIds.Distinct().Count()!=scope.AllowedExistingElementIds.Count ||
            preparation.References==null || preparation.References.Count!=names.Length || preparation.References.Any(r=>r==null || !IsNativeHash(r.Sha256) || string.IsNullOrWhiteSpace(r.Version)) ||
            !preparation.References.Select(r=>r.Name).OrderBy(n=>n,StringComparer.Ordinal).SequenceEqual(names) ||
            preparation.ReferencePaths==null || preparation.ReferencePaths.Count!=names.Length ||
            !preparation.ReferencePaths.Keys.OrderBy(n=>n,StringComparer.Ordinal).SequenceEqual(names) ||
            preparation.ReferencePaths.Values.Any(path=>!Path.IsPathFullyQualified(path)||path.StartsWith(@"\\",StringComparison.Ordinal)))
            throw new InvalidOperationException("Authenticated native preparation does not match the requested document, source, target or effect scope.");
    }

    internal static DynamicNativeProgramArtifactV1 ValidateNativeCompilerOutput(JsonElement output,DynamicNativeProgramRequestV1 request,
        DynamicNativeProgramPreparationV1 preparation,string expectedSourceHash)
    {
        if(!output.GetProperty("ok").GetBoolean() || output.GetProperty("executionStatus").GetString()!="compiled_native" ||
            output.GetProperty("executionElapsedMs").GetInt64()!=0 || output.GetProperty("sdkHash").GetString()!=DynamicRevitSdkVersion.ManifestHash)
            throw new InvalidOperationException("Native compiler output is not an authenticated compile-only artifact.");
        var artifact=output.GetProperty("nativeProgramArtifact").Deserialize<DynamicNativeProgramArtifactV1>(Json)??throw new InvalidOperationException("Native compiler omitted its artifact.");
        if(artifact.EntryType!=request.EntryType || artifact.Mode!=request.Mode || artifact.SourceHash!=output.GetProperty("sourceHash").GetString() ||
            artifact.AssemblyHash!=output.GetProperty("programHash").GetString())throw new InvalidOperationException("Native compiler source/program identity differs.");
        _=DynamicNativeProgramArtifactPolicyV1.ValidateCurrentBinding(artifact,preparation.Scope,preparation.References,expectedSourceHash,
            preparation.Document.ProjectFingerprint,preparation.Document.SessionId,preparation.Scope.DocumentRevision,preparation.Scope.NativeScopeHash);
        return artifact;
    }

    private static async Task<LiveEvidence> CompleteNativeProgram(LiveTaskConfig config,DateTimeOffset started,TaskWorkspace workspace,
        WindowsSandboxProfile profile,RevitHostCapability selectedHost,BootstrapCompletion bootstrap,string runtimeId,byte[] hostKey,byte[] signingKey,
        string token,string writeGrant,string registration,string snapshot,JsonElement output,DynamicNativeProgramPreparationV1 preparation,
        string source,string launcherHash,string workerHash,int workerPid,string nonceHash,string directoryHash,string correlation,List<string> authentications)
    {
        var artifact=ValidateNativeCompilerOutput(output,config.NativeProgram!,preparation,NativeSourceHash(source));
        var binding=DynamicNativeProgramArtifactPolicyV1.BindingHash(artifact,preparation.Scope);
        var admission=new DynamicWorkerAdmission {RuntimeInstanceId=runtimeId,LauncherExecutableHash=launcherHash,WorkerExecutableHash=workerHash,
            SandboxProfile=profile.ProfileName,WorkerProcessId=workerPid,StartupNonceHash=nonceHash,TaskDirectoryIdentity=directoryHash,
            SourceHash=artifact.SourceHash,ProgramHash=artifact.AssemblyHash,SdkHash=DynamicRevitSdkVersion.ManifestHash,OperationGraphHash=binding,
            DocumentFingerprint=preparation.Scope.DocumentFingerprint,DocumentSessionId=preparation.Scope.DocumentSessionId,
            CorrelationId=correlation,ExpiresUnixSeconds=DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds()};
        admission.Signature=DynamicWire.SignAdmission(admission,signingKey);
        // Retain exact compiler bytes locally; do not send assembly blobs into the
        // reasoning context. Native outcome remains separate from compiler success.
        await File.WriteAllTextAsync(Path.Combine(workspace.Root,"native-compiled-artifact.json"),JsonSerializer.Serialize(artifact,WireJson));
        var preparationId=preparation.PreparationId;
        var core=JsonSerializer.Serialize(new{preparationId,artifact,admission},WireJson);
        var correlationId=Guid.NewGuid().ToString("N");var authExpiresUnixSeconds=DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds();
        var request=JsonSerializer.Serialize(new{runtimeInstanceId=runtimeId,correlationId,authExpiresUnixSeconds,
            requestMac=DynamicWire.SignSessionMessage(hostKey,"native-program-execute",runtimeId,correlationId,authExpiresUnixSeconds,DynamicWire.Sha256(core)),
            preparationId,artifact,admission},WireJson);
        var path=artifact.Mode=="read"?"/revit/dynamic-runtime/native-program-read-v1":"/revit/dynamic-runtime/native-program-apply-v1";
        var envelope=await Post(config.BridgeUrl,path,token,writeGrant,request,correlationId);
        var raw=UnwrapAuthenticated(envelope,hostKey,runtimeId,"native-program-execute-receipt",out var authentication);authentications.Add(authentication);
        using var document=JsonDocument.Parse(raw);var receipt=document.RootElement;
        if(receipt.GetProperty("schema").GetString()!="dynamic-revit-native-execution-receipt/v1" ||
            receipt.GetProperty("preparation_id").GetString()!=preparationId || receipt.GetProperty("native_binding_hash").GetString()!=binding ||
            receipt.GetProperty("source_hash").GetString()!=artifact.SourceHash || receipt.GetProperty("assembly_hash").GetString()!=artifact.AssemblyHash ||
            receipt.GetProperty("document_fingerprint").GetString()!=preparation.Scope.DocumentFingerprint ||
            receipt.GetProperty("document_session_id").GetString()!=preparation.Scope.DocumentSessionId || receipt.GetProperty("verified").GetBoolean())
            throw new InvalidOperationException("Native execution receipt has a mismatched identity or incorrectly claims task verification.");
        return new LiveEvidence {Schema="dynamic-revit-native-program-evidence/v1",Ok=receipt.GetProperty("success").GetBoolean(),
            StartedUtc=started,CompletedUtc=DateTimeOffset.UtcNow,SandboxProfile=profile.ProfileName,TaskDirectory=workspace.Root,
            RuntimeImageDirectory=workspace.RuntimeDirectory,RuntimeImageIdentity=workspace.RuntimeImage.Identity,RuntimeDependencyCount=workspace.RuntimeImage.Files.Count,
            RegistrationReceipt=registration,SnapshotReceipt=snapshot,WorkerOutput=SanitizeWorkerOutput(output),Admission=admission,
            NativeExecutionReceipt=raw,HostAuthenticationReceipts=authentications,TargetRevitYear=selectedHost.RevitYear,
            ExpectedHostExecutable=bootstrap.ExpectedImage,ObservedHostExecutable=bootstrap.ObservedImage};
    }
}

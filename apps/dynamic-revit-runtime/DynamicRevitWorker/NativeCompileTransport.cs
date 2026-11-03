using System.Diagnostics;
using RevitOperator.DynamicRevitSdk;

namespace RevitOperator.DynamicRevitWorker;

// Internal compiler request on the existing authenticated worker channel. It
// contains identities only; metadata is staged by the trusted supervisor in its
// immutable runtime image. No task-supplied file path or assembly cache is read.
internal sealed class NativeCompileRequest
{
    public int RevitYear { get; set; }
    public string EntryType { get; set; } = "";
    public string Mode { get; set; } = "";
    public IReadOnlyList<DynamicNativeReferenceV1> References { get; set; } = Array.Empty<DynamicNativeReferenceV1>();
}

internal static class NativeCompileTransport
{
    internal static WorkerOutput Compile(WorkerInput input, byte[]? retainedAssembly)
    {
        var clock=Stopwatch.StartNew();
        var source=input.Source.Replace("\r\n","\n").Replace("\r","\n");
        var output=new WorkerOutput {SourceHash=DynamicWire.Sha256(source),SdkHash=DynamicRevitSdkVersion.ManifestHash};
        try
        {
            var request=input.NativeCompilation ?? throw new InvalidOperationException("Missing native compile request.");
            if (!DynamicNativeTargetProfile.Supports(request.RevitYear) || request.Mode is not ("read" or "write") ||
                retainedAssembly!=null || input.CachedAssemblyBase64!=null || !string.IsNullOrEmpty(input.CompilationCacheKey) ||
                request.References==null || request.References.Any(r=>r==null) ||
                !request.References.Select(r=>r.Name).OrderBy(n=>n,StringComparer.Ordinal).SequenceEqual(DynamicNativeTargetProfile.ReferenceNames(request.RevitYear)))
                throw new InvalidOperationException("Native compilation requires the exact pinned Revit/CLR target and no legacy or retained assembly cache.");
            var root=Path.Combine(AppContext.BaseDirectory,"native-target","2024");
            RequireDirect(root);
            var references=new List<NativeCompilerReference>();
            foreach(var reference in request.References)
            {
                var file=Path.Combine(root,reference.Name+".dll");RequireDirect(file);
                if((File.GetAttributes(file)&FileAttributes.ReadOnly)==0)
                    throw new InvalidOperationException("Native reference must belong to the read-only runtime image.");
                using var stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read);
                if(stream.Length is <1 or >64*1024*1024)throw new InvalidOperationException("Native reference exceeds its bound.");
                var bytes=new byte[checked((int)stream.Length)];stream.ReadExactly(bytes);
                if(DynamicWire.Sha256(bytes)!=reference.Sha256)throw new InvalidOperationException("Native reference hash differs from the compile request.");
                references.Add(new(reference.Name,bytes,reference.Sha256));
            }
            var result=NativeProgramCompiler.Compile(source,request.EntryType,request.Mode,request.RevitYear,references);
            output.Diagnostics=result.Diagnostics.ToArray();
            if(result.Artifact==null)return output;
            foreach(var reference in result.Artifact.References)
                if(request.References.Single(r=>r.Name==reference.Name).Version!=reference.Version)
                    throw new InvalidOperationException("Native reference version differs from its pinned metadata.");
            output.NativeProgramArtifact=result.Artifact.ToWireArtifact();
            _=DynamicNativeProgramArtifactPolicyV1.ArtifactHash(output.NativeProgramArtifact);
            output.ProgramHash=result.Artifact.AssemblyHash;output.CompiledAssemblyHash=result.Artifact.AssemblyHash;
            output.ExecutionStatus="compiled_native";output.Ok=true;
            // Deliberately no Assembly.Load, Execute, graph, deterministic replay,
            // continuation or native authority. The host validates and executes once.
            return output;
        }
        catch(Exception ex) when(ex is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
        {
            output.NativeProgramArtifact=null;output.Ok=false;output.ExecutionStatus="failed";
            output.Diagnostics=new[]{new WorkerDiagnostic{Code="NATIVE_COMPILE_TRANSPORT",Message=ex.Message,Phase="native_compile",RepairAction="inspect_pinned_target_or_source"}};
            return output;
        }
        finally{output.CompileElapsedMs=clock.ElapsedMilliseconds;}
    }

    private static void RequireDirect(string path)
    {
        // The trusted supervisor checks ancestors before granting the immutable
        // image. LPAC intentionally cannot inspect the user's profile directory;
        // the worker checks only its granted image and descendants.
        var image=Path.GetFullPath(AppContext.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);
        var full=Path.GetFullPath(path);
        if(!full.StartsWith(image+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Native reference escaped the runtime image.");
        for(var cursor=full;!string.IsNullOrEmpty(cursor);cursor=Path.GetDirectoryName(cursor))
        {
            if((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0)
                throw new InvalidOperationException("Native reference paths cannot traverse reparse points.");
            if(string.Equals(cursor,image,StringComparison.OrdinalIgnoreCase))return;
        }
        throw new InvalidOperationException("Native reference has no runtime image ancestor.");
    }
}

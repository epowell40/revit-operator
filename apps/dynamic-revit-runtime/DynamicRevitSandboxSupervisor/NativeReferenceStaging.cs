using RevitOperator.DynamicRevitSdk;

namespace RevitOperator.DynamicRevitSandboxSupervisor;

// Trusted launcher input, never deserialized from generated source or a task's
// file-path request. Hashes must come from the selected installed target.
internal sealed record NativeReferenceSource(string Name,string SourcePath,string Sha256);

internal static class NativeReferenceStaging
{
    internal static void Stage(string runtimeDirectory,IReadOnlyList<NativeReferenceSource> sources)
    {
        if(sources==null || sources.Any(s=>s==null) ||
            !DynamicNativeTargetProfile.KnownReferenceNames(sources.Select(s=>s.Name)))
            throw new InvalidOperationException("Native target requires its exact trusted framework reference profile.");
        // Keep the existing opaque overlay layout for cache/replay compatibility.
        // The target year is bound by actual reference bytes and the artifact.
        var destination=Path.Combine(runtimeDirectory,"native-target","2024");
        if(Directory.Exists(Path.Combine(runtimeDirectory,"native-target")))
            throw new InvalidOperationException("Native target metadata cannot overwrite runtime content.");
        ReparsePointGuard.EnsureExistingPathIsDirect(runtimeDirectory);
        Directory.CreateDirectory(destination);
        foreach(var source in sources)
        {
            ReparsePointGuard.EnsureExistingPathIsDirect(source.SourcePath);
            using var input=new FileStream(source.SourcePath,FileMode.Open,FileAccess.Read,FileShare.Read);
            if(input.Length is <1 or >64*1024*1024)throw new InvalidOperationException("Native reference exceeds its bound.");
            var bytes=new byte[checked((int)input.Length)];input.ReadExactly(bytes);
            if(DynamicWire.Sha256(bytes)!=source.Sha256)throw new InvalidOperationException("Native reference changed before staging.");
            using var output=new FileStream(Path.Combine(destination,source.Name+".dll"),FileMode.CreateNew,FileAccess.Write,FileShare.None);
            output.Write(bytes);output.Flush(true);
        }
        // RuntimeImage.Stage subsequently seals attributes, hashes every file and
        // includes these exact bytes in existing package identity/launch checks.
    }
}

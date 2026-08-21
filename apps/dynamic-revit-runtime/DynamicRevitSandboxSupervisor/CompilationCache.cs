using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using RevitOperator.DynamicRevitSdk;

namespace RevitOperator.DynamicRevitSandboxSupervisor;

internal sealed record CompilationCacheLookup(string CacheKey, byte[]? Assembly, string? ArtifactHash, bool Hit);

internal sealed class CompilationCacheManifest
{
    public string Schema { get; set; } = CompilationCache.Schema;
    public string CacheKey { get; set; } = "";
    public string ArtifactHash { get; set; } = "";
    public long ArtifactLength { get; set; }
    public string CompilerRuntimeHash { get; set; } = "";
    public string SdkArtifactHash { get; set; } = "";
    public string WorkerRuntimePackageHash { get; set; } = "";
    public string SourceHash { get; set; } = "";
    public string PolicyIdentityHash { get; set; } = "";
}

internal sealed class CompilationCache
{
    internal const string Schema = "dynamic-revit-compilation-cache-entry/v1";
    internal const string CompilerOptionsIdentity = "csharp12|release|deterministic|unsafe:false";
    internal const int MaximumArtifactBytes = 2 * 1024 * 1024;
    internal const int MaximumEntries = 256;
    private const string MarkerName = ".dynamic-compilation-cache-v1";
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = false };
    private readonly string _root;

    internal CompilationCache(string root)
    {
        _root = Path.GetFullPath(root ?? throw new ArgumentNullException(nameof(root)));
        if (Path.GetPathRoot(_root) == _root) throw new InvalidOperationException("Compilation cache may not be a filesystem root.");
        EnsurePrivateDirectory(_root);
    }

    internal static string Key(string sourceHash, string compilerRuntimeHash, string sdkArtifactHash, string workerRuntimePackageHash)
    {
        RequireHash(sourceHash, "source"); RequireHash(compilerRuntimeHash, "compiler runtime");
        RequireHash(sdkArtifactHash, "SDK artifact"); RequireHash(workerRuntimePackageHash, "worker package");
        return DynamicWire.Sha256(string.Join("\n", Schema, CompilerOptionsIdentity, DynamicExecutionProtocolV1.ContractIdentity,
            sourceHash, compilerRuntimeHash, sdkArtifactHash, workerRuntimePackageHash));
    }

    internal CompilationCacheLookup TryRead(string cacheKey, string sourceHash, string compilerRuntimeHash, string sdkArtifactHash, string workerRuntimePackageHash)
    {
        ValidateKey(cacheKey);
        var artifactPath = ArtifactPath(cacheKey); var manifestPath = ManifestPath(cacheKey);
        if (!File.Exists(artifactPath) && !File.Exists(manifestPath)) return new CompilationCacheLookup(cacheKey, null, null, false);
        if (!File.Exists(artifactPath) || !File.Exists(manifestPath)) throw new InvalidOperationException("Compilation cache entry is incomplete.");
        var manifestBytes = ReadAnchored(manifestPath, 16 * 1024);
        var manifest = JsonSerializer.Deserialize<CompilationCacheManifest>(manifestBytes, Json)
            ?? throw new InvalidOperationException("Compilation cache manifest is empty.");
        var expectedKeys = new[] { "schema", "cacheKey", "artifactHash", "artifactLength", "compilerRuntimeHash", "sdkArtifactHash", "workerRuntimePackageHash", "sourceHash", "policyIdentityHash" };
        using (var shape = JsonDocument.Parse(manifestBytes))
            if (!shape.RootElement.EnumerateObject().Select(value => value.Name).OrderBy(value => value, StringComparer.Ordinal)
                .SequenceEqual(expectedKeys.OrderBy(value => value, StringComparer.Ordinal), StringComparer.Ordinal))
                throw new InvalidOperationException("Compilation cache manifest has unknown or missing fields.");
        if (manifest.Schema != Schema || manifest.CacheKey != cacheKey || manifest.SourceHash != sourceHash ||
            manifest.CompilerRuntimeHash != compilerRuntimeHash || manifest.SdkArtifactHash != sdkArtifactHash ||
            manifest.WorkerRuntimePackageHash != workerRuntimePackageHash || manifest.PolicyIdentityHash != DynamicExecutionProtocolV1.ContractIdentity ||
            manifest.ArtifactLength is < 1 or > MaximumArtifactBytes) throw new InvalidOperationException("Compilation cache manifest binding is invalid.");
        var assembly = ReadAnchored(artifactPath, MaximumArtifactBytes);
        var hash = DynamicWire.Sha256(assembly);
        if (assembly.LongLength != manifest.ArtifactLength || hash != manifest.ArtifactHash)
            throw new InvalidOperationException("Compilation cache artifact identity is invalid.");
        return new CompilationCacheLookup(cacheKey, assembly, hash, true);
    }

    internal CompilationCacheLookup Store(string cacheKey, string sourceHash, string compilerRuntimeHash, string sdkArtifactHash,
        string workerRuntimePackageHash, byte[] assembly)
    {
        ValidateKey(cacheKey);
        if (assembly == null || assembly.Length is < 1 or > MaximumArtifactBytes) throw new InvalidOperationException("Compiled artifact exceeds the cache bound.");
        var artifactHash = DynamicWire.Sha256(assembly);
        var manifest = new CompilationCacheManifest
        {
            CacheKey = cacheKey, ArtifactHash = artifactHash, ArtifactLength = assembly.LongLength, SourceHash = sourceHash,
            CompilerRuntimeHash = compilerRuntimeHash, SdkArtifactHash = sdkArtifactHash, WorkerRuntimePackageHash = workerRuntimePackageHash,
            PolicyIdentityHash = DynamicExecutionProtocolV1.ContractIdentity
        };
        var artifactPath = ArtifactPath(cacheKey); var manifestPath = ManifestPath(cacheKey);
        var suffix = "." + Guid.NewGuid().ToString("N") + ".tmp";
        var artifactTemp = artifactPath + suffix; var manifestTemp = manifestPath + suffix;
        try
        {
            WriteNew(artifactTemp, assembly);
            WriteNew(manifestTemp, JsonSerializer.SerializeToUtf8Bytes(manifest, Json));
            try { File.Move(artifactTemp, artifactPath, false); }
            catch (IOException) when (File.Exists(artifactPath)) { File.Delete(artifactTemp); }
            try { File.Move(manifestTemp, manifestPath, false); }
            catch (IOException) when (File.Exists(manifestPath)) { File.Delete(manifestTemp); }
            File.SetAttributes(artifactPath, File.GetAttributes(artifactPath) | FileAttributes.ReadOnly);
            File.SetAttributes(manifestPath, File.GetAttributes(manifestPath) | FileAttributes.ReadOnly);
        }
        finally
        {
            if (File.Exists(artifactTemp)) File.Delete(artifactTemp);
            if (File.Exists(manifestTemp)) File.Delete(manifestTemp);
        }
        Prune();
        return TryRead(cacheKey, sourceHash, compilerRuntimeHash, sdkArtifactHash, workerRuntimePackageHash);
    }

    private string ArtifactPath(string key) => Path.Combine(_root, key.Substring("sha256:".Length) + ".dll");
    private string ManifestPath(string key) => Path.Combine(_root, key.Substring("sha256:".Length) + ".json");

    private void Prune()
    {
        var manifests = new DirectoryInfo(_root).EnumerateFiles("*.json", SearchOption.TopDirectoryOnly)
            .Where(value => (value.Attributes & FileAttributes.ReparsePoint) == 0)
            .OrderByDescending(value => value.LastWriteTimeUtc).ThenBy(value => value.Name, StringComparer.Ordinal).ToArray();
        foreach (var extra in manifests.Skip(MaximumEntries))
        {
            var stem = Path.GetFileNameWithoutExtension(extra.Name);
            var artifact = Path.Combine(_root, stem + ".dll");
            if ((extra.Attributes & FileAttributes.ReparsePoint) != 0 || File.Exists(artifact) && (File.GetAttributes(artifact) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Compilation cache pruning encountered a reparse point.");
            File.SetAttributes(extra.FullName, extra.Attributes & ~FileAttributes.ReadOnly); File.Delete(extra.FullName);
            if (File.Exists(artifact)) { File.SetAttributes(artifact, File.GetAttributes(artifact) & ~FileAttributes.ReadOnly); File.Delete(artifact); }
        }
    }

    private static byte[] ReadAnchored(string path, int maximum)
    {
        RejectReparsePath(path);
        var before = new FileInfo(path);
        if (!before.Exists || before.Length is < 1 || before.Length > maximum || (before.Attributes & FileAttributes.ReadOnly) == 0)
            throw new InvalidOperationException("Compilation cache file is missing, mutable, or outside bounds.");
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length != before.Length) throw new InvalidOperationException("Compilation cache file changed before read.");
        var bytes = new byte[stream.Length]; var offset = 0;
        while (offset < bytes.Length) { var read = stream.Read(bytes, offset, bytes.Length - offset); if (read == 0) throw new EndOfStreamException(); offset += read; }
        var after = new FileInfo(path);
        if (!after.Exists || after.Length != stream.Length || after.LastWriteTimeUtc != before.LastWriteTimeUtc)
            throw new InvalidOperationException("Compilation cache file changed during read.");
        return bytes;
    }

    private static void WriteNew(string path, byte[] bytes)
    {
        RejectReparsePath(Path.GetDirectoryName(path)!);
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.WriteThrough);
        stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
    }

    private static void EnsurePrivateDirectory(string root)
    {
        var existed = Directory.Exists(root);
        var initialize = !existed;
        if (existed)
        {
            RejectReparsePath(root);
            var marker = Path.Combine(root, MarkerName);
            if (File.Exists(marker))
            {
                if ((File.GetAttributes(marker) & (FileAttributes.ReparsePoint | FileAttributes.ReadOnly)) != FileAttributes.ReadOnly ||
                    File.ReadAllText(marker) != Schema) throw new InvalidOperationException("Existing compilation cache ownership marker is invalid.");
            }
            else if (Directory.EnumerateFileSystemEntries(root).Any())
                throw new InvalidOperationException("Existing non-empty compilation cache root lacks its immutable ownership marker.");
            else initialize = true;
        }
        else Directory.CreateDirectory(root);
        RejectReparsePath(root);
        if (OperatingSystem.IsWindows())
        {
            var identity = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Current Windows SID is unavailable.");
            var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(root).SetAccessControl(security);
        }
        if (initialize)
        {
            var marker = Path.Combine(root, MarkerName);
            File.WriteAllText(marker, Schema);
            File.SetAttributes(marker, FileAttributes.ReadOnly);
        }
    }

    private static void RejectReparsePath(string path)
    {
        var full = Path.GetFullPath(path); var root = Path.GetPathRoot(full)!; var relative = Path.GetRelativePath(root, full);
        var cursor = root;
        foreach (var part in relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (part.Length == 0) continue; cursor = Path.Combine(cursor, part);
            if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Compilation cache path contains a reparse point.");
        }
    }

    private static void ValidateKey(string key) { RequireHash(key, "cache key"); }
    private static void RequireHash(string value, string name)
    {
        if (value == null || value.Length != 71 || !value.StartsWith("sha256:", StringComparison.Ordinal) ||
            value.Substring(7).Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
            throw new InvalidOperationException("Compilation cache " + name + " is invalid.");
    }
}

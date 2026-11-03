using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevitOperator.DynamicRevitSdk;

namespace RevitOperator.DynamicRevitSandboxSupervisor;

internal sealed class TaskWorkspace : IDisposable
{
    private const int MaximumRetainedTasks = 32;
    private static readonly TimeSpan MaximumRetention = TimeSpan.FromHours(24);

    private readonly FileStream _activeLease;
    private readonly RuntimeImageLease _runtimeLease;

    private TaskWorkspace(string root, string runtimeDirectory, string scratchDirectory, RuntimeImage runtimeImage, FileStream activeLease, RuntimeImageLease runtimeLease)
    {
        Root = root;
        RuntimeDirectory = runtimeDirectory;
        ScratchDirectory = scratchDirectory;
        RuntimeImage = runtimeImage;
        _activeLease = activeLease;
        _runtimeLease = runtimeLease;
    }

    public string Root { get; }
    public string RuntimeDirectory { get; }
    public string ScratchDirectory { get; }
    public RuntimeImage RuntimeImage { get; }

    public static TaskWorkspace Create(string evidencePath, string lane, string runtimeSourceDirectory,
        IReadOnlyList<NativeReferenceSource>? nativeReferences = null)
    {
        if (string.IsNullOrWhiteSpace(lane) || lane.Length > 64 || lane == "." || lane == ".." || lane.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || lane.Contains(Path.DirectorySeparatorChar) || lane.Contains(Path.AltDirectorySeparatorChar))
            throw new ArgumentException("Task workspace lane must be a single safe path component.", nameof(lane));

        var evidenceDirectory = Path.GetDirectoryName(Path.GetFullPath(evidencePath))
            ?? throw new InvalidOperationException("Evidence path has no parent directory.");
        ReparsePointGuard.EnsureDirectoryExistsDirect(evidenceDirectory);
        var laneRoot = LaunchableLaneRoot(evidenceDirectory, lane);
        ReparsePointGuard.EnsureDirectoryExistsDirect(laneRoot);
        var retained = TaskRetention.Prune(laneRoot, MaximumRetention, MaximumRetainedTasks - 1, DateTimeOffset.UtcNow);
        if (retained.Bytes > 256L * 1024 * 1024 || retained.Entries >= MaximumRetainedTasks)
            throw new IOException("Protected dynamic tasks exceed the execution workspace retention budget.");
        if (new DriveInfo(Path.GetPathRoot(laneRoot)!).AvailableFreeSpace < RuntimeImagePool.MinimumFreeBytes)
            throw new IOException("Dynamic runtime disk headroom is below the task reserve.");

        var root = Path.Combine(laneRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var activeLease = new FileStream(Path.Combine(root, ".active"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.WriteThrough);
        try
        {
            var scratch = Path.Combine(root, "scratch");
            Directory.CreateDirectory(scratch);
            var runtimeLease = RuntimeImagePool.Acquire(Path.Combine(Path.GetDirectoryName(laneRoot)!, "runtime-images"), runtimeSourceDirectory, nativeReferences);
            var runtime = runtimeLease.Image;
            return new TaskWorkspace(root, runtime.Directory, scratch, runtime, activeLease, runtimeLease);
        }
        catch
        {
            activeLease.Dispose();
            try { TaskRetention.SafeDeleteTree(root); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { Console.Error.WriteLine("dynamic_task_cleanup_pending: " + error.GetType().Name); }
            throw;
        }
    }

    // CreateProcess/apphost startup cannot reliably launch the staged worker at
    // extended-length paths, even though .NET can copy and hash those files.
    // Keep evidence at its requested path; shorten only disposable execution
    // storage. No junction, environment permission change, or sandbox fallback.
    internal static string LaunchableLaneRoot(string evidenceDirectory, string lane)
    {
        static bool Fits(string path) => Path.Combine(path, new string('0', 32), "runtime-image", "DynamicRevitWorker.exe").Length < 260;
        var local = ResolveLocalApplicationData(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            Environment.GetEnvironmentVariable("LOCALAPPDATA"));
        var shortened = Path.Combine(local, "RevitOperator", "DynamicTasks", "v2", lane);
        if (!Fits(shortened)) throw new PathTooLongException("The per-user worker workspace cannot fit the Windows process launch path bound.");
        return shortened;
    }

    internal static string ResolveLocalApplicationData(string knownFolder, string? inheritedLocalAppData)
    {
        // Authentication launchers can redirect USERPROFILE without creating its
        // AppData folders. Windows then returns an empty known-folder value.
        // Use the trusted launcher's inherited LOCALAPPDATA, never generated code,
        // a task argument, a guessed profile suffix, or an alternate sandbox mode.
        var local = string.IsNullOrWhiteSpace(knownFolder) ? inheritedLocalAppData : knownFolder;
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local) ||
            local.StartsWith(@"\\", StringComparison.Ordinal) || !Directory.Exists(local))
            throw new InvalidOperationException("A direct existing local application-data path is required for the bounded worker workspace.");
        ReparsePointGuard.EnsureExistingPathIsDirect(local);
        return Path.GetFullPath(local);
    }

    public void Dispose()
    {
        _activeLease.Dispose();
        _runtimeLease.Dispose();
        // Result/evidence files already live outside execution storage. This
        // finally path runs after success, failure, cancellation and timeout.
        try { if (Directory.Exists(Root)) TaskRetention.SafeDeleteTree(Root); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { Console.Error.WriteLine("dynamic_task_cleanup_pending: " + error.GetType().Name); }
    }
}

internal sealed class RuntimeImage
{
    private static readonly string[] AllowedSuffixes = { ".dll", ".exe", ".deps.json", ".runtimeconfig.json", ".pdb" };
    private const int MaximumDependencyCount = 256;
    private const long MaximumDependencyBytes = 256L * 1024 * 1024;
    private readonly RuntimeFile[] _files;

    private RuntimeImage(string directory, RuntimeFile[] files, string identity)
    {
        Directory = directory;
        _files = files;
        Identity = identity;
    }

    public string Directory { get; }
    public string Identity { get; }
    public IReadOnlyList<RuntimeFile> Files => _files;
    public string WorkerExecutableHash => RequireFile("DynamicRevitWorker.exe").Sha256;
    public string SdkArtifactHash => RequireFile("DynamicRevitSdk.dll").Sha256;
    public string CompilerRuntimeHash => ComputeIdentity(_files.Where(file =>
        !string.Equals(file.RelativePath, "DynamicRevitWorker.exe", StringComparison.OrdinalIgnoreCase)
        && !string.Equals(file.RelativePath, "DynamicRevitSdk.dll", StringComparison.OrdinalIgnoreCase)));

    public static RuntimeImage Stage(string sourceDirectory, string taskRoot,
        IReadOnlyList<NativeReferenceSource>? nativeReferences = null)
    {
        var source = Path.GetFullPath(sourceDirectory);
        var root = Path.GetFullPath(taskRoot);
        ReparsePointGuard.EnsureExistingPathIsDirect(source);
        ReparsePointGuard.EnsureExistingPathIsDirect(root);

        // The reference overlay changes the package identity. Compare the staged
        // image with the complete base plus the exact trusted target bytes; never
        // omit the overlay from the existing launch/admission package hash.
        var expectedNativeIdentity = nativeReferences == null ? null :
            DynamicRuntimePackageDirectoryIdentity.ComputeWithNativeTarget2024(source,
                DynamicRuntimePackageDirectoryIdentity.Compute(source),
                nativeReferences.ToDictionary(reference => reference.Name, reference => reference.SourcePath, StringComparer.Ordinal));

        var sourceFiles = EnumerateRuntimeFiles(source).ToArray();
        if (!sourceFiles.Any(file => string.Equals(file.RelativePath, "DynamicRevitWorker.exe", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Runtime dependency set does not contain DynamicRevitWorker.exe.");
        if (!sourceFiles.Any(file => string.Equals(file.RelativePath, "DynamicRevitSdk.dll", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Runtime dependency set does not contain DynamicRevitSdk.dll.");
        ValidateBounds(sourceFiles.Select(file => new FileInfo(file.FullPath).Length));

        var destination = Path.Combine(root, "runtime-image");
        System.IO.Directory.CreateDirectory(destination);
        long copiedBytes = 0;
        foreach (var sourceFile in sourceFiles)
        {
            var target = Path.Combine(destination, sourceFile.RelativePath);
            System.IO.Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            copiedBytes = checked(copiedBytes + CopyRuntimeFileBounded(sourceFile.FullPath, target));
            if (copiedBytes > MaximumDependencyBytes) throw new InvalidOperationException("Runtime image exceeds the 256-MiB dependency bound while staging.");
            ReparsePointGuard.EnsureNotReparsePoint(sourceFile.FullPath);
            ReparsePointGuard.EnsureNotReparsePoint(target);
        }

        if (nativeReferences != null) NativeReferenceStaging.Stage(destination, nativeReferences);
        var files = ReadManifest(destination);
        ValidateBounds(files.Select(file => file.Length));
        foreach (var file in files)
        {
            var path = Path.Combine(destination, file.RelativePath);
            File.SetAttributes(path, File.GetAttributes(path) | FileAttributes.ReadOnly);
        }

        var identity = DynamicRuntimePackageDirectoryIdentity.Compute(destination);
        if (expectedNativeIdentity != null && identity != expectedNativeIdentity)
            throw new InvalidOperationException("Staged native compiler image differs from the observed base package and target references.");
        var manifestPath = Path.Combine(root, "runtime-image.manifest.json");
        File.WriteAllText(manifestPath, JsonSerializer.Serialize(new { schema = "dynamic-revit-runtime-image/v1", identity, files }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true }), new UTF8Encoding(false));
        return new RuntimeImage(destination, files, identity);
    }

    internal static RuntimeImage OpenExisting(string entry, string expectedIdentity)
    {
        var directory = Path.Combine(entry, "runtime-image");
        ReparsePointGuard.EnsureExistingPathIsDirect(directory);
        var image = new RuntimeImage(directory, ReadManifest(directory), expectedIdentity);
        image.VerifyBeforeLaunch();
        return image;
    }

    public string VerifyBeforeLaunch()
    {
        ReparsePointGuard.EnsureExistingPathIsDirect(Directory);
        var observed = ReadManifest(Directory);
        if (observed.Length != _files.Length)
            throw new InvalidOperationException("Runtime image dependency set changed after staging.");
        for (var index = 0; index < observed.Length; index++)
        {
            var expected = _files[index];
            var actual = observed[index];
            if (!string.Equals(expected.RelativePath, actual.RelativePath, StringComparison.Ordinal)
                || expected.Length != actual.Length
                || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected.Sha256), Encoding.UTF8.GetBytes(actual.Sha256)))
                throw new InvalidOperationException("Runtime image dependency changed after staging: " + expected.RelativePath + ".");
            if ((File.GetAttributes(Path.Combine(Directory, actual.RelativePath)) & FileAttributes.ReadOnly) == 0)
                throw new InvalidOperationException("Runtime image dependency is no longer read-only: " + actual.RelativePath + ".");
        }

        var identity = DynamicRuntimePackageDirectoryIdentity.Compute(Directory);
        if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(Identity), Encoding.UTF8.GetBytes(identity)))
            throw new InvalidOperationException("Runtime image identity changed after staging.");
        return identity;
    }

    private static IEnumerable<SourceRuntimeFile> EnumerateRuntimeFiles(string root)
    {
        var files = new List<SourceRuntimeFile>();
        Walk(root, root, files);
        return files.OrderBy(file => file.RelativePath, StringComparer.Ordinal);
    }

    private static void Walk(string root, string directory, List<SourceRuntimeFile> files)
    {
        ReparsePointGuard.EnsureNotReparsePoint(directory);
        foreach (var entry in System.IO.Directory.EnumerateFileSystemEntries(directory).OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
        {
            ReparsePointGuard.EnsureNotReparsePoint(entry);
            if (System.IO.Directory.Exists(entry))
            {
                Walk(root, entry, files);
                continue;
            }
            if (!IsAllowedRuntimeFile(entry)) continue;
            var relative = NormalizeRelativePath(Path.GetRelativePath(root, entry));
            files.Add(new SourceRuntimeFile(entry, relative));
        }
    }

    private static RuntimeFile[] ReadManifest(string directory)
        => EnumerateRuntimeFiles(directory)
            .Select(file => new RuntimeFile(file.RelativePath, new FileInfo(file.FullPath).Length, Sha256(file.FullPath)))
            .OrderBy(file => file.RelativePath, StringComparer.Ordinal)
            .ToArray();

    private static bool IsAllowedRuntimeFile(string path)
        => AllowedSuffixes.Any(suffix => path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase));

    private static string NormalizeRelativePath(string path) => path.Replace(Path.DirectorySeparatorChar, '/').Replace(Path.AltDirectorySeparatorChar, '/');

    private static string ComputeIdentity(IEnumerable<RuntimeFile> files)
    {
        var canonical = string.Join("\n", files.Select(file => file.RelativePath + ":" + file.Length + ":" + file.Sha256));
        if (canonical.Length == 0) throw new InvalidOperationException("Runtime image identity has no allowlisted dependencies.");
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    private RuntimeFile RequireFile(string relativePath)
        => _files.SingleOrDefault(file => string.Equals(file.RelativePath, relativePath, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException("Runtime image is missing its required identity artifact: " + relativePath + ".");

    private static string Sha256(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return "sha256:" + Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static long CopyRuntimeFileBounded(string source, string destination)
    {
        ReparsePointGuard.EnsureNotReparsePoint(source);
        using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.SequentialScan);
        if (input.Length > MaximumDependencyBytes) throw new InvalidOperationException("Runtime dependency exceeds the bounded image size: " + source);
        using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.SequentialScan);
        input.CopyTo(output, 64 * 1024);
        output.Flush(flushToDisk: true);
        return output.Length;
    }

    private sealed record SourceRuntimeFile(string FullPath, string RelativePath);

    private static void ValidateBounds(IEnumerable<long> lengths)
    {
        var count = 0;
        long total = 0;
        foreach (var length in lengths)
        {
            if (length < 0 || length > MaximumDependencyBytes) throw new InvalidOperationException("Runtime dependency exceeds the bounded image size.");
            count++;
            total = checked(total + length);
            if (count > MaximumDependencyCount || total > MaximumDependencyBytes)
                throw new InvalidOperationException("Runtime image exceeds the 256-file or 256-MiB dependency bound.");
        }
    }
}

internal sealed record RuntimeFile(string RelativePath, long Length, string Sha256);

internal static class ReparsePointGuard
{
    public static void EnsureDirectoryExistsDirect(string path)
    {
        var full = Path.GetFullPath(path);
        var missing = new Stack<string>();
        var cursor = new DirectoryInfo(full);
        while (!cursor.Exists)
        {
            missing.Push(cursor.FullName);
            cursor = cursor.Parent ?? throw new DirectoryNotFoundException("Path has no existing filesystem root: " + full);
        }
        EnsureExistingPathIsDirect(cursor.FullName);
        while (missing.Count > 0)
        {
            var directory = missing.Pop();
            Directory.CreateDirectory(directory);
            EnsureNotReparsePoint(directory);
        }
    }

    public static void EnsureExistingPathIsDirect(string path)
    {
        var full = Path.GetFullPath(path);
        if (!Directory.Exists(full) && !File.Exists(full)) throw new DirectoryNotFoundException("Path does not exist: " + full);
        var cursor = Directory.Exists(full) ? new DirectoryInfo(full) : new FileInfo(full).Directory;
        while (cursor != null)
        {
            EnsureNotReparsePoint(cursor.FullName);
            cursor = cursor.Parent;
        }
        if (File.Exists(full)) EnsureNotReparsePoint(full);
    }

    public static void EnsureNotReparsePoint(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Reparse points are not permitted in dynamic runtime paths: " + path);
    }
}

internal static class TaskRetention
{
    internal static long DirectoryBytes(string root)
    {
        ReparsePointGuard.EnsureExistingPathIsDirect(root);
        long bytes = 0;
        foreach (var file in Directory.EnumerateFiles(root)) { ReparsePointGuard.EnsureNotReparsePoint(file); bytes = checked(bytes + new FileInfo(file).Length); }
        foreach (var directory in Directory.EnumerateDirectories(root)) bytes = checked(bytes + DirectoryBytes(directory));
        return bytes;
    }
    public static (long Bytes, int Entries) Prune(string laneRoot, TimeSpan maximumAge, int maximumEntries, DateTimeOffset now)
    {
        if (maximumAge <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(maximumAge));
        if (maximumEntries < 0) throw new ArgumentOutOfRangeException(nameof(maximumEntries));
        ReparsePointGuard.EnsureExistingPathIsDirect(laneRoot);

        var candidates = Directory.EnumerateDirectories(laneRoot)
            .Select(path => new DirectoryInfo(path))
            .Where(directory => directory.Name.Length == 32 && directory.Name.All(Uri.IsHexDigit))
            .OrderByDescending(directory => directory.CreationTimeUtc)
            .ToArray();
        long retainedBytes = 0; int retainedEntries = 0;
        for (var index = 0; index < candidates.Length; index++)
        {
            var candidate = candidates[index];
            var expired = now.UtcDateTime - candidate.CreationTimeUtc > maximumAge;
            var bytes = DirectoryBytes(candidate.FullName);
            if (!File.Exists(Path.Combine(candidate.FullName, ".retain")) && (expired || index >= maximumEntries || retainedBytes + bytes > 256L * 1024 * 1024) && CanAcquireForCleanup(candidate.FullName)) SafeDeleteTree(candidate.FullName);
            else { retainedBytes = checked(retainedBytes + bytes); retainedEntries++; }
        }
        return (retainedBytes, retainedEntries);
    }

    private static bool CanAcquireForCleanup(string path)
    {
        var marker = Path.Combine(path, ".active");
        if (!File.Exists(marker)) return true;
        try
        {
            using var lease = new FileStream(marker, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            return true;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    internal static void SafeDeleteTree(string path)
    {
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            Directory.Delete(path, recursive: false);
            return;
        }
        foreach (var file in Directory.EnumerateFiles(path))
        {
            var fileAttributes = File.GetAttributes(file);
            if ((fileAttributes & FileAttributes.ReadOnly) != 0) File.SetAttributes(file, fileAttributes & ~FileAttributes.ReadOnly);
            File.Delete(file);
        }
        foreach (var directory in Directory.EnumerateDirectories(path)) SafeDeleteTree(directory);
        Directory.Delete(path, recursive: false);
    }
}

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RevitOperator.DynamicRevitSandboxSupervisor;

internal sealed class TaskWorkspace : IDisposable
{
    private const int MaximumRetainedTasks = 32;
    private static readonly TimeSpan MaximumRetention = TimeSpan.FromHours(24);

    private readonly FileStream _activeLease;

    private TaskWorkspace(string root, string runtimeDirectory, string scratchDirectory, RuntimeImage runtimeImage, FileStream activeLease)
    {
        Root = root;
        RuntimeDirectory = runtimeDirectory;
        ScratchDirectory = scratchDirectory;
        RuntimeImage = runtimeImage;
        _activeLease = activeLease;
    }

    public string Root { get; }
    public string RuntimeDirectory { get; }
    public string ScratchDirectory { get; }
    public RuntimeImage RuntimeImage { get; }

    public static TaskWorkspace Create(string evidencePath, string lane, string runtimeSourceDirectory)
    {
        if (string.IsNullOrWhiteSpace(lane) || lane.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || lane.Contains(Path.DirectorySeparatorChar) || lane.Contains(Path.AltDirectorySeparatorChar))
            throw new ArgumentException("Task workspace lane must be a single safe path component.", nameof(lane));

        var evidenceDirectory = Path.GetDirectoryName(Path.GetFullPath(evidencePath))
            ?? throw new InvalidOperationException("Evidence path has no parent directory.");
        ReparsePointGuard.EnsureDirectoryExistsDirect(evidenceDirectory);
        var laneRoot = Path.Combine(evidenceDirectory, lane);
        Directory.CreateDirectory(laneRoot);
        ReparsePointGuard.EnsureExistingPathIsDirect(laneRoot);
        TaskRetention.Prune(laneRoot, MaximumRetention, MaximumRetainedTasks - 1, DateTimeOffset.UtcNow);

        var root = Path.Combine(laneRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var activeLease = new FileStream(Path.Combine(root, ".active"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.WriteThrough);
        try
        {
            var scratch = Path.Combine(root, "scratch");
            Directory.CreateDirectory(scratch);
            var runtime = RuntimeImage.Stage(runtimeSourceDirectory, root);
            return new TaskWorkspace(root, runtime.Directory, scratch, runtime, activeLease);
        }
        catch
        {
            activeLease.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        _activeLease.Dispose();
        var marker = Path.Combine(Root, ".active");
        if (File.Exists(marker)) File.Delete(marker);
    }
}

internal sealed class RuntimeImage
{
    private static readonly string[] AllowedSuffixes = { ".dll", ".exe", ".deps.json", ".runtimeconfig.json" };
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

    public static RuntimeImage Stage(string sourceDirectory, string taskRoot)
    {
        var source = Path.GetFullPath(sourceDirectory);
        var root = Path.GetFullPath(taskRoot);
        ReparsePointGuard.EnsureExistingPathIsDirect(source);
        ReparsePointGuard.EnsureExistingPathIsDirect(root);

        var sourceFiles = EnumerateRuntimeFiles(source).ToArray();
        if (!sourceFiles.Any(file => string.Equals(file.RelativePath, "DynamicRevitWorker.exe", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Runtime dependency set does not contain DynamicRevitWorker.exe.");
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

        var files = ReadManifest(destination);
        ValidateBounds(files.Select(file => file.Length));
        foreach (var file in files)
        {
            var path = Path.Combine(destination, file.RelativePath);
            File.SetAttributes(path, File.GetAttributes(path) | FileAttributes.ReadOnly);
        }

        var identity = ComputeIdentity(files);
        var manifestPath = Path.Combine(root, "runtime-image.manifest.json");
        File.WriteAllText(manifestPath, JsonSerializer.Serialize(new { schema = "dynamic-revit-runtime-image/v1", identity, files }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true }), new UTF8Encoding(false));
        return new RuntimeImage(destination, files, identity);
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

        var identity = ComputeIdentity(observed);
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
    public static void Prune(string laneRoot, TimeSpan maximumAge, int maximumEntries, DateTimeOffset now)
    {
        if (maximumAge <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(maximumAge));
        if (maximumEntries < 0) throw new ArgumentOutOfRangeException(nameof(maximumEntries));
        ReparsePointGuard.EnsureExistingPathIsDirect(laneRoot);

        var candidates = Directory.EnumerateDirectories(laneRoot)
            .Select(path => new DirectoryInfo(path))
            .Where(directory => directory.Name.Length == 32 && directory.Name.All(Uri.IsHexDigit))
            .OrderByDescending(directory => directory.CreationTimeUtc)
            .ToArray();
        for (var index = 0; index < candidates.Length; index++)
        {
            var candidate = candidates[index];
            var expired = now.UtcDateTime - candidate.CreationTimeUtc > maximumAge;
            if ((expired || index >= maximumEntries) && CanAcquireForCleanup(candidate.FullName)) SafeDeleteTree(candidate.FullName);
        }
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

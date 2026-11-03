using System.Text;
using RevitOperator.DynamicRevitSdk;

namespace RevitOperator.DynamicRevitSandboxSupervisor;

// Dependency bytes only. Generated programs, results, credentials, authorization
// and scratch never enter this cache. Every acquire rehashes the exact package.
internal sealed class RuntimeImageLease : IDisposable
{
    private readonly string _leasePath;
    private readonly FileStream _lease;
    public RuntimeImage Image { get; }
    internal RuntimeImageLease(RuntimeImage image, string leasePath, FileStream lease)
    { Image = image; _leasePath = leasePath; _lease = lease; }
    public void Dispose() { _lease.Dispose(); if (File.Exists(_leasePath)) File.Delete(_leasePath); }
}

internal static class RuntimeImagePool
{
    internal const long MaximumBytes = 2L * 1024 * 1024 * 1024;
    internal const long MinimumFreeBytes = 1024L * 1024 * 1024;
    internal static RuntimeImageLease Acquire(string pool, string source, IReadOnlyList<NativeReferenceSource>? references = null)
    {
        ReparsePointGuard.EnsureDirectoryExistsDirect(pool);
        using var gate = Lock(pool);
        PruneLocked(pool, DateTimeOffset.UtcNow, reserveEntry: true);
        if (references != null)
        {
            if (references.Any(r => r == null) || !DynamicNativeTargetProfile.KnownReferenceNames(references.Select(r => r.Name)))
                throw new InvalidOperationException("Native target requires its exact trusted framework reference profile.");
            foreach (var reference in references)
            {
                ReparsePointGuard.EnsureExistingPathIsDirect(reference.SourcePath);
                using var input = new FileStream(reference.SourcePath, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (input.Length is < 1 or > 64 * 1024 * 1024) throw new InvalidOperationException("Native reference exceeds its bound.");
                var bytes = new byte[checked((int)input.Length)]; input.ReadExactly(bytes);
                if (DynamicWire.Sha256(bytes) != reference.Sha256) throw new InvalidOperationException("Native reference changed before runtime reuse.");
            }
        }
        var baseIdentity = DynamicRuntimePackageDirectoryIdentity.Compute(source);
        var identity = references == null ? baseIdentity : DynamicRuntimePackageDirectoryIdentity.ComputeWithNativeTarget2024(
            source, baseIdentity, references.ToDictionary(r => r.Name, r => r.SourcePath, StringComparer.Ordinal));
        if (!identity.StartsWith("sha256:") || identity.Length != 71 || !identity[7..].All(Uri.IsHexDigit))
            throw new InvalidDataException("Runtime image identity is malformed.");
        var entry = Path.Combine(pool, identity[7..]);
        if (!Directory.Exists(entry) && Directory.EnumerateDirectories(pool).Count(p => Path.GetFileName(p).Length == 64 && Path.GetFileName(p).All(Uri.IsHexDigit)) >= 8)
            throw new IOException("Protected runtime images exceed the cache count budget.");
        ReparsePointGuard.EnsureDirectoryExistsDirect(entry);
        RuntimeImage image;
        if (File.Exists(Path.Combine(entry, "runtime-image.manifest.json")))
            image = RuntimeImage.OpenExisting(entry, identity);
        else
        {
            if (new DriveInfo(Path.GetPathRoot(pool)!).AvailableFreeSpace < MinimumFreeBytes + 256L * 1024 * 1024)
                throw new IOException("Dynamic runtime disk headroom is below the staging reserve.");
            var temporary = Path.Combine(pool, Guid.NewGuid().ToString("N"));
            ReparsePointGuard.EnsureDirectoryExistsDirect(temporary);
            try
            {
                image = RuntimeImage.Stage(source, temporary, references);
                if (image.Identity != identity) throw new InvalidDataException("Runtime source changed during staging.");
                // An entry without a published manifest cannot be leased.
                Directory.Delete(entry);
                Directory.Move(temporary, entry);
                image = RuntimeImage.OpenExisting(entry, identity);
            }
            finally { if (Directory.Exists(temporary)) TaskRetention.SafeDeleteTree(temporary); }
        }
        var leases = Path.Combine(entry, ".leases");
        ReparsePointGuard.EnsureDirectoryExistsDirect(leases);
        var file = Path.Combine(leases, Guid.NewGuid().ToString("N"));
        var lease = new FileStream(file, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        File.SetLastWriteTimeUtc(Path.Combine(entry, "runtime-image.manifest.json"), DateTime.UtcNow);
        return new RuntimeImageLease(image, file, lease);
    }

    internal static FileStream Lock(string pool)
    {
        var file = Path.Combine(pool, ".pool-lock");
        ReparsePointGuard.EnsureExistingPathIsDirect(pool);
        if (File.Exists(file)) ReparsePointGuard.EnsureExistingPathIsDirect(file);
        var deadline = DateTime.UtcNow.AddSeconds(30);
        for (;;)
        {
            try { return new FileStream(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (DateTime.UtcNow < deadline) { Thread.Sleep(25); }
        }
    }
    internal static void PruneLocked(string pool, DateTimeOffset now, bool reserveEntry = false)
    {
        var entries = Directory.EnumerateDirectories(pool).Select(p => new DirectoryInfo(p))
            .Where(d => d.Name.Length == 64 && d.Name.All(Uri.IsHexDigit))
            .OrderByDescending(d => File.GetLastWriteTimeUtc(Path.Combine(d.FullName, "runtime-image.manifest.json"))).ToArray();
        long retainedBytes = 0; int retained = 0;
        foreach (var entry in entries)
        {
            ReparsePointGuard.EnsureExistingPathIsDirect(entry.FullName);
            var active = false;
            var leases = Path.Combine(entry.FullName, ".leases");
            if (Directory.Exists(leases))
            {
                ReparsePointGuard.EnsureExistingPathIsDirect(leases);
                foreach (var marker in Directory.EnumerateFiles(leases))
                {
                    ReparsePointGuard.EnsureExistingPathIsDirect(marker);
                    try { using (new FileStream(marker, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { } File.Delete(marker); }
                    catch (IOException) { active = true; }
                    catch (UnauthorizedAccessException) { active = true; }
                }
            }
            var bytes = TaskRetention.DirectoryBytes(entry.FullName);
            var expired = now.UtcDateTime - File.GetLastWriteTimeUtc(Path.Combine(entry.FullName, "runtime-image.manifest.json")) > TimeSpan.FromDays(7);
            if (!active && !File.Exists(Path.Combine(entry.FullName, ".retain")) && (expired || retained >= (reserveEntry ? 7 : 8) || retainedBytes + bytes > MaximumBytes - (reserveEntry ? 256L * 1024 * 1024 : 0)))
                TaskRetention.SafeDeleteTree(entry.FullName);
            else { retained++; retainedBytes += bytes; }
        }
        // Never evict active/pinned images to satisfy a budget.
        if (retainedBytes > MaximumBytes) throw new IOException("Protected runtime images exceed the cache byte budget.");
        foreach (var abandoned in Directory.EnumerateDirectories(pool).Where(p => Path.GetFileName(p).Length == 32 && Path.GetFileName(p).All(Uri.IsHexDigit)))
            TaskRetention.SafeDeleteTree(abandoned); // staging is serialized by this same gate
    }
}

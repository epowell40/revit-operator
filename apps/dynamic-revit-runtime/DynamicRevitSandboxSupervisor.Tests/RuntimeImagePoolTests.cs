using RevitOperator.DynamicRevitSandboxSupervisor;
using Xunit;
using RevitOperator.DynamicRevitSdk;

namespace DynamicRevitSandboxSupervisor.Tests;

public sealed class RuntimeImagePoolTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "OperatorRuntimePoolTests", Guid.NewGuid().ToString("N"));
    private string Source()
    {
        var source = Path.Combine(root, "source"); Directory.CreateDirectory(source);
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "worker");
        File.WriteAllText(Path.Combine(source, "DynamicRevitSdk.dll"), "sdk");
        File.WriteAllBytes(Path.Combine(source, "dependency.dll"), new byte[1024 * 1024]);
        return source;
    }
    [Fact]
    public void RepeatedSuccessAndExceptionalScopesShareOneImageAndRemoveEveryScratchTree()
    {
        var source = Source(); string? runtime = null;
        var lane = "lifecycle-test-" + Guid.NewGuid().ToString("N");
        for (var i = 0; i < 24; i++)
        {
            string? task = null;
            try
            {
                using var workspace = TaskWorkspace.Create(Path.Combine(root, "evidence" + i, "result.json"), lane, source);
                task = workspace.Root;
                if (runtime == null) runtime = workspace.RuntimeDirectory; else Assert.Equal(runtime, workspace.RuntimeDirectory);
                File.WriteAllBytes(Path.Combine(workspace.ScratchDirectory, "partial.bin"), new byte[4096]);
                Assert.Equal(workspace.RuntimeImage.Identity, workspace.RuntimeImage.VerifyBeforeLaunch());
                if (i % 4 == 1) throw new IOException("synthetic failure");
                if (i % 4 == 2) throw new OperationCanceledException("synthetic cancellation");
                if (i % 4 == 3) throw new TimeoutException("synthetic timeout");
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or TimeoutException) { }
            Assert.NotNull(task); Assert.False(Directory.Exists(task));
        }
        Assert.True(Directory.Exists(runtime));
        Assert.Empty(Directory.GetFiles(Path.Combine(Path.GetDirectoryName(runtime!)!, ".leases")));
    }
    [Fact]
    public void CacheDoesNotTrustModifiedDependenciesAndProtectsLeasedOrPinnedImages()
    {
        var source = Source(); var pool = Path.Combine(root, "pool");
        using (var lease = RuntimeImagePool.Acquire(pool, source))
        {
            RuntimeImagePool.PruneLocked(pool, DateTimeOffset.UtcNow.AddDays(30));
            Assert.True(Directory.Exists(lease.Image.Directory));
            var dependency = Path.Combine(lease.Image.Directory, "dependency.dll");
            File.SetAttributes(dependency, FileAttributes.Normal); File.WriteAllText(dependency, "changed");
            Assert.ThrowsAny<Exception>(() => RuntimeImagePool.Acquire(pool, source));
        }
    }
    [Fact]
    public void AClaimedReferenceHashCannotBypassValidationOnACacheHit()
    {
        var source=Source();var pool=Path.Combine(root,"pool");
        var names=new[]{"RevitAPI","System","System.Core","mscorlib"};
        var refs=names.Select(name=>{var file=Path.Combine(root,name+".dll");File.WriteAllText(file,"trusted-"+name);return new NativeReferenceSource(name,file,DynamicWire.Sha256(File.ReadAllBytes(file)));}).ToArray();
        using var lease=RuntimeImagePool.Acquire(pool,source,refs);
        var wrong=refs.Select(r=>r.Name=="RevitAPI"?r with{Sha256=DynamicWire.Sha256("foreign")}:r).ToArray();
        var error=Assert.Throws<InvalidOperationException>(()=>RuntimeImagePool.Acquire(pool,source,wrong));Assert.Contains("changed before runtime reuse",error.Message);
    }
    [Fact]
    public void QualificationPinsAreNeverEvictedToAdmitAnotherVersion()
    {
        var source = Source(); var pool = Path.Combine(root, "pool");
        for (var i = 0; i < 8; i++)
        {
            File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "pinned-worker" + i);
            using var lease = RuntimeImagePool.Acquire(pool, source);
            File.WriteAllText(Path.Combine(Path.GetDirectoryName(lease.Image.Directory)!, ".retain"), "qualification evidence");
        }
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "ninth-version");
        Assert.Throws<IOException>(() => RuntimeImagePool.Acquire(pool, source));
        Assert.Equal(8, Directory.GetDirectories(pool).Length);
    }
    [Fact]
    public void ManyVersionsRemainBoundedAndFailedStagingDoesNotPublishAnImage()
    {
        var source = Source(); var pool = Path.Combine(root, "pool");
        for (var i = 0; i < 20; i++)
        {
            File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "worker" + i);
            using var lease = RuntimeImagePool.Acquire(pool, source);
        }
        Assert.InRange(Directory.GetDirectories(pool).Length, 1, 8);
        Assert.True(TaskRetention.DirectoryBytes(pool) < 9 * 1024 * 1024);
        File.Delete(Path.Combine(source, "DynamicRevitSdk.dll"));
        Assert.ThrowsAny<Exception>(() => RuntimeImagePool.Acquire(pool, source));
        Assert.Empty(Directory.GetDirectories(pool).Where(p => Path.GetFileName(p).Length == 32));
    }
    public void Dispose() { if (Directory.Exists(root)) TaskRetention.SafeDeleteTree(root); }
}

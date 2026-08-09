using System.Text.Json;
using RevitOperator.DynamicRevitSandboxSupervisor;
using Xunit;

namespace DynamicRevitSandboxSupervisor.Tests;

public sealed class RuntimeWorkspaceTests
{
    [Fact]
    public void RuntimeImageHashesEveryAllowlistedDependencyAndExcludesOtherFiles()
    {
        using var temporary = new TemporaryDirectory();
        var source = temporary.CreateDirectory("source");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "worker");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.dll"), "managed-worker");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.deps.json"), "{}");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.runtimeconfig.json"), "{}");
        File.WriteAllText(Path.Combine(source, "debug.pdb"), "not-runtime");
        var locale = Directory.CreateDirectory(Path.Combine(source, "fr")).FullName;
        File.WriteAllText(Path.Combine(locale, "Microsoft.CodeAnalysis.resources.dll"), "satellite");
        var task = temporary.CreateDirectory("task");

        var image = RuntimeImage.Stage(source, task);

        Assert.Equal(5, image.Files.Count);
        Assert.DoesNotContain(image.Files, file => file.RelativePath.EndsWith(".pdb", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(image.Identity, image.VerifyBeforeLaunch());
        Assert.All(image.Files, file => Assert.True((File.GetAttributes(Path.Combine(image.Directory, file.RelativePath)) & FileAttributes.ReadOnly) != 0));
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(task, "runtime-image.manifest.json")));
        Assert.Equal("dynamic-revit-runtime-image/v1", manifest.RootElement.GetProperty("schema").GetString());
        Assert.Equal(image.Identity, manifest.RootElement.GetProperty("identity").GetString());
    }

    [Fact]
    public void RuntimeImageRejectsMutationAndAddedDependencyBeforeLaunch()
    {
        using var temporary = new TemporaryDirectory();
        var source = temporary.CreateDirectory("source");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "worker");
        File.WriteAllText(Path.Combine(source, "dependency.dll"), "dependency");
        var image = RuntimeImage.Stage(source, temporary.CreateDirectory("task"));
        var dependency = Path.Combine(image.Directory, "dependency.dll");
        File.SetAttributes(dependency, FileAttributes.Normal);
        File.WriteAllText(dependency, "tampered");

        Assert.Throws<InvalidOperationException>(() => image.VerifyBeforeLaunch());

        File.WriteAllText(Path.Combine(image.Directory, "injected.dll"), "injected");
        Assert.Throws<InvalidOperationException>(() => image.VerifyBeforeLaunch());
    }

    [Fact]
    public void RuntimeImageRejectsReparsePointDependenciesWhenSupportedByHost()
    {
        using var temporary = new TemporaryDirectory();
        var source = temporary.CreateDirectory("source");
        var worker = Path.Combine(source, "DynamicRevitWorker.exe");
        File.WriteAllText(worker, "worker");
        try
        {
            File.CreateSymbolicLink(Path.Combine(source, "linked.dll"), worker);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
        {
            return;
        }

        Assert.Throws<InvalidOperationException>(() => RuntimeImage.Stage(source, temporary.CreateDirectory("task")));
    }

    [Fact]
    public void RuntimeImageRejectsAnUnboundedDependencySet()
    {
        using var temporary = new TemporaryDirectory();
        var source = temporary.CreateDirectory("source");
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "worker");
        for (var index = 0; index < 256; index++) File.WriteAllText(Path.Combine(source, $"dependency-{index:D3}.dll"), "x");

        Assert.Throws<InvalidOperationException>(() => RuntimeImage.Stage(source, temporary.CreateDirectory("task")));
    }

    [Fact]
    public void RetentionKeepsOnlyNewestBoundedTaskDirectoriesAndDeletesReadOnlyTrees()
    {
        using var temporary = new TemporaryDirectory();
        var lane = temporary.CreateDirectory("tasks");
        var first = CreateTask(lane, '1', DateTime.UtcNow.AddMinutes(-3));
        var second = CreateTask(lane, '2', DateTime.UtcNow.AddMinutes(-2));
        var third = CreateTask(lane, '3', DateTime.UtcNow.AddMinutes(-1));
        Directory.CreateDirectory(Path.Combine(lane, "not-a-task"));

        TaskRetention.Prune(lane, TimeSpan.FromHours(1), 1, DateTimeOffset.UtcNow);

        Assert.False(Directory.Exists(first));
        Assert.False(Directory.Exists(second));
        Assert.True(Directory.Exists(third));
        Assert.True(Directory.Exists(Path.Combine(lane, "not-a-task")));
    }

    [Fact]
    public void RetentionDoesNotDeleteAWorkspaceWithAnActiveLease()
    {
        using var temporary = new TemporaryDirectory();
        var lane = temporary.CreateDirectory("tasks");
        var task = CreateTask(lane, 'a', DateTime.UtcNow.AddDays(-2));
        var marker = Path.Combine(task, ".active");
        using (new FileStream(marker, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
        {
            TaskRetention.Prune(lane, TimeSpan.FromHours(1), 0, DateTimeOffset.UtcNow);
            Assert.True(Directory.Exists(task));
        }

        TaskRetention.Prune(lane, TimeSpan.FromHours(1), 0, DateTimeOffset.UtcNow);
        Assert.False(Directory.Exists(task));
    }

    private static string CreateTask(string lane, char name, DateTime createdUtc)
    {
        var path = Directory.CreateDirectory(Path.Combine(lane, new string(name, 32))).FullName;
        var child = Path.Combine(path, "runtime-image", "worker.dll");
        Directory.CreateDirectory(Path.GetDirectoryName(child)!);
        File.WriteAllText(child, "runtime");
        File.SetAttributes(child, FileAttributes.ReadOnly);
        Directory.SetCreationTimeUtc(path, createdUtc);
        return path;
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        private readonly string _path = Path.Combine(Path.GetTempPath(), "DynamicRevitSandboxSupervisor.Tests", Guid.NewGuid().ToString("N"));
        public TemporaryDirectory() => Directory.CreateDirectory(_path);
        public string CreateDirectory(string name) => Directory.CreateDirectory(Path.Combine(_path, name)).FullName;
        public void Dispose()
        {
            if (Directory.Exists(_path)) TaskRetention.SafeDeleteTree(_path);
        }
    }
}

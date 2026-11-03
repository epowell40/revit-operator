using RevitOperator.DynamicRevitSandboxSupervisor;
using Xunit;

namespace DynamicRevitSandboxSupervisor.Tests;

public sealed class TaskWorkspaceLaunchPathTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "DynamicPathTests", Guid.NewGuid().ToString("N"));
    private readonly List<string> staged = new();

    private TaskWorkspace Create(string evidence)
    {
        var source = Path.Combine(root, "source");
        Directory.CreateDirectory(source);
        File.WriteAllText(Path.Combine(source, "DynamicRevitWorker.exe"), "worker");
        File.WriteAllText(Path.Combine(source, "DynamicRevitSdk.dll"), "sdk");
        var workspace = TaskWorkspace.Create(evidence, "live-tasks", source);
        staged.Add(workspace.Root);
        return workspace;
    }

    [Fact]
    public void DeepEvidenceRetainsEvidenceLocationButUsesLaunchableDirectRuntimePath()
    {
        var evidence = Path.Combine(root, new string('a', 80), new string('b', 80), "evidence.json");
        using var workspace = Create(evidence);
        Assert.True(Path.Combine(workspace.RuntimeDirectory, "DynamicRevitWorker.exe").Length < 260,
            "CreateProcess worker path must stay below MAX_PATH even for deeply nested evidence.");
        Assert.True(workspace.ScratchDirectory.Length < 260);
        ReparsePointGuard.EnsureExistingPathIsDirect(workspace.Root);
        Assert.Equal(workspace.RuntimeImage.Identity, workspace.RuntimeImage.VerifyBeforeLaunch());
        Assert.True(File.Exists(Path.Combine(workspace.Root, ".active")));
        Assert.False(File.Exists(evidence));
    }

    [Fact]
    public void ShortAndLongEvidenceShareRetentionPoolButKeepUniqueTaskLeases()
    {
        var evidence = Path.Combine(root, "evidence.json");
        using var first = Create(evidence);
        using var second = Create(evidence);
        Assert.EndsWith(Path.Combine("DynamicTasks", "v2", "live-tasks"), Path.GetDirectoryName(first.Root));
        Assert.NotEqual(first.Root, second.Root);
        Assert.Equal(first.RuntimeImage.Identity, second.RuntimeImage.Identity);
        Assert.Equal(first.RuntimeDirectory, second.RuntimeDirectory);
    }

    [Fact]
    public void EvidenceNamespacesShareGlobalRetentionAndAnUnlaunchableLocalRootFailsClosed()
    {
        var first = TaskWorkspace.LaunchableLaneRoot(Path.Combine(root, new string('a', 180)), "tests");
        var second = TaskWorkspace.LaunchableLaneRoot(Path.Combine(root, new string('b', 180)), "tests");
        Assert.Equal(first, second);
        Assert.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), first);
        Assert.Throws<PathTooLongException>(() => TaskWorkspace.LaunchableLaneRoot(Path.Combine(root, new string('a', 180)), new string('x', 250)));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("relative")]
    [InlineData(@"\\server\share")]
    public void MissingKnownFolderDoesNotPermitInvalidInheritedStorage(string? inherited)
    {
        Assert.Throws<InvalidOperationException>(() => TaskWorkspace.ResolveLocalApplicationData("", inherited));
    }

    [Fact]
    public void RedirectedProfileUsesExistingInheritedLocalStorageWithoutCreatingGuessedFolders()
    {
        Directory.CreateDirectory(root);
        Assert.Equal(Path.GetFullPath(root), TaskWorkspace.ResolveLocalApplicationData("", root));
        Assert.Equal(Path.GetFullPath(root), TaskWorkspace.ResolveLocalApplicationData(root, "invalid"));
        var absent = Path.Combine(root, "not-created");
        Assert.Throws<InvalidOperationException>(() => TaskWorkspace.ResolveLocalApplicationData("", absent));
        Assert.False(Directory.Exists(absent));
    }

    [Theory]
    [InlineData("..")]
    [InlineData(".")]
    [InlineData("../outside")]
    public void LaneCannotEscapeItsOwnedStorage(string lane)
    {
        Assert.Throws<ArgumentException>(() => TaskWorkspace.Create(Path.Combine(root, "evidence.json"), lane, root));
    }

    public void Dispose()
    {
        foreach (var path in staged)
            if (Directory.Exists(path)) TaskRetention.SafeDeleteTree(path);
        if (Directory.Exists(root)) TaskRetention.SafeDeleteTree(root);
    }
}

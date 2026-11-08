using System;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests;

public sealed class OperatorNativeProgramCourierFilesTests
{
    [Theory]
    [InlineData("missing-evidence")]
    [InlineData("malformed-evidence")]
    [InlineData("oversized-evidence")]
    [InlineData("cancelled")]
    [InlineData("outbox-write-failed")]
    public void StartedWorkKeepsItsFilesUntilDurableCompletionHandoff(string failure)
    {
        WithFiles((directory, files) =>
        {
            files.LauncherStarted();
            if (failure == "missing-evidence") File.Delete(Path.Combine(directory, "evidence.json"));
            if (failure == "malformed-evidence") File.WriteAllText(Path.Combine(directory, "evidence.json"), "{");
            files.LauncherExited();
            files.Dispose();
            Assert.True(File.Exists(Path.Combine(directory, "program.cs")));
            Assert.True(File.Exists(Path.Combine(directory, "task.json")));
            Assert.Equal(failure != "missing-evidence", File.Exists(Path.Combine(directory, "evidence.json")));
        });
    }

    [Fact]
    public void SuccessfulResultIsCleanedOnlyAfterRealOutboxWrite()
    {
        WithFiles((directory, files) =>
        {
            files.LauncherStarted(); files.LauncherExited(); files.Dispose();
            Assert.True(Directory.Exists(directory)); // Returning/parsing alone is insufficient.
            var outboxPath = Path.Combine(Path.GetDirectoryName(directory)!, "outbox");
            try
            {
                var outbox = new OperatorCourierCompletionOutbox(outboxPath);
                var saved = outbox.Save("session-test", "job-test", "executor-test", new { schema = "test", ok = true });
                Assert.Equal("job-test", saved.JobId);
                files.CompletionRetained();
                Assert.False(Directory.Exists(directory));
                Assert.Single(outbox.ReadPending(1));
            }
            finally { if (Directory.Exists(outboxPath)) Directory.Delete(outboxPath, true); }
        });
    }

    [Fact]
    public void PrelaunchFailureCanCleanButRunningLauncherCannot()
    {
        WithFiles((directory, files) => { files.Dispose(); Assert.False(Directory.Exists(directory)); });
        WithFiles((directory, files) =>
        {
            files.LauncherStarted(); files.CompletionRetained(); files.Dispose();
            Assert.True(Directory.Exists(directory));
            files.LauncherExited(); files.Dispose(); Assert.False(Directory.Exists(directory));
        });
    }

    [Fact]
    public void CleanupDoesNotRecurseOrDeleteUnknownEvidence()
    {
        WithFiles((directory, files) =>
        {
            File.WriteAllText(Path.Combine(directory, "preserve.rvt"), "fixture");
            files.Dispose();
            Assert.Equal("fixture", File.ReadAllText(Path.Combine(directory, "preserve.rvt")));
        });
    }

    [Fact]
    public void ActualOutboxFilesystemFailureKeepsTheOriginalRun()
    {
        WithFiles((directory, files) =>
        {
            files.LauncherStarted(); files.LauncherExited();
            var blockedRoot = Path.Combine(Path.GetDirectoryName(directory)!, "not-a-directory");
            File.WriteAllText(blockedRoot, "block the outbox directory");
            var outbox = new OperatorCourierCompletionOutbox(blockedRoot);
            Assert.ThrowsAny<IOException>(() => outbox.Save("session-test", "job-test", "executor-test", new { ok = true }));
            files.Dispose();
            Assert.Equal("{}", File.ReadAllText(Path.Combine(directory, "evidence.json")));
            Assert.True(File.Exists(Path.Combine(directory, "program.cs")));
        });
    }

    private static void WithFiles(Action<string, OperatorNativeProgramCourierFiles> check)
    {
        var parent = Path.Combine(Path.GetTempPath(), "courier-files-" + Guid.NewGuid().ToString("N"));
        var directory = Path.Combine(parent, "run"); Directory.CreateDirectory(directory);
        foreach (var name in new[] { "program.cs", "task.json", "evidence.json" }) File.WriteAllText(Path.Combine(directory, name), "{}");
        try { check(directory, new OperatorNativeProgramCourierFiles(directory)); }
        finally { if (Directory.Exists(parent)) Directory.Delete(parent, true); }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests;

[CollectionDefinition("NativeCourierConsumer", DisableParallelization = true)]
public sealed class NativeCourierConsumerCollection { }

[Collection("NativeCourierConsumer")]
public sealed class OperatorNativeProgramCourierConsumerTests
{
    [Fact]
    public async Task LargeEvidenceReachesDurableOutboxWithoutLosingReceiptBytes()
    {
        await WithWorkspace("large", async root =>
        {
            Action? retained = null;
            var output = await Invoke(action => retained = action);
            var run = Assert.Single(Directory.GetDirectories(Path.Combine(root, "artifacts", "dynamic-runtime-runs")));
            var exact = File.ReadAllBytes(Path.Combine(run, "evidence.json"));
            var serialized = JsonSerializer.SerializeToUtf8Bytes(output);
            Assert.True(serialized.Length <= OperatorCourierResultCompactor.MaxTransportResultBytes);
            using var result = JsonDocument.Parse(serialized);
            var transport = result.RootElement.GetProperty("evidenceTransport");
            using var packed = new MemoryStream(Convert.FromBase64String(transport.GetProperty("data").GetString()!));
            using var gzip = new System.IO.Compression.GZipStream(packed, System.IO.Compression.CompressionMode.Decompress);
            using var decoded = new MemoryStream(); gzip.CopyTo(decoded);
            Assert.Equal(exact, decoded.ToArray());
            Assert.Equal(exact.Length, transport.GetProperty("uncompressedBytes").GetInt32());
            using var sha = System.Security.Cryptography.SHA256.Create();
            Assert.Equal("sha256:" + BitConverter.ToString(sha.ComputeHash(exact)).Replace("-", "").ToLowerInvariant(), transport.GetProperty("sha256").GetString());
            var outbox = new OperatorCourierCompletionOutbox(Path.Combine(root, "outbox"));
            outbox.Save("session", "job", "executor", output);
            Assert.NotNull(retained); retained!();
            Assert.False(Directory.Exists(run)); Assert.Single(outbox.ReadPending());
        });
    }

    [Theory][InlineData("missing")][InlineData("malformed")]
    public async Task MissingOrMalformedEvidenceRetainsActualLauncherRun(string mode)
    {
        await WithWorkspace(mode, async root =>
        {
            await Assert.ThrowsAnyAsync<Exception>(() => Invoke());
            var run = Assert.Single(Directory.GetDirectories(Path.Combine(root, "artifacts", "dynamic-runtime-runs")));
            Assert.True(File.Exists(Path.Combine(run, "program.cs")));
            Assert.True(File.Exists(Path.Combine(run, "task.json")));
            Assert.Equal(mode == "malformed", File.Exists(Path.Combine(run, "evidence.json")));
        });
    }

    [Fact]
    public async Task ResultSurvivesActualOutboxFailureThenCleansAfterDurableHandoff()
    {
        await WithWorkspace("valid", async root =>
        {
            Action? retained = null;
            var output = await Invoke(action => retained = action);
            var run = Assert.Single(Directory.GetDirectories(Path.Combine(root, "artifacts", "dynamic-runtime-runs")));
            Assert.True(File.Exists(Path.Combine(run, "evidence.json")));
            var blocked = Path.Combine(root, "blocked-outbox"); File.WriteAllText(blocked, "fixture");
            Assert.ThrowsAny<IOException>(() => new OperatorCourierCompletionOutbox(blocked).Save("session", "job", "executor", output));
            Assert.True(File.Exists(Path.Combine(run, "evidence.json")));
            var outbox = new OperatorCourierCompletionOutbox(Path.Combine(root, "outbox"));
            outbox.Save("session", "job", "executor", output);
            Assert.NotNull(retained); retained!();
            Assert.False(Directory.Exists(run)); Assert.Single(outbox.ReadPending());
        });
    }

    [Fact]
    public async Task ActualNoisyLauncherIsDrainedWithoutDuplicatingItsStdoutPayload()
    {
        await WithWorkspace("valid-noisy", async root =>
        {
            Action? retained = null;
            await Invoke(action => retained = action);
            var run = Assert.Single(Directory.GetDirectories(Path.Combine(root, "artifacts", "dynamic-runtime-runs")));
            using var diagnostics = JsonDocument.Parse(File.ReadAllText(Path.Combine(run, "launcher-diagnostics.json")));
            var stdout = diagnostics.RootElement.GetProperty("stdout");
            Assert.Equal(200_000, stdout.GetProperty("observed_chars").GetInt64());
            Assert.Equal("", stdout.GetProperty("captured_prefix").GetString());
            Assert.True(stdout.GetProperty("complete").GetBoolean());
            retained!(); Assert.False(Directory.Exists(run));
        });
    }

    [Fact]
    public async Task UnexpectedExitPreservesBoundedStderrWithoutClaimingNativeOutcome()
    {
        await WithWorkspace("stderr-failure", async root =>
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => Invoke());
            var run = Assert.Single(Directory.GetDirectories(Path.Combine(root, "artifacts", "dynamic-runtime-runs")));
            using var diagnostics = JsonDocument.Parse(File.ReadAllText(Path.Combine(run, "launcher-diagnostics.json")));
            Assert.Equal(3, diagnostics.RootElement.GetProperty("exit_code").GetInt32());
            Assert.Equal("diagnostic_only", diagnostics.RootElement.GetProperty("authority").GetString());
            var stderr = diagnostics.RootElement.GetProperty("stderr");
            Assert.Equal(20_000, stderr.GetProperty("observed_chars").GetInt64());
            Assert.Equal(4096, stderr.GetProperty("captured_prefix").GetString()!.Length);
            Assert.True(stderr.GetProperty("truncated").GetBoolean());
            Assert.False(File.Exists(Path.Combine(run, "evidence.json")));
        });
    }

    private static async Task<object> Invoke(Action<Action>? capture = null)
    {
        var body = JsonSerializer.Serialize(new { source = "public class Query {}", targetRevitYear = "2024",
            expectedDocumentFingerprint = "sha256:" + new string('a', 64),
            nativeProgram = new { entryType = "Query", mode = "write", effectScope = "active_document" }, workerDeadlineMs = 1000 });
        var method = typeof(RevitBridge.Operator.OperatorNativeProgramCourierExecution).GetMethod("ExecuteAsync", BindingFlags.Static | BindingFlags.NonPublic)!;
        var arguments = new List<object> { OperatorNativeProgramCourierRequest.ApplyPath, body, "http://127.0.0.1:5000/", CancellationToken.None };
        if (method.GetParameters().Length == 5) arguments.Add(capture ?? (_ => { }));
        return await (Task<object>)method.Invoke(null, arguments.ToArray())!;
    }

    private static async Task WithWorkspace(string mode, Func<string, Task> test)
    {
        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "courier-consumer-" + Guid.NewGuid().ToString("N")));
        var oldRoot = Environment.GetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT");
        var oldMode = Environment.GetEnvironmentVariable("COURIER_LIFECYCLE_FIXTURE_MODE");
        Directory.CreateDirectory(root);
        Environment.SetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT", root);
        Environment.SetEnvironmentVariable("COURIER_LIFECYCLE_FIXTURE_MODE", mode);
        try { await test(root); }
        finally
        {
            Environment.SetEnvironmentVariable("OPERATOR_WORKSPACE_ROOT", oldRoot);
            Environment.SetEnvironmentVariable("COURIER_LIFECYCLE_FIXTURE_MODE", oldMode);
            var allowed = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!root.StartsWith(allowed, StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(root).StartsWith("courier-consumer-")) throw new InvalidOperationException("Fixture cleanup scope changed");
            Directory.Delete(root, true);
        }
    }
}

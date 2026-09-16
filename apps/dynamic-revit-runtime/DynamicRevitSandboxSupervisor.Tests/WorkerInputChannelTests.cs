using System.IO.Pipes;
using System.Text;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

public sealed class WorkerInputChannelTests
{
    [Fact]
    public async Task CompletedWorkerInputCanCloseBeforeReceiptPublicationAndScopeCleanup()
    {
        using var pipe = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.None);
        using var client = new AnonymousPipeClientStream(PipeDirection.In, pipe.ClientSafePipeHandle);
        using var reader = new StreamReader(client, Encoding.UTF8);
        using var writer = Program.CreateWorkerInputWriter(pipe);
        await writer.WriteLineAsync("authenticated worker request");
        Assert.Equal("authenticated worker request", await reader.ReadLineAsync());
        // RunLiveTask ends input before waiting for worker exit, then publishes
        // the read/preview/apply receipt while the writer's using scope exits.
        writer.Dispose();
        pipe.Close();
        var cleanupFailure = Record.Exception(writer.Dispose);
        Assert.Null(cleanupFailure);
        Assert.Throws<ObjectDisposedException>(() => pipe.WriteByte(1));
    }

    [Fact]
    public async Task EarlyFailureKeepsItsOriginalDiagnosticDuringInputCleanup()
    {
        using var pipe = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.None);
        using var client = new AnonymousPipeClientStream(PipeDirection.In, pipe.ClientSafePipeHandle);
        var original = new InvalidOperationException("original worker diagnostic");
        var observed = await Record.ExceptionAsync(async () =>
        {
            using var writer = Program.CreateWorkerInputWriter(pipe);
            await writer.WriteLineAsync("request");
            throw original;
        });
        Assert.Same(original, observed);
    }
}

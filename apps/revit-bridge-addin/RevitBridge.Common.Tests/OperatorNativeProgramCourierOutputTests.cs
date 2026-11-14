using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests;

public sealed class OperatorNativeProgramCourierOutputTests
{
    [Theory][InlineData(0)][InlineData(4096)]
    public async Task LargeStreamsAreFullyDrainedWithBoundedRetention(int bound)
    {
        var text = new string('x', 200_000);
        var output = new OperatorNativeProgramCourierOutput(bound);
        using var reader = new StringReader(text);
        await output.DrainAsync(reader);
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(output.Snapshot()));
        Assert.Equal(bound, json.RootElement.GetProperty("captured_prefix").GetString()!.Length);
        Assert.Equal(text.Length, json.RootElement.GetProperty("observed_chars").GetInt64());
        Assert.True(json.RootElement.GetProperty("truncated").GetBoolean());
        Assert.True(json.RootElement.GetProperty("complete").GetBoolean());
        Assert.Equal("diagnostic_only", json.RootElement.GetProperty("authority").GetString());
        Assert.Equal(-1, reader.Read());
    }

    [Fact]
    public async Task BrokenPipeIsDiagnosticOnlyAndKeepsAnExplicitIncompleteState()
    {
        var output = new OperatorNativeProgramCourierOutput(4096);
        await output.DrainAsync(new BrokenReader());
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(output.Snapshot()));
        Assert.False(json.RootElement.GetProperty("complete").GetBoolean());
        Assert.Equal("IOException", json.RootElement.GetProperty("read_error").GetString());
        Assert.Equal("", json.RootElement.GetProperty("captured_prefix").GetString());
    }

    [Fact]
    public void DiagnosticCapacityIsNotAnUnboundedOutputOption()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new OperatorNativeProgramCourierOutput(-1));
        Assert.Throws<ArgumentOutOfRangeException>(() => new OperatorNativeProgramCourierOutput(4097));
    }

    private sealed class BrokenReader : TextReader
    {
        public override Task<int> ReadAsync(char[] buffer, int index, int count) => throw new IOException("fixture-only");
    }
}

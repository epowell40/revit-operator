using System;
using System.IO;
using System.Text;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests;

public sealed class OperatorNativeProgramEvidenceTransportTests
{
    [Fact]
    public void SmallEvidenceKeepsExistingContract()
    {
        using var result = JsonDocument.Parse(JsonSerializer.Serialize(OperatorNativeProgramEvidenceTransport.Prepare(
            Encoding.UTF8.GetBytes("{\"ok\":false,\"nativeExecutionReceipt\":\" exact Ω \"}"), 1)));
        Assert.Equal(1, result.RootElement.GetProperty("exitCode").GetInt32());
        Assert.False(result.RootElement.TryGetProperty("evidenceTransport", out _));
        Assert.Equal(" exact Ω ", result.RootElement.GetProperty("evidence").GetProperty("nativeExecutionReceipt").GetString());
    }

    [Fact]
    public void OversizedOrMalformedEvidenceNeverBecomesSuccess()
    {
        Assert.ThrowsAny<Exception>(() => OperatorNativeProgramEvidenceTransport.Prepare(new byte[8 * 1024 * 1024 + 1], 0));
        Assert.ThrowsAny<Exception>(() => OperatorNativeProgramEvidenceTransport.Prepare(Encoding.UTF8.GetBytes("[]"), 0));
        Assert.ThrowsAny<Exception>(() => OperatorNativeProgramEvidenceTransport.Prepare(Encoding.UTF8.GetBytes("{"), 0));
        Assert.ThrowsAny<Exception>(() => OperatorNativeProgramEvidenceTransport.Prepare(Encoding.UTF8.GetBytes("{}"), 3));
        var random = new byte[1_000_000]; new Random(42).NextBytes(random);
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { data = Convert.ToBase64String(random) }));
        Assert.Throws<InvalidOperationException>(() => OperatorNativeProgramEvidenceTransport.Prepare(bytes, 0));
    }

    // Optional local retained-evidence replay. Historical private receipts stay
    // outside the public fixture tree; emitted envelopes have no new authority.
    [Fact]
    public void RetainedEvidenceTransportReplayWhenSupplied()
    {
        var manifest = Environment.GetEnvironmentVariable("OPERATOR_COURIER_REPLAY_MANIFEST");
        if (string.IsNullOrEmpty(manifest)) return;
        using var inputs = JsonDocument.Parse(File.ReadAllText(manifest));
        foreach (var input in inputs.RootElement.EnumerateArray())
        {
            var bytes = File.ReadAllBytes(input.GetProperty("input").GetString()!);
            var output = JsonSerializer.SerializeToUtf8Bytes(OperatorNativeProgramEvidenceTransport.Prepare(bytes, 0));
            Assert.True(output.Length <= OperatorCourierResultCompactor.MaxTransportResultBytes);
            File.WriteAllBytes(input.GetProperty("output").GetString()!, output);
        }
    }
}

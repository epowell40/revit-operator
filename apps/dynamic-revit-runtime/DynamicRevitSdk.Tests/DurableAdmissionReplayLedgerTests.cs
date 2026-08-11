using System.Collections.Concurrent;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class DurableAdmissionReplayLedgerTests
{
    [Fact]
    public void CreateNewMarkerIsAtomicAcrossConcurrentAuthoritiesAndDurableAcrossRestart()
    {
        var root = Path.Combine(Path.GetTempPath(), "dynamic-replay-ledger-" + Guid.NewGuid().ToString("N"));
        try
        {
            var key = DynamicWire.Sha256("same-admission"); var outcomes = new ConcurrentBag<bool>();
            Parallel.For(0, 16, _ => outcomes.Add(DurableAdmissionReplayLedgerV1.TryConsume(root, key, DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds())));
            Assert.Single(outcomes, value => value);
            Assert.False(DurableAdmissionReplayLedgerV1.TryConsume(root, key, DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeSeconds()));
            var marker = Assert.Single(Directory.GetFiles(root, "*.used")); Assert.NotEmpty(File.ReadAllBytes(marker));
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}

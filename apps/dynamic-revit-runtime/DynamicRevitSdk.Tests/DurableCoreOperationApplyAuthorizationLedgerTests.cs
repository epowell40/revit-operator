using System.Collections.Concurrent;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class DurableCoreOperationApplyAuthorizationLedgerTests
{
    [Fact]
    public void FirstUseIsAtomicAcrossAuthoritiesAndReplayRemainsRejectedAfterRestart()
    {
        var root = Path.Combine(Path.GetTempPath(), "dynamic-core-apply-ledger-" + Guid.NewGuid().ToString("N"));
        try
        {
            var authorizationHash = DynamicWire.Sha256("authorization");
            var expires = DateTimeOffset.UtcNow.AddMinutes(2).ToUnixTimeSeconds();
            var outcomes = new ConcurrentBag<bool>();
            Parallel.For(0, 32, _ => outcomes.Add(new DurableCoreOperationApplyAuthorizationLedgerV1(root, expires).TryConsume(authorizationHash)));

            Assert.Single(outcomes, value => value);
            Assert.Equal(31, outcomes.Count(value => !value));
            Assert.False(new DurableCoreOperationApplyAuthorizationLedgerV1(root, expires).TryConsume(authorizationHash));
            Assert.True(new DurableCoreOperationApplyAuthorizationLedgerV1(root, expires).TryConsume(DynamicWire.Sha256("different-authorization")));
            Assert.Equal(2, Directory.GetFiles(root, "*.used").Length);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    [Fact]
    public void InvalidInputsAndFilesystemRootFailClosed()
    {
        var root = Path.GetPathRoot(Path.GetTempPath())!;
        Assert.Throws<ArgumentException>(() => new DurableCoreOperationApplyAuthorizationLedgerV1(root, 1));
        var ledger = new DurableCoreOperationApplyAuthorizationLedgerV1(Path.Combine(Path.GetTempPath(), "core-ledger-" + Guid.NewGuid().ToString("N")), 1);
        Assert.Throws<ArgumentException>(() => ledger.TryConsume("caller-authored"));
    }
}

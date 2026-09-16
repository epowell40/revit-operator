using System;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorActiveIdleLeaseTests
    {
        [Fact]
        public void DefaultIdleRemainsDefaultUntilAnActualApiCallbackCompletes()
        {
            long now = 0;
            var lease = new OperatorActiveIdleLease(() => now, 30_000);
            Assert.False(lease.IsActive);
            now = 1_000;
            lease.RecordActivity();
            now = 30_999;
            Assert.True(lease.IsActive);
            now = 31_000;
            Assert.False(lease.IsActive);
        }

        [Fact]
        public void SequentialOperationsBridgeProviderGapsThenReturnToNormalIdle()
        {
            long now = 0;
            var lease = new OperatorActiveIdleLease(() => now, 30_000);
            lease.RecordActivity();
            now = 20_000;
            Assert.True(lease.IsActive);
            lease.RecordActivity();
            now = 49_999;
            Assert.True(lease.IsActive);
            now = 50_000;
            Assert.False(lease.IsActive);
        }

        [Fact]
        public void ShutdownRevokesActivityAndCannotBeRenewed()
        {
            long now = 0;
            var lease = new OperatorActiveIdleLease(() => now, 30_000);
            lease.RecordActivity();
            lease.Stop();
            Assert.False(lease.IsActive);
            now = 1_000;
            lease.RecordActivity();
            Assert.False(lease.IsActive);
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(60_001)]
        public void InvalidOrUnboundedLeaseDurationsAreRejected(int duration)
            => Assert.Throws<ArgumentOutOfRangeException>(() => new OperatorActiveIdleLease(() => 0, duration));
    }
}

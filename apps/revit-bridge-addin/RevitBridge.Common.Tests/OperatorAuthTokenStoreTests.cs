using RevitBridge.Common;
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorAuthTokenStoreTests
    {
        [Fact]
        public void SaveLoadClear_RoundTripsDpapiProtectedTokens()
        {
            var dir = Path.Combine(Path.GetTempPath(), "revitoperator-tests", Guid.NewGuid().ToString("N"));
            var file = Path.Combine(dir, "auth-cache.bin");

            var expected = new OperatorAuthTokenSet
            {
                AccessToken = "access-token-sample",
                RefreshToken = "refresh-token-sample",
                AccessTokenExpiresAtUtc = DateTime.UtcNow.AddMinutes(25),
                RefreshTokenExpiresAtUtc = DateTime.UtcNow.AddDays(7),
                LastRefreshUtc = DateTime.UtcNow,
                UserId = "user-123",
                Email = "user@example.com",
                Audience = "operator",
                Issuer = "https://auth.example.com"
            };

            try
            {
                Assert.True(OperatorAuthTokenStore.SaveToPath(file, expected));

                var loaded = OperatorAuthTokenStore.TryLoadFromPath(file);
                Assert.NotNull(loaded);
                Assert.Equal(expected.AccessToken, loaded!.AccessToken);
                Assert.Equal(expected.RefreshToken, loaded.RefreshToken);
                Assert.Equal(expected.UserId, loaded.UserId);
                Assert.Equal(expected.Email, loaded.Email);
                Assert.Equal(expected.Audience, loaded.Audience);
                Assert.Equal(expected.Issuer, loaded.Issuer);

                OperatorAuthTokenStore.ClearPath(file);
                Assert.Null(OperatorAuthTokenStore.TryLoadFromPath(file));
            }
            finally
            {
                try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); } catch { }
            }
        }

        [Fact]
        public async Task RefreshLease_SerializesCompetingRefreshers()
        {
            var dir = Path.Combine(Path.GetTempPath(), "revitoperator-tests", Guid.NewGuid().ToString("N"));
            var lockPath = Path.Combine(dir, "auth-cache.bin.refresh.lock");

            try
            {
                using var first = await OperatorAuthTokenStore.AcquireRefreshLeaseAtPathAsync(
                    lockPath,
                    timeoutMilliseconds: 2_000,
                    staleAfterMilliseconds: 10_000,
                    CancellationToken.None);

                var secondTask = OperatorAuthTokenStore.AcquireRefreshLeaseAtPathAsync(
                    lockPath,
                    timeoutMilliseconds: 2_000,
                    staleAfterMilliseconds: 10_000,
                    CancellationToken.None);

                await Task.Delay(250);
                Assert.False(secondTask.IsCompleted);

                first.Dispose();
                using (var second = await secondTask)
                {
                    Assert.True(File.Exists(lockPath));
                }
            }
            finally
            {
                try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); } catch { }
            }
        }
    }
}

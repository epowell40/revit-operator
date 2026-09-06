using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    internal sealed class WriteGrantFixture : IDisposable
    {
        internal readonly string DirectoryPath = Path.Combine(Path.GetTempPath(), "operator-grant-test-" + Guid.NewGuid().ToString("N"));
        internal DateTime Now = new DateTime(2026, 9, 6, 4, 0, 0, DateTimeKind.Utc);
        internal string FilePath => Path.Combine(DirectoryPath, "write_grant.json");
        internal OperatorWriteGrantStore Store { get; }
        internal WriteGrantFixture()
        {
            Directory.CreateDirectory(DirectoryPath);
            Store = NewReader();
        }
        internal OperatorWriteGrantStore NewReader() => new OperatorWriteGrantStore(FilePath, "isolated-native-test-token", () => Now);
        public void Dispose() => Directory.Delete(DirectoryPath, true);
    }

    public class OperatorWriteGrantRenewalTests
    {
        [Fact]
        public async Task Concurrent_renewal_publishes_complete_signed_files_to_independent_readers()
        {
            using var f = new WriteGrantFixture();
            var token = f.Store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15)).Token;
            var writer = Task.Run(() => { for (int i = 0; i < 40; ++i) f.NewReader().RenewSession(TimeSpan.FromMinutes(15)); });
            var reader = Task.Run(() =>
            {
                for (int i = 0; i < 100; ++i)
                    Assert.True(f.NewReader().ValidateAndConsumeIfNeeded(token, out var error), error);
            });
            await Task.WhenAll(writer, reader);
            Assert.Single(Directory.GetFiles(f.DirectoryPath));
        }

        [Fact]
        public void Active_session_renewal_keeps_prepared_header_valid_for_another_reader()
        {
            using var f = new WriteGrantFixture();
            var original = f.Store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15));
            f.Now = f.Now.AddMinutes(14);
            var renewed = f.Store.RenewSession(TimeSpan.FromMinutes(15));
            Assert.Equal(original.Token, renewed.Token);
            Assert.True(renewed.ExpiresAtUtc > original.ExpiresAtUtc);
            Assert.True(f.NewReader().ValidateAndConsumeIfNeeded(original.Token, out var error), error);
            using var wire = JsonDocument.Parse(File.ReadAllText(f.FilePath));
            Assert.Equal("session", wire.RootElement.GetProperty("mode").GetString());
            Assert.Equal(JsonValueKind.Null, wire.RootElement.GetProperty("uses_remaining").ValueKind);
        }

        [Theory]
        [InlineData(OperatorWriteGrantMode.Once)]
        [InlineData(OperatorWriteGrantMode.Yolo)]
        public void A_different_mode_is_never_reused_as_a_session_token(OperatorWriteGrantMode mode)
        {
            using var f = new WriteGrantFixture();
            var original = f.Store.Issue(mode, TimeSpan.FromMinutes(15));
            var renewed = f.Store.RenewSession(TimeSpan.FromMinutes(15));
            Assert.NotEqual(original.Token, renewed.Token);
            Assert.False(f.NewReader().ValidateAndConsumeIfNeeded(original.Token, out _));
        }

        [Fact]
        public void Expired_or_tampered_session_is_not_extended_under_the_old_token()
        {
            using var f = new WriteGrantFixture();
            var old = f.Store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15));
            f.Now = f.Now.AddMinutes(15);
            var renewed = f.Store.RenewSession(TimeSpan.FromMinutes(15));
            Assert.NotEqual(old.Token, renewed.Token);
            File.WriteAllText(f.FilePath, File.ReadAllText(f.FilePath).Replace(renewed.Token, "tampered-token"));
            Assert.False(f.Store.ReadStatus().Active);
            var recovered = f.Store.RenewSession(TimeSpan.FromMinutes(15));
            Assert.NotEqual("tampered-token", recovered.Token);
            Assert.NotEqual(renewed.Token, recovered.Token);
        }
    }
}

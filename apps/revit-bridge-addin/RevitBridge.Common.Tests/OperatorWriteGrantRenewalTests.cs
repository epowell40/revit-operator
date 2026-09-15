using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
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
        public void Renewal_keeps_the_published_name_available_while_an_old_reader_holds_its_file()
        {
            using var f = new WriteGrantFixture();
            var original = f.Store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15));
            using (var oldReader = new FileStream(f.FilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                for (int i = 0; i < 20; ++i)
                {
                    f.Now = f.Now.AddSeconds(1);
                    var renewed = f.NewReader().RenewSession(TimeSpan.FromMinutes(15));
                    Assert.Equal(original.Token, renewed.Token);
                    Assert.True(f.NewReader().ValidateAndConsumeIfNeeded(original.Token, out var error), error);
                    using var current = JsonDocument.Parse(File.ReadAllText(f.FilePath));
                    Assert.Equal(renewed.ExpiresAtUtc!.Value.ToString("o"), current.RootElement.GetProperty("expires_at_utc").GetString());
                }
                using var previous = JsonDocument.Parse(oldReader);
                Assert.Equal(original.ExpiresAtUtc!.Value.ToString("o"), previous.RootElement.GetProperty("expires_at_utc").GetString());
            }
            Assert.Single(Directory.GetFiles(f.DirectoryPath));
        }

        [Fact]
        public async Task Multiple_independent_readers_retain_authority_during_sustained_renewal()
        {
            using var f = new WriteGrantFixture();
            using var start = new ManualResetEventSlim(false);
            var token = f.Store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15)).Token;
            var writer = Task.Run(() =>
            {
                start.Wait();
                for (int i = 0; i < 300; ++i) Assert.Equal(token, f.NewReader().RenewSession(TimeSpan.FromMinutes(15)).Token);
            });
            var readers = Enumerable.Range(0, 4).Select(_ => Task.Run(() =>
            {
                start.Wait();
                for (int i = 0; i < 500; ++i)
                {
                    // Direct readers must see one complete publication without
                    // relying on the native reader's bounded I/O retry window.
                    using (var stream = new FileStream(f.FilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (var wire = JsonDocument.Parse(stream))
                        Assert.Equal(token, wire.RootElement.GetProperty("token").GetString());
                    Assert.True(f.NewReader().ValidateAndConsumeIfNeeded(token, out var error), error);
                }
            })).ToArray();
            start.Set();
            await Task.WhenAll(readers.Append(writer));
            Assert.Single(Directory.GetFiles(f.DirectoryPath));
        }

        [Fact]
        public void Failed_publication_preserves_the_previous_grant_and_cleans_the_temporary_file()
        {
            using var f = new WriteGrantFixture();
            var original = f.Store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15));
            var before = File.ReadAllBytes(f.FilePath);
            File.SetAttributes(f.FilePath, FileAttributes.ReadOnly);
            try
            {
                f.Now = f.Now.AddMinutes(1);
                Assert.Throws<IOException>(() => f.Store.RenewSession(TimeSpan.FromMinutes(15)));
                Assert.Equal(before, File.ReadAllBytes(f.FilePath));
                Assert.Equal(original.ExpiresAtUtc, f.NewReader().ReadStatus().ExpiresAtUtc);
                Assert.True(f.NewReader().ValidateAndConsumeIfNeeded(original.Token, out var error), error);
                Assert.Single(Directory.GetFiles(f.DirectoryPath));
            }
            finally { File.SetAttributes(f.FilePath, FileAttributes.Normal); }
        }

        [Fact]
        public void Unicode_workspace_path_publishes_and_renews_the_exact_target()
        {
            using var f = new WriteGrantFixture();
            var directory = Path.Combine(f.DirectoryPath, "Engineering \u00e9 \u5de5\u7a0b");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, "write_grant.json");
            var store = new OperatorWriteGrantStore(path, "isolated-native-test-token", () => f.Now);
            var original = store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15));
            f.Now = f.Now.AddMinutes(1);
            Assert.Equal(original.Token, store.RenewSession(TimeSpan.FromMinutes(15)).Token);
            Assert.True(store.ValidateAndConsumeIfNeeded(original.Token, out var error), error);
            Assert.Equal(path, Assert.Single(Directory.GetFiles(directory)));
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

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorDesktopLauncherTests
    {
        [Fact]
        public void ResolveLauncherPath_PrefersConfiguredPathAndSearchesFromAddinAssemblyDirectory()
        {
            const string configured = @"C:\Configured\launch.cmd";
            const string repository = @"C:\Repo\operator-desktop\scripts\launch_operator_desktop.cmd";
            var existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                configured,
                repository
            };

            var resolved = OperatorDesktopLauncher.ResolveLauncherPath(
                configured,
                @"C:\Local",
                @"C:\Desktop",
                @"C:\Repo\public\apps\revit-bridge-addin\RevitBridge\bin\Release\RevitBridge.dll",
                existing.Contains);

            Assert.Equal(configured, resolved);
        }

        [Fact]
        public void ResolveLauncherPath_FindsRepositoryRelativeToAddinAssembly()
        {
            const string repository = @"C:\Repo\operator-desktop\scripts\launch_operator_desktop.cmd";
            var resolved = OperatorDesktopLauncher.ResolveLauncherPath(
                "",
                @"C:\Local",
                @"C:\Desktop",
                @"C:\Repo\public\apps\revit-bridge-addin\RevitBridge\bin\Release\RevitBridge.dll",
                candidate => string.Equals(candidate, repository, StringComparison.OrdinalIgnoreCase));

            Assert.Equal(repository, resolved);
        }

        [Fact]
        public void TryLaunch_FailsWhenLauncherAndSidecarAreMissing()
        {
            var runtime = Runtime(
                _ => throw new InvalidOperationException("launcher should not be called"));

            var launched = OperatorDesktopLauncher.TryLaunch(null, runtime, out var detail);

            Assert.False(launched);
            Assert.Contains("No Operator Desktop launcher was found", detail);
            Assert.Contains("No inline liveness or browser I/O", detail);
        }

        [Fact]
        public void TryLaunch_NoLauncherFailsClosedWithoutInvokingDispatch()
        {
            var dispatchCalled = false;
            var runtime = Runtime(
                _ =>
                {
                    dispatchCalled = true;
                    return OperatorDesktopDispatchResult.DispatchAccepted("unexpected");
                });

            var launched = OperatorDesktopLauncher.TryLaunch(null, runtime, out var detail);

            Assert.False(launched);
            Assert.False(dispatchCalled);
            Assert.Contains("install the workstation package", detail, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void TryLaunch_ReportsDispatchFailure()
        {
            var runtime = Runtime(
                _ => OperatorDesktopDispatchResult.Rejected("access denied"));

            var launched = OperatorDesktopLauncher.TryLaunch(@"C:\Launcher.cmd", runtime, out var detail);

            Assert.False(launched);
            Assert.Contains("could not be dispatched", detail);
            Assert.Contains("access denied", detail);
        }

        [Fact]
        public void TryLaunch_AcceptsDispatchWithoutClaimingReadinessOrPerformingInlineIo()
        {
            var runtime = Runtime(
                _ => OperatorDesktopDispatchResult.DispatchAccepted("launch-123"));

            var launched = OperatorDesktopLauncher.TryLaunch(@"C:\Launcher.cmd", runtime, out var detail);

            Assert.True(launched);
            Assert.Contains("dispatch accepted", detail, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("readiness is not yet claimed", detail, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("launch-123", detail);
        }

        [Fact]
        public async Task LateFailureReceipt_IsSurfacedExactlyOnceBeforeAnotherDispatch()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            store.Record("Launcher exited with code 7: C:\\Launcher.cmd.", "launch-a");
            await store.WaitForBackgroundIdleAsync();
            var dispatches = 0;
            var runtime = Runtime(
                _ => { dispatches++; return OperatorDesktopDispatchResult.DispatchAccepted("launch-b"); },
                receipts: store);

            var launched = OperatorDesktopLauncher.TryLaunch(@"C:\Launcher.cmd", runtime, out var detail);

            Assert.False(launched);
            Assert.Equal(0, dispatches);
            Assert.Contains("prior Operator Desktop launch requires attention", detail, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("code 7", detail);

            launched = OperatorDesktopLauncher.TryLaunch(@"C:\Launcher.cmd", runtime, out detail);

            Assert.True(launched);
            Assert.Equal(1, dispatches);
            Assert.DoesNotContain("prior Operator Desktop launch requires attention", detail, StringComparison.OrdinalIgnoreCase);
        }

        [Theory]
        [InlineData(true, 7, false, "exited with code 7")]
        [InlineData(true, 0, false, "liveness was not observed")]
        [InlineData(false, 0, false, "within 30 seconds")]
        public void GetObservedLaunchFailure_FailsClosedForExitAndTimeoutCases(
            bool exited,
            int exitCode,
            bool sidecarLive,
            string expected)
        {
            var failure = OperatorDesktopLauncher.GetObservedLaunchFailure(
                @"C:\Launcher.cmd",
                exited,
                exitCode,
                sidecarLive);

            Assert.NotNull(failure);
            Assert.Contains(expected, failure!, StringComparison.OrdinalIgnoreCase);
        }

        [Theory]
        [InlineData(true, 0, true)]
        [InlineData(false, 0, true)]
        public void GetObservedLaunchFailure_AcceptsOnlyObservedLivenessWithoutFailure(
            bool exited,
            int exitCode,
            bool sidecarLive)
        {
            Assert.Null(OperatorDesktopLauncher.GetObservedLaunchFailure(
                @"C:\Launcher.cmd",
                exited,
                exitCode,
                sidecarLive));
        }

        [Fact]
        public void BuildLauncherStartInfo_UsesPowerShellForPs1()
        {
            var info = OperatorDesktopLauncher.BuildLauncherStartInfo(
                @"C:\Operator Desktop\launch.ps1",
                @"C:\Windows\powershell.exe",
                @"C:\Windows\cmd.exe");

            Assert.Equal(@"C:\Windows\powershell.exe", info.FileName);
            Assert.Contains("-NoProfile", info.Arguments);
            Assert.Contains("\"C:\\Operator Desktop\\launch.ps1\"", info.Arguments);
            Assert.False(info.UseShellExecute);
            Assert.True(info.CreateNoWindow);
        }

        [Fact]
        public void BuildLauncherStartInfo_UsesCommandInterpreterForCmd()
        {
            var info = OperatorDesktopLauncher.BuildLauncherStartInfo(
                @"C:\Operator Desktop\launch.cmd",
                @"C:\Windows\powershell.exe",
                @"C:\Windows\cmd.exe");

            Assert.Equal(@"C:\Windows\cmd.exe", info.FileName);
            Assert.Equal("/D /S /C \"\"C:\\Operator Desktop\\launch.cmd\"\"", info.Arguments);
            Assert.False(info.UseShellExecute);
            Assert.True(info.CreateNoWindow);
        }

        [Fact]
        public void BuildLauncherStartInfo_UsesShellOnlyForShortcut()
        {
            var info = OperatorDesktopLauncher.BuildLauncherStartInfo(@"C:\Operator Desktop\launch.lnk");

            Assert.Equal(@"C:\Operator Desktop\launch.lnk", info.FileName);
            Assert.True(info.UseShellExecute);
            Assert.Equal(ProcessWindowStyle.Hidden, info.WindowStyle);
        }

        [Fact]
        public void BuildLauncherStartInfo_RejectsUnsupportedExtensions()
        {
            var ex = Assert.Throws<NotSupportedException>(() =>
                OperatorDesktopLauncher.BuildLauncherStartInfo(@"C:\Operator Desktop\launch.exe"));

            Assert.Contains(".ps1, .cmd, or .lnk", ex.Message);
        }

        [Fact]
        public async Task ReadBoundedResponse_RejectsBodyBeyondLimit()
        {
            using var allowed = new MemoryStream(Encoding.UTF8.GetBytes("1234"));
            using var oversized = new MemoryStream(Encoding.UTF8.GetBytes("12345"));

            Assert.Equal(
                "1234",
                await OperatorDesktopLauncher.ReadBoundedResponseAsync(allowed, 4, CancellationToken.None));
            Assert.Null(
                await OperatorDesktopLauncher.ReadBoundedResponseAsync(oversized, 4, CancellationToken.None));
        }

        [Fact]
        public async Task ReadBoundedResponseAsync_EnforcesOneDeadlineAcrossSlowTrickle()
        {
            using var stream = new SlowTrickleStream(Encoding.UTF8.GetBytes("123456"), 75);
            using var deadline = new CancellationTokenSource(140);
            var stopwatch = Stopwatch.StartNew();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                OperatorDesktopLauncher.ReadBoundedResponseAsync(stream, 32, deadline.Token));

            Assert.InRange(stopwatch.ElapsedMilliseconds, 50, 1000);
        }

        [Fact]
        public async Task FailureReceipts_AggregateConcurrentIndependentStoresWithoutLostWrites()
        {
            var memory = new SharedReceipt();
            var first = memory.CreateStore("instance-a", () => memory.Now);
            var second = memory.CreateStore("instance-b", () => memory.Now);
            await Task.WhenAll(first.WaitForBackgroundIdleAsync(), second.WaitForBackgroundIdleAsync());
            using var gate = new ManualResetEventSlim(false);

            var firstWrite = Task.Run(() => { gate.Wait(); first.Record("failure-a", "launch-a"); });
            var secondWrite = Task.Run(() => { gate.Wait(); second.Record("failure-b", "launch-b"); });
            gate.Set();
            await Task.WhenAll(firstWrite, secondWrite);
            await Task.WhenAll(first.WaitForBackgroundIdleAsync(), second.WaitForBackgroundIdleAsync());

            var consumer = memory.CreateStore("instance-c", () => memory.Now);
            await consumer.WaitForBackgroundIdleAsync();
            Assert.True(first.TryTake(out var firstAggregate));
            Assert.True(second.TryTake(out var secondAggregate));
            var aggregate = firstAggregate + Environment.NewLine + secondAggregate;
            Assert.Contains("[instance-a/launch-a] failure-a", aggregate);
            Assert.Contains("[instance-b/launch-b] failure-b", aggregate);
            Assert.False(consumer.TryTake(out _));
        }

        [Fact]
        public async Task FailureReceipts_ExpireStaleEntriesBeforeSurfacing()
        {
            var memory = new SharedReceipt();
            var oldTime = memory.Now.Subtract(TimeSpan.FromHours(25));
            var old = memory.CreateStore("old-instance", () => oldTime);
            old.Record("stale failure", "old-launch");
            await old.WaitForBackgroundIdleAsync();

            var current = memory.CreateStore("current-instance", () => memory.Now);
            await current.WaitForBackgroundIdleAsync();

            Assert.False(current.TryTake(out var message));
            Assert.Equal("", message);
        }

        [Fact]
        public async Task TryLaunch_BlockedReceiptPreloadReturnsPromptlyWithoutDispatchThenSurfacesReceiptExactlyOnce()
        {
            var memory = new SharedReceipt();
            memory.RawJson = JsonSerializer.Serialize(new OperatorDesktopLaunchFailureReceiptEnvelope
            {
                Receipts = new List<OperatorDesktopLaunchFailureReceipt>
                {
                    new OperatorDesktopLaunchFailureReceipt
                    {
                        ReceiptId = "blocked-receipt",
                        InstanceId = "prior-instance",
                        LaunchId = "prior-launch",
                        Message = "delayed preload failure",
                        ObservedAtUtc = memory.Now.ToString("O")
                    }
                }
            });
            using var entered = new ManualResetEventSlim(false);
            using var release = new ManualResetEventSlim(false);
            memory.ReadOverride = () =>
            {
                entered.Set();
                release.Wait();
                return memory.RawJson;
            };
            var store = memory.CreateStore("blocked-instance", () => memory.Now);
            Assert.True(entered.Wait(TimeSpan.FromSeconds(2)));
            var dispatches = 0;
            var runtime = Runtime(
                _ =>
                {
                    dispatches++;
                    return OperatorDesktopDispatchResult.DispatchAccepted("launch-after-preload");
                },
                store);
            var stopwatch = Stopwatch.StartNew();

            try
            {
                var launched = OperatorDesktopLauncher.TryLaunch(@"C:\Launcher.cmd", runtime, out var detail);

                Assert.False(launched);
                Assert.InRange(stopwatch.ElapsedMilliseconds, 0, 250);
                Assert.Equal(0, dispatches);
                Assert.Contains("preload is still loading", detail, StringComparison.OrdinalIgnoreCase);
            }
            finally
            {
                release.Set();
                await store.WaitForBackgroundIdleAsync();
            }

            var surfaced = OperatorDesktopLauncher.TryLaunch(@"C:\Launcher.cmd", runtime, out var surfacedDetail);

            Assert.False(surfaced);
            Assert.Equal(0, dispatches);
            Assert.Contains("prior Operator Desktop launch requires attention", surfacedDetail, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("delayed preload failure", surfacedDetail);
            await store.WaitForBackgroundIdleAsync();

            var launchedAfterReceipt = OperatorDesktopLauncher.TryLaunch(@"C:\Launcher.cmd", runtime, out var launchDetail);

            Assert.True(launchedAfterReceipt);
            Assert.Equal(1, dispatches);
            Assert.DoesNotContain("delayed preload failure", launchDetail, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task FailureReceipts_ConcurrentNearLimitWritesRemainBoundedWithoutPruning()
        {
            var memory = new SharedReceipt();
            var stores = Enumerable.Range(0, 6)
                .Select(index => memory.CreateStore($"near-{index:D2}", () => memory.Now))
                .ToList();
            await Task.WhenAll(stores.Select(store => store.WaitForBackgroundIdleAsync()));
            using var gate = new ManualResetEventSlim(false);
            var writes = stores.Select((store, index) => Task.Run(() =>
            {
                gate.Wait();
                store.Record($"near-{index:D2}:" + new string('n', 900), $"launch-{index:D2}");
            })).ToList();
            gate.Set();
            await Task.WhenAll(writes);
            await Task.WhenAll(stores.Select(store => store.WaitForBackgroundIdleAsync()));

            var byteCount = Encoding.UTF8.GetByteCount(memory.RawJson!);
            var envelope = JsonSerializer.Deserialize<OperatorDesktopLaunchFailureReceiptEnvelope>(memory.RawJson!);
            Assert.InRange(byteCount, 6000, OperatorDesktopLaunchFailureReceiptStore.MaximumEnvelopeBytes);
            Assert.Equal(6, envelope!.Receipts.Count);
            Assert.True(memory.MaximumWrittenBytes <= OperatorDesktopLaunchFailureReceiptStore.MaximumEnvelopeBytes);
            Assert.DoesNotContain(stores, store => Drain(store).Any(message => message.IndexOf("pruned", StringComparison.OrdinalIgnoreCase) >= 0));
        }

        [Fact]
        public async Task FailureReceipts_ConcurrentOverLimitWritesPruneDeterministicallyBeforeEveryWrite()
        {
            var memory = new SharedReceipt();
            var stores = Enumerable.Range(0, 20)
                .Select(index => memory.CreateStore($"over-{index:D2}", () => memory.Now))
                .ToList();
            await Task.WhenAll(stores.Select(store => store.WaitForBackgroundIdleAsync()));
            using var gate = new ManualResetEventSlim(false);
            var writes = stores.Select((store, index) => Task.Run(() =>
            {
                gate.Wait();
                store.Record($"over-{index:D2}:" + new string('o', 1000), $"launch-{index:D2}");
            })).ToList();
            gate.Set();
            await Task.WhenAll(writes);
            await Task.WhenAll(stores.Select(store => store.WaitForBackgroundIdleAsync()));

            var byteCount = Encoding.UTF8.GetByteCount(memory.RawJson!);
            var envelope = JsonSerializer.Deserialize<OperatorDesktopLaunchFailureReceiptEnvelope>(memory.RawJson!);
            var surfaced = stores.SelectMany(Drain).ToList();
            Assert.True(byteCount <= OperatorDesktopLaunchFailureReceiptStore.MaximumEnvelopeBytes);
            Assert.True(memory.MaximumWrittenBytes <= OperatorDesktopLaunchFailureReceiptStore.MaximumEnvelopeBytes);
            Assert.True(envelope!.Receipts.Count <= OperatorDesktopLaunchFailureReceiptStore.MaximumEnvelopeEntries);
            Assert.Contains(surfaced, message => message.IndexOf("deterministically pruned", StringComparison.OrdinalIgnoreCase) >= 0);
        }

        [Fact]
        public async Task FailureReceipts_QuarantineOversizeInputWithoutTreatingItAsEmpty()
        {
            var memory = new SharedReceipt
            {
                RawJson = new string('x', OperatorDesktopLaunchFailureReceiptStore.MaximumEnvelopeBytes + 1)
            };
            var store = memory.CreateStore("oversize-instance", () => memory.Now);

            await store.WaitForBackgroundIdleAsync();

            Assert.Equal(1, memory.QuarantineCount);
            Assert.Null(memory.RawJson);
            Assert.True(store.TryTake(out var message));
            Assert.Contains("quarantined without overwrite", message, StringComparison.OrdinalIgnoreCase);
            Assert.True(Encoding.UTF8.GetByteCount(message) < OperatorDesktopLaunchFailureReceiptStore.MaximumEnvelopeBytes);
        }

        private static IEnumerable<string> Drain(OperatorDesktopLaunchFailureReceiptStore store)
        {
            while (store.TryTake(out var message)) yield return message;
        }

        private static OperatorDesktopLaunchRuntime Runtime(
            Func<string, OperatorDesktopDispatchResult> dispatch,
            OperatorDesktopLaunchFailureReceiptStore? receipts = null)
        {
            var store = receipts ?? new SharedReceipt().CreateStore("test-instance", () => DateTimeOffset.UtcNow);
            if (receipts == null) store.WaitForBackgroundIdleAsync().GetAwaiter().GetResult();
            return new OperatorDesktopLaunchRuntime(dispatch, store);
        }

        private sealed class SharedReceipt
        {
            private string? _json;
            private readonly string _mutexName = @"Local\RevitOperator.OperatorDesktopLaunchFailureReceipt.Tests." + Guid.NewGuid().ToString("N");

            public DateTimeOffset Now { get; } = new DateTimeOffset(2026, 7, 28, 12, 0, 0, TimeSpan.Zero);
            public Func<string?>? ReadOverride { get; set; }
            public int QuarantineCount { get; private set; }
            public int MaximumWrittenBytes { get; private set; }
            public string? RawJson { get => _json; set => _json = value; }

            public OperatorDesktopLaunchFailureReceiptStore CreateStore(
                string instanceId,
                Func<DateTimeOffset> utcNow)
                => new OperatorDesktopLaunchFailureReceiptStore(
                    () => ReadOverride != null ? ReadOverride() : _json,
                    json =>
                    {
                        _json = json;
                        MaximumWrittenBytes = Math.Max(MaximumWrittenBytes, Encoding.UTF8.GetByteCount(json));
                    },
                    _ =>
                    {
                        QuarantineCount++;
                        _json = null;
                    },
                    _mutexName,
                    instanceId,
                    utcNow,
                    TimeSpan.FromHours(24));
        }

        private sealed class SlowTrickleStream : Stream
        {
            private readonly byte[] _bytes;
            private readonly int _delayMilliseconds;
            private int _offset;

            public SlowTrickleStream(byte[] bytes, int delayMilliseconds)
            {
                _bytes = bytes;
                _delayMilliseconds = delayMilliseconds;
            }

            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => _bytes.Length;
            public override long Position { get => _offset; set => throw new NotSupportedException(); }

            public override async Task<int> ReadAsync(
                byte[] buffer,
                int offset,
                int count,
                CancellationToken cancellationToken)
            {
                await Task.Delay(_delayMilliseconds, cancellationToken);
                if (_offset >= _bytes.Length) return 0;
                buffer[offset] = _bytes[_offset++];
                return 1;
            }

            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
            public override void Flush() { }
        }
    }
}

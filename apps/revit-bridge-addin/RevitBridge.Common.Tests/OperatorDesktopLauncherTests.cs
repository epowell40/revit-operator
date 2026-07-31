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
            Assert.Contains("surfaced in Revit", detail, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task ObservedFailure_IsDurableBeforeAcceptedReporterAndAwaitsAcknowledgement()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            OperatorDesktopPersistedFailure? reported = null;

            OperatorDesktopLauncher.ReportOrPersistObservedFailure(
                "launcher exited with code 7",
                "launch-a",
                store,
                failure =>
                {
                    reported = failure;
                    Assert.Contains("launcher exited with code 7", memory.RawJson ?? "", StringComparison.OrdinalIgnoreCase);
                    return true;
                });
            await store.WaitForBackgroundIdleAsync();

            Assert.NotNull(reported);
            Assert.Equal("launch-a", reported!.LaunchId);
            Assert.False(store.TryTake(out _));
            var envelope = JsonSerializer.Deserialize<OperatorDesktopLaunchFailureReceiptEnvelope>(memory.RawJson!);
            Assert.Single(envelope!.Receipts);
            Assert.Equal(reported.ReceiptId, envelope.Receipts[0].ReceiptId);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public async Task ObservedFailure_PersistsForNextClickWhenLiveReporterCannotAcceptIt(bool reporterThrows)
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();

            OperatorDesktopLauncher.ReportOrPersistObservedFailure(
                "launcher failed after dispatch",
                "launch-a",
                store,
                _ => reporterThrows
                    ? throw new InvalidOperationException("Revit is closing")
                    : false);
            await store.WaitForBackgroundIdleAsync();

            Assert.True(store.TryTake(out var failure));
            Assert.Contains("launcher failed after dispatch", failure, StringComparison.OrdinalIgnoreCase);
            Assert.False(store.TryTake(out _));
        }

        [Fact]
        public async Task DelayedFailureBuffer_AcceptedButNeverExecutedRemainsDurableAcrossShutdown()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            var buffer = new OperatorDesktopDelayedFailureBuffer(store);
            var raises = 0;
            var disposals = 0;
            var delivery = new OperatorDesktopDelayedFailureDelivery(
                buffer,
                () =>
                {
                    raises++;
                    return OperatorDesktopDelayedFailureRaiseResult.Accepted;
                },
                () => disposals++);
            var persisted = store.PersistForNotification("accepted but never executed", "launch-a");

            Assert.True(delivery.TryReport(persisted));
            Assert.Equal(1, raises);
            Assert.False(store.TryTake(out _));
            delivery.Dispose();
            delivery.Dispose();
            Assert.Equal(1, disposals);

            var nextInstance = memory.CreateStore("instance-b", () => memory.Now);
            await nextInstance.WaitForBackgroundIdleAsync();
            Assert.True(nextInstance.TryTake(out var failure));
            Assert.Contains("accepted but never executed", failure, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public async Task DelayedFailureDelivery_PendingThenDeniedSurfacesOneCoalescedFallback()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            var buffer = new OperatorDesktopDelayedFailureBuffer(store);
            var raiseResults = new Queue<OperatorDesktopDelayedFailureRaiseResult>(new[]
            {
                OperatorDesktopDelayedFailureRaiseResult.Pending,
                OperatorDesktopDelayedFailureRaiseResult.Denied
            });
            var retryGate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var delivery = new OperatorDesktopDelayedFailureDelivery(
                buffer,
                () => raiseResults.Dequeue(),
                () => { },
                _ => retryGate.Task);
            Assert.True(delivery.TryReport(store.PersistForNotification("denied-a", "launch-a")));
            Assert.True(delivery.TryReport(store.PersistForNotification("denied-b", "launch-b")));

            retryGate.TrySetResult(true);
            await delivery.WaitForRetryIdleAsync();

            Assert.Empty(raiseResults);
            Assert.True(store.TryTake(out var failure));
            Assert.Contains("denied-a", failure);
            Assert.Contains("denied-b", failure);
            Assert.False(store.TryTake(out _));
        }

        [Fact]
        public async Task DelayedFailureDelivery_ShutdownDisposesOnceAndReleasesNewReportsForNextInstance()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            var buffer = new OperatorDesktopDelayedFailureBuffer(store);
            var disposals = 0;
            var delivery = new OperatorDesktopDelayedFailureDelivery(
                buffer,
                () => OperatorDesktopDelayedFailureRaiseResult.Accepted,
                () => disposals++);
            delivery.Dispose();
            delivery.Dispose();
            var afterShutdown = store.PersistForNotification("arrived during shutdown", "launch-shutdown");

            Assert.True(delivery.TryReport(afterShutdown));
            Assert.Equal(1, disposals);
            Assert.False(store.TryTake(out _));

            var nextInstance = memory.CreateStore("instance-b", () => memory.Now);
            await nextInstance.WaitForBackgroundIdleAsync();
            Assert.True(nextInstance.TryTake(out var failure));
            Assert.Contains("arrived during shutdown", failure);
        }

        [Fact]
        public async Task DelayedFailureDelivery_ShutdownDisposesRaiseTargetWhenReceiptReleaseThrows()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            var buffer = new OperatorDesktopDelayedFailureBuffer(
                store,
                release: _ => throw new IOException("receipt file is locked"));
            var disposals = 0;
            var delivery = new OperatorDesktopDelayedFailureDelivery(
                buffer,
                () => OperatorDesktopDelayedFailureRaiseResult.Accepted,
                () => disposals++);
            Assert.True(delivery.TryReport(store.PersistForNotification("pending at shutdown", "launch-a")));

            delivery.Dispose();
            delivery.Dispose();

            Assert.Equal(1, disposals);
        }

        [Fact]
        public async Task DelayedFailureDelivery_BlockedRaiseIsSerializedBeforeShutdownDispose()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            var buffer = new OperatorDesktopDelayedFailureBuffer(store);
            var raiseEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var releaseRaise = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var disposed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var delivery = new OperatorDesktopDelayedFailureDelivery(
                buffer,
                () =>
                {
                    raiseEntered.TrySetResult(true);
                    releaseRaise.Task.GetAwaiter().GetResult();
                    return OperatorDesktopDelayedFailureRaiseResult.Accepted;
                },
                () => disposed.TrySetResult(true));
            var persisted = store.PersistForNotification("blocked raise", "launch-a");

            var reportTask = Task.Run(() => delivery.TryReport(persisted));
            await raiseEntered.Task;
            var disposeTask = Task.Run(delivery.Dispose);
            await Task.Delay(25);
            Assert.False(disposed.Task.IsCompleted);

            releaseRaise.TrySetResult(true);
            await Task.WhenAll(reportTask, disposeTask);
            Assert.True(disposed.Task.IsCompleted);
        }

        [Fact]
        public async Task DelayedFailureDelivery_ConcurrentReportsRemainBoundedAndAggregateOneDialog()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            var buffer = new OperatorDesktopDelayedFailureBuffer(store);
            var raises = 0;
            var delivery = new OperatorDesktopDelayedFailureDelivery(
                buffer,
                () =>
                {
                    Interlocked.Increment(ref raises);
                    return OperatorDesktopDelayedFailureRaiseResult.Accepted;
                },
                () => { });

            await Task.WhenAll(Enumerable.Range(0, 64).Select(index => Task.Run(() =>
            {
                var persisted = store.PersistForNotification($"failure-{index:D2}", $"launch-{index:D2}");
                Assert.True(delivery.TryReport(persisted));
            })));

            var displays = 0;
            var displayMessage = "";
            delivery.Execute(message =>
            {
                displays++;
                displayMessage = message;
                return true;
            });
            await buffer.WaitForCompletionIdleAsync();

            Assert.Equal(1, raises);
            Assert.Equal(1, displays);
            Assert.Contains("additional launch failures were coalesced", displayMessage, StringComparison.OrdinalIgnoreCase);
            Assert.InRange(displayMessage.Length, 1, 4096);
            var envelope = JsonSerializer.Deserialize<OperatorDesktopLaunchFailureReceiptEnvelope>(memory.RawJson!);
            Assert.Empty(envelope!.Receipts);
        }

        [Fact]
        public async Task DelayedFailureDelivery_AcknowledgesReceiptExactlyOnceAfterSuccessfulDisplay()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            var buffer = new OperatorDesktopDelayedFailureBuffer(store);
            var delivery = new OperatorDesktopDelayedFailureDelivery(
                buffer,
                () => OperatorDesktopDelayedFailureRaiseResult.Accepted,
                () => { });
            var persisted = store.PersistForNotification("display exactly once", "launch-a");
            Assert.True(delivery.TryReport(persisted));
            var before = JsonSerializer.Deserialize<OperatorDesktopLaunchFailureReceiptEnvelope>(memory.RawJson!);
            Assert.Single(before!.Receipts);

            var displays = 0;
            delivery.Execute(_ =>
            {
                displays++;
                return true;
            });
            await buffer.WaitForCompletionIdleAsync();
            delivery.Execute(_ =>
            {
                displays++;
                return true;
            });

            Assert.Equal(1, displays);
            var after = JsonSerializer.Deserialize<OperatorDesktopLaunchFailureReceiptEnvelope>(memory.RawJson!);
            Assert.Empty(after!.Receipts);
            Assert.False(store.TryTake(out _));
        }

        [Fact]
        public async Task DelayedFailureDelivery_AcknowledgementFailureDoesNotWedgeAndSurfacesReceipt()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            var acknowledgementAttempts = 0;
            var raises = 0;
            var buffer = new OperatorDesktopDelayedFailureBuffer(
                store,
                acknowledge: _ =>
                {
                    acknowledgementAttempts++;
                    throw new IOException("receipt acknowledgement locked");
                });
            var delivery = new OperatorDesktopDelayedFailureDelivery(
                buffer,
                () =>
                {
                    raises++;
                    return OperatorDesktopDelayedFailureRaiseResult.Accepted;
                },
                () => { });
            Assert.True(delivery.TryReport(store.PersistForNotification("ack failure", "launch-a")));

            delivery.Execute(_ => true);
            await buffer.WaitForCompletionIdleAsync();

            Assert.Equal(1, acknowledgementAttempts);
            Assert.True(store.TryTake(out var surfaced));
            Assert.Contains("ack failure", surfaced);
            Assert.True(delivery.TryReport(store.PersistForNotification("second failure", "launch-b")));
            delivery.Execute(_ => true);
            await buffer.WaitForCompletionIdleAsync();
            Assert.Equal(2, raises);
        }

        [Fact]
        public async Task DelayedFailureDelivery_AcknowledgementDoesNotBlockExecuteThread()
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            var acknowledgementEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var releaseAcknowledgement = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var buffer = new OperatorDesktopDelayedFailureBuffer(
                store,
                acknowledge: _ =>
                {
                    acknowledgementEntered.TrySetResult(true);
                    releaseAcknowledgement.Task.GetAwaiter().GetResult();
                });
            var delivery = new OperatorDesktopDelayedFailureDelivery(
                buffer,
                () => OperatorDesktopDelayedFailureRaiseResult.Accepted,
                () => { });
            Assert.True(delivery.TryReport(store.PersistForNotification("slow acknowledgement", "launch-a")));

            delivery.Execute(_ => true);
            await acknowledgementEntered.Task;

            releaseAcknowledgement.TrySetResult(true);
            await buffer.WaitForCompletionIdleAsync();
        }

        [Theory]
        [InlineData("{ malformed")]
        [InlineData(null)]
        public async Task ReceiptStore_ShutdownCleanupFailureIsContainedAndSurfaced(string? malformedJson)
        {
            var memory = new SharedReceipt();
            var store = memory.CreateStore("instance-a", () => memory.Now);
            await store.WaitForBackgroundIdleAsync();
            memory.ReadOverride = malformedJson == null
                ? () => throw new IOException("receipt file is locked")
                : () => malformedJson;

            Assert.False(store.TryReleaseAllClaimsForInstance());
            Assert.True(store.TryTake(out var failure));
            Assert.Contains("shutdown cleanup failed", failure, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void InFlightLaunchGate_CoalescesConcurrentEntriesAndFencesShutdown()
        {
            var gate = new OperatorDesktopInFlightLaunchGate();
            var leases = new OperatorDesktopInFlightLaunchLease?[24];
            var owners = 0;
            Parallel.For(0, leases.Length, index =>
            {
                if (gate.TryEnter(out var lease)) Interlocked.Increment(ref owners);
                leases[index] = lease;
            });

            Assert.Equal(1, owners);
            var launchIds = leases.Where(lease => lease != null).Select(lease => lease!.LaunchId).Distinct().ToList();
            Assert.Single(launchIds);
            foreach (var lease in leases) lease?.Dispose();

            Assert.True(gate.TryEnter(out var finalLease));
            gate.Shutdown();
            finalLease!.Dispose();
            Assert.False(gate.TryEnter(out var shutdownLease));
            Assert.Null(shutdownLease);
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
        public async Task TryLaunch_BlockedReceiptPreloadWaitsOnceThenReturnsActionableFailureWithoutDispatch()
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
                Assert.InRange(
                    stopwatch.ElapsedMilliseconds,
                    OperatorDesktopLauncher.FirstClickPreloadWaitMilliseconds - 150,
                    OperatorDesktopLauncher.FirstClickPreloadWaitMilliseconds + 1000);
                Assert.Equal(0, dispatches);
                Assert.Contains("bounded", detail, StringComparison.OrdinalIgnoreCase);
                Assert.Contains("Start 'Operator Desktop'", detail, StringComparison.OrdinalIgnoreCase);
                Assert.Contains("reinstall", detail, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("Retry the command", detail, StringComparison.OrdinalIgnoreCase);
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

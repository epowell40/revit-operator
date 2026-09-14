using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorUiWakeSchedulerTests
    {
        [Fact]
        public void StalledDispatcherDoesNotSuppressIndependentHostMessages()
        {
            var callbacks = new List<Action>();
            var pending = true;
            var hostMessages = 0;
            var eventSignals = 0;
            var scheduler = new OperatorUiWakeScheduler(callbacks.Add, () => pending,
                () => eventSignals++, wakeMessageLoop: () => hostMessages++);
            Assert.True(scheduler.Request());
            Assert.False(scheduler.Request());
            Assert.Single(callbacks);
            Assert.Equal(2, hostMessages);
            Assert.Equal(0, eventSignals);
            callbacks[0]();
            Assert.Equal(1, eventSignals);
            pending = false;
            Assert.False(scheduler.Request());
            Assert.Equal(2, hostMessages);
            pending = true;
            scheduler.Stop();
            Assert.False(scheduler.Request());
            Assert.Equal(2, hostMessages);
        }

        [Fact]
        public void OneWakeFailureDoesNotSuppressTheOtherSignalOrRunWorkInline()
        {
            var messages = 0;
            var scheduler = new OperatorUiWakeScheduler(_ => throw new InvalidOperationException("dispatcher closed"),
                () => true, () => throw new Exception("must never run"), wakeMessageLoop: () => messages++);
            Assert.Throws<InvalidOperationException>(() => scheduler.Request());
            Assert.Equal(1, messages);
            Action? callback = null;
            var signals = 0;
            var errors = 0;
            scheduler = new OperatorUiWakeScheduler(action => callback = action, () => true, () => signals++,
                _ => errors++, () => throw new InvalidOperationException("window gone"));
            Assert.True(scheduler.Request());
            Assert.Equal(1, errors);
            Assert.Equal(0, signals);
            callback!();
            Assert.Equal(1, signals);
        }

        [Fact]
        public void StalledHostCoalescesRetriesWithoutRunningWorkOnRequester()
        {
            var callbacks = new List<Action>();
            var pending = true;
            var signals = 0;
            var scheduler = new OperatorUiWakeScheduler(callbacks.Add, () => pending, () => signals++);
            Parallel.For(0, 160, _ => scheduler.Request());
            Assert.Single(callbacks);
            Assert.Equal(0, signals);
            callbacks[0]();
            Assert.Equal(1, signals);
            Assert.True(scheduler.Request());
            Assert.Equal(2, callbacks.Count);
            pending = false;
            callbacks[1]();
            Assert.Equal(1, signals);
            Assert.False(scheduler.Request());
        }

        [Fact]
        public void CancellationAndShutdownSuppressAlreadyQueuedSignals()
        {
            Action? callback = null;
            var pending = true;
            var signals = 0;
            var scheduler = new OperatorUiWakeScheduler(a => callback = a, () => pending, () => signals++);
            Assert.True(scheduler.Request());
            pending = false;
            callback!();
            Assert.Equal(0, signals);
            pending = true;
            Assert.True(scheduler.Request());
            scheduler.Stop();
            callback!();
            Assert.Equal(0, signals);
            Assert.False(scheduler.Request());
        }

        [Fact]
        public void FailedWakeCannotFaultTheHostAndAllowsAnotherAttempt()
        {
            Action? callback = null;
            var errors = 0;
            var scheduler = new OperatorUiWakeScheduler(a => callback = a, () => true,
                () => throw new InvalidOperationException("host closing"), _ => errors++);
            scheduler.Request();
            callback!();
            Assert.Equal(1, errors);
            Assert.True(scheduler.Request());
        }

        [Fact]
        public void DispatcherFailureReleasesTheSignalSlotForRetry()
        {
            var attempts = 0;
            var signals = 0;
            var scheduler = new OperatorUiWakeScheduler(a =>
            {
                if (++attempts == 1) throw new InvalidOperationException("dispatcher unavailable");
                a();
            }, () => true, () => signals++);
            Assert.Throws<InvalidOperationException>(() => scheduler.Request());
            Assert.True(scheduler.Request());
            Assert.Equal(1, signals);
        }
    }
}

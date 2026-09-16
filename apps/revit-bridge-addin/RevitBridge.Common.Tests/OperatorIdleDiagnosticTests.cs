using System;
using System.IO;
using System.Threading.Tasks;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorIdleDiagnosticTests
    {
        [Fact]
        public void DistinguishesMissingCallbacksRunningCallbacksAndCompletedDuration()
        {
            long time = 100;
            var state = new OperatorIdleDiagnostic(() => time);
            Assert.Contains("idle_age_ms=none", state.Describe());
            state.Enter(true, true, false);
            time = 175;
            Assert.Contains("idle_age_ms=75 idle_in_callback=True", state.Describe());
            Assert.Contains("idle_ui_sender=True idle_pending=True idle_lease=False", state.Describe());
            state.Exit(); time = 300;
            Assert.Contains("idle_age_ms=200 idle_in_callback=False idle_last_duration_ms=75", state.Describe());
            state.Enter(false, false, true);
            try { throw new InvalidOperationException("callback failed"); }
            catch (InvalidOperationException) { }
            finally { state.Exit(); }
            Assert.Contains("idle_in_callback=False", state.Describe());
            Assert.Contains("idle_ui_sender=False idle_pending=False idle_lease=True", state.Describe());
        }

        [Fact]
        public void ConcurrentQueueReadersGetBoundedSnapshotsWithoutSchedulingAnything()
        {
            var state = new OperatorIdleDiagnostic(() => 500);
            Parallel.For(0, 2000, i => {
                if (i % 3 == 0) state.Enter(true, false, true);
                else if (i % 3 == 1) state.Exit();
                else Assert.InRange(state.Describe().Length, 1, 240);
            });
            state.Exit(); Assert.Contains("idle_in_callback=False", state.Describe());
        }

        [Fact]
        public void NativeCallbackAlwaysExitsAndQueueLoggingDoesNotDriveTheLease()
        {
            var root = new DirectoryInfo(AppContext.BaseDirectory);
            while (root != null && !Directory.Exists(Path.Combine(root.FullName, "RevitBridge", "Services"))) root = root.Parent;
            Assert.NotNull(root);
            var app = File.ReadAllText(Path.Combine(root!.FullName, "RevitBridge", "App.cs"));
            Assert.Contains("RecordIdleEntry(sender is UIApplication)", app);
            Assert.Contains("finally { instance._eventService?.RecordIdleExit(); }", app);
            var service = File.ReadAllText(Path.Combine(root.FullName, "RevitBridge", "Services", "RevitEventService.cs"));
            Assert.Contains("WriteQueueWithIdle(\"admitted\", diagnostic)", service);
            Assert.Contains("WriteQueueWithIdle(\"started\", item.Diagnostic)", service);
            Assert.Contains("WriteQueueWithIdle(\"released\", item.Diagnostic)", service);
            var common = File.ReadAllText(Path.Combine(root.FullName, "RevitBridge.Common", "OperatorIdleDiagnostic.cs"));
            Assert.DoesNotContain("RecordActivity", common);
            Assert.DoesNotContain("Autodesk.Revit", common);
            Assert.DoesNotContain("SetRaiseWithoutDelay", common);
        }
    }
}

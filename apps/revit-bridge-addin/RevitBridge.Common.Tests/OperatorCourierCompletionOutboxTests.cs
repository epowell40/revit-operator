using System;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorCourierCompletionOutboxTests
    {
        [Fact]
        public void Completion_survives_a_new_outbox_instance_until_acknowledged()
        {
            var root = Path.Combine(Path.GetTempPath(), "revit-courier-outbox-" + Guid.NewGuid().ToString("N"));
            try
            {
                var first = new OperatorCourierCompletionOutbox(root);
                first.Save("session-a", "job-a", "worker-a", new { status = "ok", count = 7 });

                var afterRestart = new OperatorCourierCompletionOutbox(root);
                var pending = Assert.Single(afterRestart.ReadPending());
                Assert.Equal("session-a", pending.SessionId);
                Assert.Equal("job-a", pending.JobId);
                Assert.Equal("worker-a", pending.ExecutorId);
                Assert.Equal("ok", pending.Result.GetProperty("status").GetString());
                Assert.Equal(7, pending.Result.GetProperty("count").GetInt32());

                afterRestart.Acknowledge("job-a");
                Assert.Empty(afterRestart.ReadPending());
            }
            finally
            {
                if (Directory.Exists(root)) Directory.Delete(root, true);
            }
        }

        [Fact]
        public void Invalid_identifiers_are_never_written_as_paths()
        {
            var root = Path.Combine(Path.GetTempPath(), "revit-courier-outbox-" + Guid.NewGuid().ToString("N"));
            var outbox = new OperatorCourierCompletionOutbox(root);
            Assert.Throws<ArgumentException>(() => outbox.Save("session-a", "../job", "worker-a", new { status = "ok" }));
            Assert.False(Directory.Exists(root));
        }

        [Fact]
        public void Unreadable_completion_evidence_remains_unresolved_and_is_not_executed()
        {
            var root = Path.Combine(Path.GetTempPath(), "revit-courier-outbox-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root, "job-a.json"), "not-json");
            var outbox = new OperatorCourierCompletionOutbox(root);
            Assert.Empty(outbox.ReadPending());
            Assert.True(outbox.HasUnresolvedEntries);
        }
    }
}

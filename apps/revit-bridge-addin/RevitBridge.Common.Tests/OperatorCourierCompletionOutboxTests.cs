using System;
using System.IO;
using System.Linq;
using System.Text.Json;
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

        [Fact]
        public void Small_completion_is_preserved_without_compaction()
        {
            var prepared = OperatorCourierResultCompactor.Prepare(new
            {
                status = "ok",
                count = 7,
                values = new[] { "a", "b" }
            });

            Assert.False(prepared.Compacted);
            Assert.Equal(prepared.OriginalResultBytes, prepared.TransportResultBytes);
            Assert.Equal("ok", prepared.Result.GetProperty("status").GetString());
            Assert.Equal(7, prepared.Result.GetProperty("count").GetInt32());
            Assert.False(prepared.Result.TryGetProperty("_operator_transport", out _));
        }

        [Fact]
        public void Json_text_completion_is_normalized_to_structured_result()
        {
            var prepared = OperatorCourierResultCompactor.Prepare("{\"status\":\"ok\",\"plannedToTag\":1}");

            Assert.False(prepared.Compacted);
            Assert.Equal(JsonValueKind.Object, prepared.Result.ValueKind);
            Assert.Equal("ok", prepared.Result.GetProperty("status").GetString());
            Assert.Equal(1, prepared.Result.GetProperty("plannedToTag").GetInt32());
        }

        [Fact]
        public void Plain_text_completion_remains_a_json_string()
        {
            var prepared = OperatorCourierResultCompactor.Prepare("not-json");

            Assert.False(prepared.Compacted);
            Assert.Equal(JsonValueKind.String, prepared.Result.ValueKind);
            Assert.Equal("not-json", prepared.Result.GetString());
        }

        [Fact]
        public void Oversized_completion_preserves_counts_and_emits_bounded_transport_receipt()
        {
            var rows = Enumerable.Range(0, 5000)
                .Select(index => new
                {
                    id = index,
                    category = "Mechanical Equipment",
                    value = new string((char)('A' + (index % 20)), 1800)
                })
                .ToArray();

            var prepared = OperatorCourierResultCompactor.Prepare(new
            {
                status = "ok",
                totalMatched = 5000,
                hasMore = true,
                nextOffset = 5000,
                rows
            });

            Assert.True(prepared.Compacted);
            Assert.True(prepared.OriginalResultBytes > 1_000_000);
            Assert.InRange(prepared.TransportResultBytes, 1, OperatorCourierResultCompactor.MaxTransportResultBytes);
            Assert.Equal("ok", prepared.Result.GetProperty("status").GetString());
            Assert.Equal(5000, prepared.Result.GetProperty("totalMatched").GetInt32());
            Assert.True(prepared.Result.GetProperty("hasMore").GetBoolean());
            Assert.Equal(5000, prepared.Result.GetProperty("nextOffset").GetInt32());

            var receipt = prepared.Result.GetProperty("_operator_transport");
            Assert.True(receipt.GetProperty("compacted").GetBoolean());
            Assert.True(receipt.GetProperty("requires_refinement_for_complete_rows").GetBoolean());
            Assert.True(receipt.GetProperty("omitted_array_items").GetInt32() > 0);
            Assert.Equal(prepared.OriginalResultBytes, receipt.GetProperty("original_result_bytes").GetInt32());
            Assert.Equal(prepared.TransportResultBytes, JsonSerializer.SerializeToUtf8Bytes(prepared.Result).Length);
            Assert.Equal(prepared.TransportResultBytes, receipt.GetProperty("transport_result_bytes").GetInt32());
        }

        [Fact]
        public void Signed_laboratory_result_is_never_compacted_away_from_its_native_signature()
        {
            using var document = JsonDocument.Parse(
                "{\"payload\":\"" + new string('x', OperatorCourierResultCompactor.MaxTransportResultBytes)
                + "\",\"laboratory_execution_receipt\":{\"schema\":\""
                + OperatorLaboratoryExecutionReceiptAuthority.Schema + "\"}}");
            var error = Assert.Throws<InvalidOperationException>(() =>
                OperatorCourierResultCompactor.Prepare(document.RootElement));
            Assert.Contains("cannot be compacted", error.Message, StringComparison.Ordinal);
        }

        [Fact]
        public void Oversized_durable_record_can_be_prepared_for_replay_under_backend_limit()
        {
            var root = Path.Combine(Path.GetTempPath(), "revit-courier-outbox-" + Guid.NewGuid().ToString("N"));
            try
            {
                var outbox = new OperatorCourierCompletionOutbox(root);
                outbox.Save("session-a", "job-a", "worker-a", new
                {
                    status = "ok",
                    count = 9000,
                    rows = Enumerable.Range(0, 9000).Select(index => new { id = index, payload = new string('x', 1024) }).ToArray()
                });

                var pending = Assert.Single(outbox.ReadPending());
                var prepared = OperatorCourierResultCompactor.Prepare(pending.Result);

                Assert.True(prepared.Compacted);
                Assert.InRange(prepared.TransportResultBytes, 1, OperatorCourierResultCompactor.MaxTransportResultBytes);
                Assert.Equal(9000, prepared.Result.GetProperty("count").GetInt32());
            }
            finally
            {
                if (Directory.Exists(root)) Directory.Delete(root, true);
            }
        }

        [Fact]
        public void Backend_terminal_conflict_is_preserved_as_resolved_evidence_without_starving_new_work()
        {
            var root = Path.Combine(Path.GetTempPath(), "revit-courier-outbox-" + Guid.NewGuid().ToString("N"));
            try
            {
                var outbox = new OperatorCourierCompletionOutbox(root);
                outbox.Save("session-a", "job-a", "worker-a", new { status = "late-success" });

                outbox.ResolveTerminalConflict(
                    "job-a",
                    "Revit courier job is already terminally failed; refusing a contradictory completion.");

                Assert.Empty(outbox.ReadPending());
                Assert.False(outbox.HasUnresolvedEntries);
                var evidencePath = Path.Combine(root, "job-a.json");
                Assert.True(File.Exists(evidencePath));
                using var evidence = JsonDocument.Parse(File.ReadAllText(evidencePath));
                Assert.Equal(
                    OperatorCourierCompletionOutbox.TerminalConflictDisposition,
                    evidence.RootElement.GetProperty("disposition").GetString());
                Assert.Equal(
                    "backend_terminal_failure_authoritative",
                    evidence.RootElement.GetProperty("resolution_code").GetString());
                Assert.Equal("late-success", evidence.RootElement.GetProperty("result").GetProperty("status").GetString());
            }
            finally
            {
                if (Directory.Exists(root)) Directory.Delete(root, true);
            }
        }

        [Fact]
        public void Legacy_record_without_disposition_remains_pending_after_upgrade()
        {
            var root = Path.Combine(Path.GetTempPath(), "revit-courier-outbox-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(root);
                File.WriteAllText(Path.Combine(root, "job-a.json"), JsonSerializer.Serialize(new
                {
                    version = OperatorCourierCompletionOutbox.RecordVersion,
                    session_id = "session-a",
                    job_id = "job-a",
                    executor_id = "worker-a",
                    completed_at = DateTime.UtcNow.ToString("o"),
                    result = new { status = "legacy" }
                }));

                var outbox = new OperatorCourierCompletionOutbox(root);
                Assert.Single(outbox.ReadPending());
                Assert.True(outbox.HasUnresolvedEntries);
            }
            finally
            {
                if (Directory.Exists(root)) Directory.Delete(root, true);
            }
        }
    }
}

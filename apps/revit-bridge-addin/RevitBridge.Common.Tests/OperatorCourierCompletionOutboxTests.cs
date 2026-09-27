using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorCourierCompletionOutboxTests
    {
        [Fact]
        public void DirectCompletionEligibilityExcludesOtherDocumentsAndUnreviewedHandlers()
        {
            Assert.True(OperatorNativeCompletionStore.SupportsRequestedEffect("apply"));
            Assert.True(OperatorNativeCompletionStore.SupportsRequestedEffect("preview"));
            Assert.False(OperatorNativeCompletionStore.SupportsRequestedEffect("read"));
            Assert.False(OperatorNativeCompletionStore.SupportsRequestedEffect("unknown"));
            foreach (var path in new[] { "/revit/move-elements", "/revit/rotate-elements", "/revit/delete", "/revit/set-parameter",
                "/revit/create-text", "/revit/place-families", "/revit/set-text-note-text", "/revit/replace-text-note" })
            {
                Assert.True(OperatorNativeCompletionStore.SupportsActiveDocument("POST", path, "{}"));
                Assert.True(OperatorNativeCompletionStore.SupportsActiveDocument("POST", path, "{\"docId\":null,\"familyDocumentId\":\" \"}"));
                foreach (var name in new[] { "docId", "familyDocumentId", "DOCID", "FamilyDocumentId" })
                    foreach (var value in new object[] { "family-session-B", 42, false, new object(), new[] { "B" } })
                        Assert.False(OperatorNativeCompletionStore.SupportsActiveDocument("POST", path,
                            JsonSerializer.Serialize(new Dictionary<string, object> { [name] = value })));
                Assert.False(OperatorNativeCompletionStore.SupportsActiveDocument("GET", path, "{}"));
                Assert.False(OperatorNativeCompletionStore.SupportsActiveDocument("POST", path, "[]"));
                Assert.False(OperatorNativeCompletionStore.SupportsActiveDocument("POST", path, "not-json"));
            }
            foreach (var path in new[] { "/revit/open-model", "/revit/close-active-model", "/revit/save-as", "/revit/open-family-doc",
                "/revit/save-family-doc", "/revit/load-family-doc", "/revit/close-doc", "/revit/edit-family-from-instance",
                "/revit/reload-family-edit-session", "/revit/create-family-from-template", "/revit/apply-family-evolution",
                "/revit/tag-elements", "/revit/dynamic-runtime/apply", "/revit/connect-existing-mep-branch", "/revit/future-writer" })
                Assert.False(OperatorNativeCompletionStore.SupportsActiveDocument("POST", path, "{}"));
        }

        [Theory]
        [InlineData("apply", "committed")]
        [InlineData("apply", "rolled_back")]
        [InlineData("apply", "pending")]
        [InlineData("preview", "committed")]
        [InlineData("preview", "rolled_back")]
        [InlineData("preview", "not_started")]
        [InlineData("preview", "pending")]
        public async Task DirectCompletionSurvivesCanceledWaiterAndProtectedLookupWithoutReplay(string requestedEffect, string state)
        {
            using var f = new DirectCompletionFixture(requestedEffect);
            var reservation = f.Reserve();
            var started = new TaskCompletionSource<bool>();
            var release = new TaskCompletionSource<bool>();
            var waiter = new TaskCompletionSource<OperatorNativeCompletionReply>();
            var calls = 0;
            var body = JsonSerializer.Serialize(new { text = "unicode café\r\n\"literal\"", requested_effect = requestedEffect, transaction = state });
            var callback = Task.Run(() =>
            {
                var response = OperatorNativeCompletionCapture.Execute(f.Store, reservation, () =>
                {
                    calls++; started.SetResult(true); release.Task.GetAwaiter().GetResult();
                    return new OperatorNativeCompletionReply(200, body);
                }, () => f.Document, "POST", "/revit/rotate-elements", f.Request.Request.RequestId, requestedEffect);
                waiter.TrySetResult(response);
                return response;
            });
            await started.Task;
            waiter.TrySetCanceled();
            Assert.Equal(202, f.Lookup().StatusCode);
            release.SetResult(true);
            Assert.Equal(body, (await callback).BodyJson);
            Assert.True(waiter.Task.IsCanceled);
            Assert.Equal(1, calls);
            var result = f.Lookup();
            Assert.Equal(200, result.StatusCode);
            var lookup = f.LookupContext();
            var wire = OperatorNativeTransportCodec.ProtectResponse(f.Token, lookup, result.StatusCode, result.BodyJson, DateTimeOffset.UtcNow);
            var opened = OperatorNativeTransportCodec.OpenResponse(f.Token, f.LastProtected!, Encoding.UTF8.GetBytes(wire), DateTimeOffset.UtcNow);
            Assert.Equal(result.BodyJson, opened.BodyJson);
            using var responseJson = JsonDocument.Parse(opened.BodyJson);
            var raw = responseJson.RootElement.GetProperty("record_json").GetString()!;
            Assert.Equal(OperatorNativeCompletionStore.Hash(raw), responseJson.RootElement.GetProperty("record_sha256").GetString());
            using var record = JsonDocument.Parse(raw);
            Assert.Equal(body, record.RootElement.GetProperty("terminal").GetProperty("body_json").GetString());
            Assert.Equal(OperatorNativeCompletionStore.Hash(body), record.RootElement.GetProperty("terminal").GetProperty("body_sha256").GetString());
            Assert.Equal(result.BodyJson, new OperatorNativeCompletionStore(f.Token, f.Epoch, f.Root).Lookup(f.LookupContext()).BodyJson);
            Assert.Equal(1, calls);
        }

        [Fact]
        public void DirectCompletionIsImmutableAndRejectsChangedSelectorsTamperingAndRestartEpoch()
        {
            using var f = new DirectCompletionFixture();
            var reservation = f.Reserve();
            var reply = new OperatorNativeCompletionReply(200, "{\"transaction\":{\"status\":\"committed\",\"committed\":true}}");
            f.Store.Complete(reservation, reply, f.Document);
            var original = f.Lookup().BodyJson;
            f.Store.Complete(reservation, reply, f.Document);
            Assert.Equal(original, f.Lookup().BodyJson);
            Assert.Throws<InvalidOperationException>(() => f.Store.Complete(reservation, new OperatorNativeCompletionReply(200, "{}"), f.Document));
            Assert.Throws<InvalidOperationException>(() => f.Reserve());
            foreach (var name in new[] { "request_nonce_sha256", "server_epoch", "method", "path", "source_body_sha256", "expected_document_fingerprint" })
                Assert.Equal(409, f.Lookup(values => values[name] = "changed").StatusCode);
            Assert.Equal(409, f.Lookup(values => values["body_present"] = false).StatusCode);
            Assert.Equal(409, f.Lookup(values => values["unexpected"] = true).StatusCode);
            Assert.Equal(404, f.Lookup(values => values["request_id"] = "not-retained").StatusCode);
            Assert.Equal(409, new OperatorNativeCompletionStore(f.Token, "new-native-epoch", f.Root).Lookup(f.LookupContext()).StatusCode);
            Assert.Equal(409, f.Store.Lookup(f.LookupContext(alias: "revit_call_tool", channel: "generic_call")).StatusCode);
            var file = Directory.GetFiles(f.Root, "*.json", SearchOption.AllDirectories).Single();
            File.WriteAllText(file, File.ReadAllText(file).Replace("committed", "rolled_back"));
            Assert.Equal(503, f.Lookup().StatusCode);
            File.WriteAllText(file, "{\"record_json\":null,\"signature\":null}");
            Assert.Equal(503, f.Lookup().StatusCode);
            File.WriteAllText(file, "not-json");
            Assert.Equal(503, f.Lookup().StatusCode);
            File.Delete(file);
            Assert.Equal(503, f.Lookup().StatusCode);
        }

        [Theory]
        [InlineData("apply")]
        [InlineData("preview")]
        public void DirectCompletionExceptionsStoreFailureAndChangedDocumentNeverInventNoEffect(string requestedEffect)
        {
            using var f = new DirectCompletionFixture(requestedEffect);
            var reservation = f.Reserve();
            var failure = Assert.Throws<OperatorNativeCompletionUncertainException>(() => OperatorNativeCompletionCapture.Execute(
                f.Store, reservation, () => throw new ArgumentException("after dispatch"), () => f.Document, "POST", "/revit/rotate-elements", "request", requestedEffect));
            Assert.True(failure.OutcomeUnknown);
            using var response = JsonDocument.Parse(f.Lookup().BodyJson);
            using var record = JsonDocument.Parse(response.RootElement.GetProperty("record_json").GetString()!);
            using var body = JsonDocument.Parse(record.RootElement.GetProperty("terminal").GetProperty("body_json").GetString()!);
            Assert.True(body.RootElement.GetProperty("outcome_unknown").GetBoolean());
            Assert.Equal("unknown", body.RootElement.GetProperty("canonical_attempt_settlement").GetProperty("effect_state").GetString());
            Assert.Equal(requestedEffect, body.RootElement.GetProperty("canonical_attempt_settlement").GetProperty("requested_effect").GetString());
            using var next = new DirectCompletionFixture(requestedEffect);
            var res = next.Reserve();
            var normal = OperatorNativeCompletionCapture.Execute(next.Store, res, () => new OperatorNativeCompletionReply(200, "{\"ok\":true}"),
                () => throw new InvalidOperationException("Document closed"), "POST", "/revit/rotate-elements", "request", requestedEffect);
            Assert.Equal("{\"ok\":true}", normal.BodyJson);
            using var changedResponse = JsonDocument.Parse(next.Lookup().BodyJson);
            using var changed = JsonDocument.Parse(changedResponse.RootElement.GetProperty("record_json").GetString()!);
            Assert.Equal(JsonValueKind.Null, changed.RootElement.GetProperty("document").GetProperty("after_document_session_id").ValueKind);
            using var full = new DirectCompletionFixture(requestedEffect);
            var fullReservation = full.Reserve();
            var epochDirectory = Directory.GetDirectories(full.Root).Single();
            Directory.Delete(epochDirectory);
            File.WriteAllText(epochDirectory, "blocks terminal file publication");
            Assert.Throws<OperatorNativeCompletionUncertainException>(() => OperatorNativeCompletionCapture.Execute(full.Store, fullReservation,
                () => new OperatorNativeCompletionReply(200, "{}"), () => full.Document, "POST", "/revit/rotate-elements", "request", requestedEffect));
        }

        private sealed class DirectCompletionFixture : IDisposable
        {
            internal string Token = "0123456789abcdef0123456789abcdef";
            internal string Epoch = Convert.ToBase64String(Enumerable.Range(0, 32).Select(i => (byte)i).ToArray()).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            internal string Root = Path.Combine(Path.GetTempPath(), "operator-direct-completion-" + Guid.NewGuid().ToString("N"));
            internal OperatorNativeCompletionDocument Document = new OperatorNativeCompletionDocument(new string('a', 64), "native-document-session");
            internal OperatorNativeCompletionStore Store;
            internal OperatorNativeTransportRequestContext Request;
            internal OperatorNativeTransportProtectedRequest? LastProtected;
            internal DirectCompletionFixture(string requestedEffect = "apply")
            {
                Store = new OperatorNativeCompletionStore(Token, Epoch, Root);
                var now = DateTimeOffset.UtcNow;
                var wire = OperatorNativeTransportCodec.ProtectRequest(Token, Epoch, "POST", "/revit/rotate-elements",
                    JsonSerializer.Serialize(new { ids = new[] { 42 }, dryRun = requestedEffect == "preview" }), "", now);
                Request = OperatorNativeTransportCodec.OpenRequest(Token, Epoch, Encoding.UTF8.GetBytes(wire.EnvelopeJson), "POST",
                    OperatorNativeTransportProtocol.TransportPath, false, now, new OperatorNativeTransportReplayCache());
            }
            internal OperatorNativeCompletionReservation Reserve()
            {
                var r = Request.Request;
                var auth = new OperatorNativeHttpAuthorizationReceipt(r.RequestId, r.Method, r.Path, r.BodyPresent, r.Channel, r.Alias,
                    r.SourceBodySha256, r.BodyJson, OperatorNativeCompletionStore.Hash(r.BodyJson), "general", DateTimeOffset.UtcNow,
                    DateTimeOffset.UtcNow.AddMinutes(1), "sha256:" + new string('b', 64));
                return Store.Reserve(Request, auth, r.BodyJson, Document);
            }
            internal OperatorNativeCompletionReply Lookup(Action<Dictionary<string, object?>>? change = null) => Store.Lookup(LookupContext(change));
            internal OperatorNativeTransportRequestContext LookupContext(Action<Dictionary<string, object?>>? change = null,
                string alias = OperatorNativeCompletionStore.LookupAlias, string channel = "typed_mcp")
            {
                var q = new Dictionary<string, object?> { ["schema"] = OperatorNativeCompletionStore.LookupSchema,
                    ["request_id"] = Request.Request.RequestId, ["request_nonce_sha256"] = OperatorNativeCompletionStore.Hash(Request.RequestNonce),
                    ["server_epoch"] = Epoch, ["method"] = Request.Request.Method, ["path"] = Request.Request.Path,
                    ["body_present"] = true, ["source_body_sha256"] = Request.Request.SourceBodySha256, ["expected_document_fingerprint"] = Document.Fingerprint };
                change?.Invoke(q);
                var now = DateTimeOffset.UtcNow;
                LastProtected = OperatorNativeTransportCodec.ProtectRequest(Token, Epoch, "POST", OperatorNativeCompletionStore.LookupPath,
                    JsonSerializer.Serialize(q), "", now, channel: channel, alias: alias);
                return OperatorNativeTransportCodec.OpenRequest(Token, Epoch, Encoding.UTF8.GetBytes(LastProtected.EnvelopeJson), "POST",
                    OperatorNativeTransportProtocol.TransportPath, false, now, new OperatorNativeTransportReplayCache());
            }
            public void Dispose() { if (Directory.Exists(Root)) Directory.Delete(Root, true); }
        }

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
        public void Oversized_element_inventory_preserves_complete_identifier_projection()
        {
            var elementIds = Enumerable.Range(1_400_000, 509).ToArray();
            var prepared = OperatorCourierResultCompactor.Prepare(new
            {
                status = "Ok",
                count = elementIds.Length,
                elementIds,
                items = elementIds.Select(elementId => new
                {
                    elementId,
                    category = "Air Terminals",
                    geometry = new string('x', 4_000)
                }).ToArray(),
                itemsComplete = true
            });

            Assert.True(prepared.Compacted);
            Assert.InRange(prepared.TransportResultBytes, 1, OperatorCourierResultCompactor.MaxTransportResultBytes);

            var preservedIds = prepared.Result.GetProperty("elementIds");
            Assert.Equal(509, preservedIds.GetArrayLength());
            Assert.Equal(1_400_000, preservedIds[0].GetInt32());
            Assert.Equal(1_400_508, preservedIds[508].GetInt32());

            var compactedItems = prepared.Result.GetProperty("items");
            Assert.Equal(33, compactedItems.GetArrayLength());
            Assert.Equal(477, compactedItems[32].GetProperty("_operator_omitted_items").GetInt32());
            Assert.True(prepared.Result.GetProperty("_operator_transport").GetProperty("omitted_array_items").GetInt32() > 0);
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

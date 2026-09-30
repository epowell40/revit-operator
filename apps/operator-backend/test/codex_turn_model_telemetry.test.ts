import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recentCommandEvents, __closeForTests } from "../src/memory/sqlite_store.js";
import { createCodexTurnModelTelemetry } from "../src/brains/codex_turn_model_telemetry.js";

type ReportedIdentity = Readonly<{ reported_model: string | null; reported_model_source: "raw_response" | "rerouted" | null }>;
function reportedIdentity(telemetry: ReturnType<typeof createCodexTurnModelTelemetry>): ReportedIdentity {
  // Optional structural access also compiles against the unchanged before source.
  const accessor = (telemetry as unknown as { modelIdentity?: () => ReportedIdentity }).modelIdentity;
  assert.equal(typeof accessor, "function", "Provider identity needs an accessor that separates evidence from configured fallback");
  return accessor!();
}

function identityFixture(run: (telemetry: ReturnType<typeof createCodexTurnModelTelemetry>) => void): void {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-model-identity-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    run(createCodexTurnModelTelemetry({ sessionId: "identity-test", threadId: "identity-thread", turnId: "identity-turn",
      settings: { model: "gpt-6-astra", reasoning_effort: "medium" }, startedAtUtc: "2026-09-27T00:00:00Z" }));
  } finally {
    __closeForTests();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("operator-model-identity-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

const rawIdentity = (responseId: string, model?: unknown, turnId = "identity-turn", threadId = "identity-thread") => ({
  method: "rawResponse/completed", threadId, params: { turnId, responseId, model, usage: { inputTokens: 10, outputTokens: 2 } }
});

test("reported worker model is unknown before provider evidence and configured receipt fallback never attests it", () => identityFixture(telemetry => {
  assert.deepEqual(reportedIdentity(telemetry), { reported_model: null, reported_model_source: null });
  telemetry.observe(rawIdentity("response-fallback"));
  assert.equal(telemetry.receipts[0]?.model, "gpt-6-astra");
  assert.deepEqual(reportedIdentity(telemetry), { reported_model: null, reported_model_source: null });
}));

test("raw model identity requires an exact-turn accepted distinct completion and explicit safe model", () => identityFixture(telemetry => {
  telemetry.observe(rawIdentity("other-thread", "gpt-5.6-sol", "identity-turn", "foreign"));
  telemetry.observe(rawIdentity("other-turn", "gpt-5.6-sol", "foreign"));
  telemetry.observe(rawIdentity("invalid response id", "gpt-5.6-sol"));
  telemetry.observe(rawIdentity("missing-model"));
  assert.deepEqual(reportedIdentity(telemetry), { reported_model: null, reported_model_source: null });
  telemetry.observe(rawIdentity("actual-response", "gpt-5.6-sol"));
  const identity = reportedIdentity(telemetry);
  assert.deepEqual(identity, { reported_model: "gpt-5.6-sol", reported_model_source: "raw_response" });
  telemetry.observe(rawIdentity("actual-response", "gpt-5.6-luna"));
  assert.deepEqual(reportedIdentity(telemetry), identity);
  // Existing receipt semantics remain unchanged until a separate deliberate telemetry migration.
  assert.equal(telemetry.receipts.at(-1)?.model, "gpt-6-astra");
}));

test("only exact-turn reroute attests the worker model while old thread-only receipt behavior is preserved", () => identityFixture(telemetry => {
  telemetry.observe({ method: "model/rerouted", threadId: "identity-thread", params: { toModel: "gpt-5.6-sol" } });
  telemetry.observe(rawIdentity("legacy-fallback"));
  assert.equal(telemetry.receipts[0]?.model, "gpt-5.6-sol");
  telemetry.observe({ method: "model/rerouted", threadId: "foreign", params: { turnId: "identity-turn", toModel: "gpt-5.6-luna" } });
  telemetry.observe({ method: "model/rerouted", threadId: "identity-thread", params: { turnId: "foreign", toModel: "gpt-5.6-luna" } });
  assert.deepEqual(reportedIdentity(telemetry), { reported_model: null, reported_model_source: null });
  telemetry.observe({ method: "model/rerouted", threadId: "identity-thread", params: { turnId: "identity-turn", toModel: "gpt-5.6-luna" } });
  assert.deepEqual(reportedIdentity(telemetry), { reported_model: "gpt-5.6-luna", reported_model_source: "rerouted" });
}));

test("reported identity snapshots are frozen copies and retain their event provenance as later evidence arrives", () => identityFixture(telemetry => {
  telemetry.observe({ method: "model/rerouted", threadId: "identity-thread", params: { turnId: "identity-turn", toModel: "gpt-5.6-sol" } });
  const earlier = reportedIdentity(telemetry);
  assert.ok(Object.isFrozen(earlier)); assert.notEqual(earlier, reportedIdentity(telemetry));
  assert.throws(() => { (earlier as { reported_model: string }).reported_model = "wrong"; });
  telemetry.observe(rawIdentity("later-response", "gpt-6-astra"));
  assert.deepEqual(reportedIdentity(telemetry), { reported_model: "gpt-6-astra", reported_model_source: "raw_response" });
  assert.deepEqual(earlier, { reported_model: "gpt-5.6-sol", reported_model_source: "rerouted" });
  telemetry.observe({ method: "model/rerouted", threadId: "identity-thread", params: { turnId: "identity-turn", toModel: "gpt-5.6-luna" } });
  assert.deepEqual(reportedIdentity(telemetry), { reported_model: "gpt-5.6-luna", reported_model_source: "rerouted" });
}));

test("malformed model metadata and unrelated provider fields cannot leak through reported identity", () => identityFixture(telemetry => {
  let index = 0;
  for (const invalid of [null, {}, "", " ", "fixture@example.invalid", "C:\\secret\\auth.json", "x".repeat(129), "model\nsecret"]) {
    telemetry.observe(rawIdentity(`invalid-${index++}`, invalid));
    telemetry.observe({ method: "model/rerouted", threadId: "identity-thread", params: { turnId: "identity-turn", toModel: invalid } });
  }
  telemetry.observe({ ...rawIdentity("safe-response", "gpt-5.6-sol"), params: {
    ...rawIdentity("safe-response", "gpt-5.6-sol").params, account_id: "fixture-account-secret", access_token: "fixture-token-secret",
    api_key: "fixture-key-secret", email: "fixture@example.invalid", auth_path: "C:\\secret\\auth.json"
  } });
  assert.deepEqual(reportedIdentity(telemetry), { reported_model: "gpt-5.6-sol", reported_model_source: "raw_response" });
  assert.doesNotMatch(JSON.stringify(reportedIdentity(telemetry)), /fixture-|auth.json|secret|account|token|email|api_key/);
}));

test("resumed thread usage remains a bounded snapshot and cannot invent provider calls or free cache writes", () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "operator-resumed-usage-"));
  try {
    let callbacks = 0;
    const telemetry = createCodexTurnModelTelemetry({ sessionId: "usage-test", threadId: "thread-a", turnId: "turn-a",
      settings: { model: "gpt-5.6-sol", reasoning_effort: "medium" }, startedAtUtc: "2026-09-07T00:00:00Z",
      onReceipt: () => { callbacks++; } });
    const usage = { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1100 };
    const notification = { method: "thread/tokenUsage/updated", threadId: "thread-a",
      params: { turnId: "turn-a", tokenUsage: { last: usage, total: { ...usage, inputTokens: 5000, totalTokens: 5100 } } } };
    telemetry.observe({ ...notification, threadId: "other" });
    telemetry.observe({ ...notification, params: { ...notification.params, turnId: "other" } });
    assert.equal(telemetry.usageSnapshot(), null);
    telemetry.observe(notification); telemetry.observe(notification);
    assert.equal(telemetry.usageSnapshot()?.total.inputTokens, 5000);
    assert.equal(telemetry.usageSnapshot()?.last.cacheWriteInputTokens, null);
    // A lower cumulative counter after compaction replaces the snapshot; it is not a negative call.
    telemetry.observe({ ...notification, params: { turnId: "turn-a", tokenUsage: { last: usage, total: usage } } });
    assert.equal(telemetry.usageSnapshot()?.total.inputTokens, 1000);
    const copied = telemetry.usageSnapshot()!;
    copied.total.inputTokens = 99;
    assert.equal(telemetry.usageSnapshot()?.total.inputTokens, 1000);
    for (const invalid of [NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      telemetry.observe({ ...notification, params: { turnId: "turn-a", tokenUsage: { last: { ...usage, inputTokens: invalid }, total: usage } } });
      assert.equal(telemetry.usageSnapshot()?.last.inputTokens, 1000);
    }
    assert.equal(telemetry.receipts.length, 0);
    assert.equal(callbacks, 0);
    const missingCoverage = telemetry.finish("message-a", "interrupted");
    assert.equal(missingCoverage.disposition, "interrupted");
    assert.deepEqual(missingCoverage.raw_response_ids, []);
    telemetry.observe({ method: "rawResponse/completed", threadId: "thread-a", params: { turnId: "turn-a", responseId: "response-a", usage } });
    telemetry.observe(notification);
    assert.equal(telemetry.receipts.length, 1);
    assert.equal(callbacks, 1);
    assert.deepEqual(telemetry.finish("message-a", "interrupted").raw_response_ids, ["response-a"]);
    assert.equal(telemetry.finish("message-a", "failed").turn_id, "turn-a");
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
  }
});

test("Codex compaction telemetry is turn-bound, deduplicated and cannot impersonate a model call", () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-compaction-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const telemetry = createCodexTurnModelTelemetry({ sessionId: "compaction-test", threadId: "thread-a", turnId: "turn-a",
      settings: { model: "gpt-5.6-sol", reasoning_effort: "medium" }, startedAtUtc: "2026-09-06T00:00:00Z" });
    const item = { method: "item/completed", threadId: "thread-a", params: { turnId: "turn-a", item: { type: "contextCompaction", id: "compact-a" } } };
    telemetry.observe({ ...item, threadId: "other" });
    telemetry.observe({ ...item, params: { ...item.params, turnId: "other" } });
    assert.equal(telemetry.compactions.length, 0);
    telemetry.observe(item); telemetry.observe(item);
    assert.deepEqual(telemetry.compactions, ["compact-a"]);
    assert.equal(telemetry.receipts.length, 0);
    telemetry.observe({ method: "rawResponse/completed", threadId: "thread-a", params: { turnId: "turn-a", responseId: "response-a",
      usage: { inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 300, outputTokens: 30 } } });
    assert.equal(telemetry.receipts.length, 1);
    assert.equal(telemetry.receipts[0]!.tokens.cache_write_input_tokens, 300);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    // SQLite may retain an open Windows handle; keep this disposable test root.
  }
});

test("compaction start diagnostics require real lifecycle identity and never infer duration or provider usage", () => {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-compaction-start-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    let receipts = 0;
    const telemetry = createCodexTurnModelTelemetry({ sessionId: "compaction-start", threadId: "thread", turnId: "turn",
      settings: { model: "gpt-6-astra", reasoning_effort: "medium" }, startedAtUtc: "2026-09-27T00:00:00Z", onReceipt: () => receipts++ });
    const emit = (method: string, id: unknown, turnId = "turn", threadId = "thread") => telemetry.observe({ method, threadId, params: { turnId, item: { type: "contextCompaction", id } } });
    emit("item/started", "foreign", "old"); emit("item/started", "foreign", "turn", "other"); emit("item/started", " ");
    emit("item/started", "a"); emit("item/started", "a");
    assert.deepEqual(telemetry.compactions, []);
    assert.deepEqual(recentCommandEvents("compaction-start", "codex.context_compaction.started"), [{ thread_id: "thread", turn_id: "turn", item_id: "a", started_after_provider_calls: 0 }]);
    emit("item/completed", "a"); emit("item/completed", "a"); emit("item/started", "a");
    emit("item/completed", "completion-only"); emit("item/started", "completion-only");
    assert.deepEqual(telemetry.compactions, ["a", "completion-only"]);
    assert.equal(recentCommandEvents("compaction-start", "codex.context_compaction.started").length, 1);
    const completed = recentCommandEvents("compaction-start", "codex.context_compaction.completed") as Record<string, unknown>[];
    assert.equal(completed.length, 2);
    assert.ok(completed.every(item => !Object.hasOwn(item, "duration_ms") && item.completed_after_provider_calls === 0));
    assert.equal(receipts, 0); assert.deepEqual(telemetry.receipts, []); assert.equal(telemetry.usageSnapshot(), null);
    assert.deepEqual(telemetry.finish("message", "interrupted").raw_response_ids, []);
  } finally {
    __closeForTests();
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

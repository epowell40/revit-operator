import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexTurnModelTelemetry } from "../src/brains/codex_turn_model_telemetry.js";

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

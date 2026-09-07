import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexTurnModelTelemetry } from "../src/brains/codex_turn_model_telemetry.js";

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

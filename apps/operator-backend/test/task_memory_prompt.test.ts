import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendDailyMemory, appendLongtermMemory } from "../src/memory/jsonl_memory_store.js";
import { formatTaskMemoryContext } from "../src/memory/task_memory_context.js";
import { buildCodexTurnInput } from "../src/brains/codex_turn_input.js";
import { getCodexBaseInstructionsForTest } from "../src/brains/codex_brain.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

test("provider input labels retained history and excludes foreign task outcomes", async t => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-memory-prompt-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => {
    __closeForTests();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  appendDailyMemory({ kind: "note", text: "Exhaust duct was applied before the other task stopped", session_id: "other", source: "chat.auto" });
  appendDailyMemory({ kind: "note", text: "Exhaust duct height was requested from the engineer", session_id: "current", source: "chat.auto", ts: "2026-01-01T12:00:00Z" });
  appendLongtermMemory({ kind: "preference", text: "Exhaust duct uses adjoining compatible element elevations", source: "chat.command" });
  const block = formatTaskMemoryContext("current", "Reconstruct exhaust duct", 6);
  const input = await buildCodexTurnInput({ version: "operator.backend.v1", session_id: "current", message_id: "turn", user_text: "Reconstruct exhaust duct" }, [block]);
  const text = input.filter(x => x.type === "text").map(x => x.text).join("\n");
  assert.doesNotMatch(text, /applied before the other task/);
  assert.match(text, /not evidence of the current model state/);
  assert.match(text, /recorded 2026-01-01T12:00:00Z; source chat.auto/);
  assert.match(text, /adjoining compatible element elevations/);
  assert.equal(formatTaskMemoryContext("current", "unmatchedlexeme", 6), "");
});

test("ordinary provider instructions require unfamiliar export contracts and in-cell evidence consumption", () => {
  const instructions = getCodexBaseInstructionsForTest();
  assert.match(instructions, /Before an unfamiliar write or file export, read its exact tool schema once/);
  assert.doesNotMatch(instructions, /schema only after an argument-shape rejection/);
  assert.match(instructions, /filter\/map result.selection in the same execution cell/);
  assert.match(instructions, /Do not slice a JSON string/);
});

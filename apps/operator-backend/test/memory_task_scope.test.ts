import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendDailyMemory, appendLongtermMemory, retrieveMemoryContext } from "../src/memory/jsonl_memory_store.js";
import { maybePersistAutoTurnMemory, __resetAutoTurnMemoryForTests } from "../src/memory/auto_turn_memory.js";

test("fresh reconstruction does not inherit another task's applied-change summary", t => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-memory-scope-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => {
    __resetAutoTurnMemoryForTests();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const queryText = "Reconstruct Unit 403 exhaust ductwork from the PDF";
  const old = maybePersistAutoTurnMemory({ sessionId: "old-task", messageId: "old-turn", userText: queryText,
    assistantMessage: "Changes were applied before the task stopped. Verify the Unit 403 exhaust ductwork.", actionsCount: 0, toolResults: [] });
  assert.equal(old.saved, true);
  appendDailyMemory({ kind: "fact", text: "Unit 403 exhaust was already rebuilt", source: "legacy" });
  appendDailyMemory({ kind: "note", text: "Unit 403 exhaust requires a new read", session_id: "new-task", source: "chat.auto" });
  appendLongtermMemory({ kind: "preference", text: "Use nearby exhaust elevations when reconstructing ductwork", source: "chat.command", session_id: "old-task" });
  appendLongtermMemory({ kind: "note", text: "Reconstruct ductwork with matching systems and connected endpoints", source: "chat.command", tags: ["workflow"] });
  const fresh = retrieveMemoryContext({ queryText, currentSessionId: "new-task", maxEntries: 20 });
  assert.equal(fresh.length, 3);
  assert.ok(fresh.some(m => m.text.includes("requires a new read")));
  assert.ok(fresh.some(m => m.kind === "preference"));
  assert.ok(fresh.some(m => m.tags?.includes("workflow")));
  assert.ok(fresh.every(m => !m.text.includes("applied") && !m.text.includes("already rebuilt")));
  const resumed = retrieveMemoryContext({ queryText, currentSessionId: "old-task", maxEntries: 20 });
  assert.ok(resumed.some(m => m.source === "chat.auto"));
  assert.ok(resumed.every(m => !m.text.includes("requires a new read")));
  const searched = retrieveMemoryContext({ queryText, maxEntries: 20 });
  assert.ok(searched.some(m => m.text.includes("already rebuilt")), "explicit global search retains historical facts");
  const noTask = retrieveMemoryContext({ queryText, currentSessionId: "", maxEntries: 20 });
  assert.ok(noTask.every(m => m.scope === "longterm" || m.kind === "preference"));
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { __resetAutoTurnMemoryForTests, buildAutoTurnMemoryNote, maybePersistAutoTurnMemory } from "../src/memory/auto_turn_memory.js";

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

test("auto turn memory builds concise note", () => {
  const text = buildAutoTurnMemoryNote({
    sessionId: "s1",
    messageId: "m1",
    userText: "Resize supply ductwork in room 201 from 8 to 10.",
    assistantMessage: "Applied the resize and verified all targeted ducts.",
    actionsCount: 0,
    toolResults: [{ action_id: "a1", method: "POST", path: "/revit/resize-ductwork-by-scope", status: "done" }]
  });

  assert.ok(text.includes("intent:"));
  assert.ok(text.includes("tools:"));
  assert.ok(text.includes("outcome:"));
});

test("auto turn memory persists once per session/message", () => {
  const root = mkWorkspace();
  process.env.OPERATOR_MEMORY_AUTO_TURN_NOTES = "1";
  __resetAutoTurnMemoryForTests();

  const first = maybePersistAutoTurnMemory({
    sessionId: "s2",
    messageId: "m2",
    userText: "Resize pipe in room 105 to 1-1/4.",
    assistantMessage: "Done. Updated scoped pipe instances and verified result.",
    actionsCount: 0,
    toolResults: [{ action_id: "a1", method: "POST", path: "/revit/set-parameter", status: "done" }]
  });
  assert.equal(first.saved, true);
  assert.ok(first.dailyPath);
  assert.ok(fs.existsSync(first.dailyPath!));

  const second = maybePersistAutoTurnMemory({
    sessionId: "s2",
    messageId: "m2",
    userText: "Resize pipe in room 105 to 1-1/4.",
    assistantMessage: "Done. Updated scoped pipe instances and verified result.",
    actionsCount: 0,
    toolResults: [{ action_id: "a1", method: "POST", path: "/revit/set-parameter", status: "done" }]
  });
  assert.equal(second.saved, false);
  assert.equal(second.reason, "duplicate");

  const dailyPath = path.join(root, "memory", "daily", new Date().toISOString().slice(0, 10) + ".jsonl");
  const lines = fs.readFileSync(dailyPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
});

test("auto turn memory skips meta command turns", () => {
  mkWorkspace();
  process.env.OPERATOR_MEMORY_AUTO_TURN_NOTES = "1";
  __resetAutoTurnMemoryForTests();

  const r = maybePersistAutoTurnMemory({
    sessionId: "s3",
    messageId: "m3",
    userText: "list skills",
    assistantMessage: "Macro skills (3): ...",
    actionsCount: 0,
    toolResults: []
  });
  assert.equal(r.saved, false);
  assert.equal(r.reason, "meta_command");
});


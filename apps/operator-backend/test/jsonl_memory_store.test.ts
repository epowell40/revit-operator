import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendDailyMemory, appendLongtermMemory, retrieveMemoryContext } from "../src/memory/jsonl_memory_store.js";

test("jsonl memory store: append + retrieve finds overlaps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  appendDailyMemory({ kind: "preference", text: "Prefer concise answers and PowerShell commands.", session_id: "s1", source: "test" });
  appendLongtermMemory({ kind: "preference", text: "Default workspace under LOCALAPPDATA.", session_id: "s1", source: "test" });

  const res = retrieveMemoryContext({ queryText: "workspace default prefer", maxEntries: 10 });
  assert.ok(res.length >= 1);
  assert.ok(res.some(r => (r.text ?? "").toLowerCase().includes("workspace")));
});

test("jsonl memory store: retrieval lookback includes recent daily files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const now = new Date();
  const d = (deltaDays: number) => {
    const copy = new Date(now.getTime());
    copy.setUTCDate(copy.getUTCDate() + deltaDays);
    return copy.toISOString().slice(0, 10);
  };

  appendDailyMemory({
    kind: "note",
    text: "Pathway resize fallback should inspect type params.",
    session_id: "s2",
    source: "test",
    date: d(-2),
    ts: now.toISOString()
  });
  appendDailyMemory({
    kind: "note",
    text: "Unrelated note about titleblocks.",
    session_id: "s2",
    source: "test",
    date: d(0),
    ts: now.toISOString()
  });

  const miss = retrieveMemoryContext({ queryText: "pathway resize fallback", maxEntries: 10, dailyLookbackDays: 1 });
  assert.ok(miss.every(r => !(r.text ?? "").toLowerCase().includes("pathway resize fallback")));

  const hit = retrieveMemoryContext({ queryText: "pathway resize fallback", maxEntries: 10, dailyLookbackDays: 3 });
  assert.ok(hit.some(r => (r.text ?? "").toLowerCase().includes("pathway resize fallback")));
});


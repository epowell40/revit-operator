import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("sqlite store persists messages under workspace/db", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const store = await import("../src/memory/sqlite_store.js");
  store.__closeForTests();

  store.ensureSessionRow("s1");
  store.setCodexThreadId("s1", "thread_123");
  assert.equal(store.getCodexThreadId("s1"), "thread_123");

  store.appendEvent("s1", "user", "chat.message", { text: "hello" });
  store.appendEvent("s1", "assistant", "chat.message", { text: "world" });

  const msgs = store.getRecentMessages("s1", 10);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]?.role, "user");
  assert.equal(msgs[0]?.text, "hello");
  assert.equal(msgs[1]?.role, "assistant");
  assert.equal(msgs[1]?.text, "world");

  const dbPath = path.join(root, "db", "operator.sqlite");
  assert.ok(fs.existsSync(dbPath));
});

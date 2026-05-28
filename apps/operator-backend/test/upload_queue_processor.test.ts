import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendFeedbackAndMaybePromote } from "../src/feedback/feedback_store.js";
import { scanAndProcessUploadQueue, processUploadQueueDir } from "../src/improvement/upload_queue_processor.js";

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

function writeRunBundle(root: string, sessionId: string): void {
  const dir = path.join(root, "runs", "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ session_id: sessionId, created_at: new Date().toISOString() }), "utf8");
  fs.writeFileSync(path.join(dir, "tool_outputs.jsonl"), JSON.stringify({ kind: "note", text: "C:\\Users\\Alice\\ClientX\\model.rvt email alice@corp.test" }) + "\n", "utf8");
  fs.writeFileSync(path.join(dir, "request_log.jsonl"), JSON.stringify({ role: "user", text: "hello" }) + "\n", "utf8");
}

test("upload queue processor writes outgoing payload (redacted) even when URL is missing", async () => {
  const root = mkWorkspace();
  writeRunBundle(root, "s1");

  const fb = appendFeedbackAndMaybePromote({
    session_id: "s1",
    chat_id: "c1",
    rating: "failed",
    note: "This failed on my project at C:\\Users\\Alice\\ClientX\\job",
    remember_preference: false,
    queue_upload: true
  });
  assert.equal(fb.ok, true);
  assert.ok(fb.upload_queue_dir);

  const results = await scanAndProcessUploadQueue({ gzip: false, max_per_tick: 5, retry_backoff_ms: 0 });
  assert.ok(results.length >= 1);
  const r = results.find(x => (x as any).session_id === "s1") as any;
  assert.ok(r);
  assert.equal(r.ok, false);
  assert.ok(typeof r.outgoing_path_rel === "string");

  const outFull = path.join(root, r.outgoing_path_rel.replace(/\//g, path.sep));
  assert.ok(fs.existsSync(outFull));

  const payload = JSON.parse(fs.readFileSync(outFull, "utf8"));
  const str = JSON.stringify(payload);
  assert.ok(!str.includes("C:\\Users\\Alice\\ClientX"));
  assert.ok(!str.includes("alice@corp.test"));
  assert.ok(str.includes("<email>"));
});

test("upload queue processor can mark uploaded via injected fetch", async () => {
  const root = mkWorkspace();
  writeRunBundle(root, "s2");

  const fb = appendFeedbackAndMaybePromote({
    session_id: "s2",
    chat_id: "c2",
    rating: "partial",
    note: "Queue this",
    remember_preference: false,
    queue_upload: true
  });
  assert.ok(fb.upload_queue_dir);
  const queueDirFull = path.join(root, fb.upload_queue_dir!.replace(/\//g, path.sep));

  const fetch_fn = async () => new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } });

  const r = await processUploadQueueDir(queueDirFull, { upload_url: "https://example.test/ingest", fetch_fn, gzip: false, retry_backoff_ms: 0 });
  assert.equal(r.ok, true);
  assert.equal((r as any).uploaded, true);
  assert.ok(fs.existsSync(path.join(queueDirFull, "uploaded.json")));
});


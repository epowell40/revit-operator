import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendFeedbackAndMaybePromote } from "../src/feedback/feedback_store.js";

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

test("feedback store appends event and can queue upload dir", () => {
  const root = mkWorkspace();

  // Create a dummy run bundle folder to link to (optional).
  fs.mkdirSync(path.join(root, "runs", "sessions", "s1"), { recursive: true });
  fs.writeFileSync(path.join(root, "runs", "sessions", "s1", "manifest.json"), "{}", "utf8");

  const r = appendFeedbackAndMaybePromote({
    session_id: "s1",
    chat_id: "c1",
    rating: "worked",
    note: "Prefer concise answers.",
    remember_preference: true,
    queue_upload: true
  });

  assert.equal(r.ok, true);
  assert.ok(r.created_at);
  assert.ok(r.feedback_events_path);

  const eventsPath = path.join(root, "feedback", "events.jsonl");
  assert.ok(fs.existsSync(eventsPath));
  const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 1);
  const last = JSON.parse(lines[lines.length - 1]!);
  assert.equal(last.session_id, "s1");
  assert.equal(last.rating, "worked");

  // Promotion should have written memory files (best-effort).
  assert.ok(fs.existsSync(path.join(root, "memory", "longterm.jsonl")));
  assert.ok(fs.existsSync(path.join(root, "memory", "daily", new Date().toISOString().slice(0, 10) + ".jsonl")));

  if (r.upload_queue_dir) {
    const qFull = path.join(root, r.upload_queue_dir.replace(/\//g, path.sep));
    assert.ok(fs.existsSync(qFull));
    // Either a link named run_bundle or a pointer.json.
    const linkPath = path.join(qFull, "run_bundle");
    const pointerPath = path.join(qFull, "pointer.json");
    assert.ok(fs.existsSync(linkPath) || fs.existsSync(pointerPath));
  }
});

test("feedback store writes daily note even without preference promotion", () => {
  const root = mkWorkspace();

  const r = appendFeedbackAndMaybePromote({
    session_id: "s2",
    chat_id: "c2",
    rating: "partial",
    note: "Need tighter scope matching for conduit runs.",
    remember_preference: false,
    queue_upload: false
  });

  assert.equal(r.ok, true);
  assert.ok(r.memory_daily_path);
  assert.equal(r.memory_longterm_path, undefined);

  const dailyPath = path.join(root, "memory", "daily", new Date().toISOString().slice(0, 10) + ".jsonl");
  assert.ok(fs.existsSync(dailyPath));
  const lines = fs.readFileSync(dailyPath, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 1);
  const last = JSON.parse(lines[lines.length - 1]!);
  assert.equal(last.kind, "note");
  assert.equal(last.source, "feedback");
  assert.equal(last.text, "Need tighter scope matching for conduit runs.");
});


import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { classifyAgentTurn } from "../src/teammate_loop_runtime.js";
import { classifyAutoGoalRequest } from "../src/goals/auto_goal.js";

const packageRoot = ["../packages/operator-assistant-ui", "../../packages/operator-assistant-ui"]
  .map(p => path.resolve(p)).find(p => fs.existsSync(path.join(p, "context_reply.mjs")))!;
const ui = await import(pathToFileURL(path.join(packageRoot, "context_reply.mjs")).href);
const request = (user_text = "can you see the open model?", extra = {}) => ({
  version: "operator.backend.v1", session_id: "existing-task", message_id: "question", user_text, ...extra
});
const fresh = (title = "Snowdon HVAC") => ({ ok: true, data: { document: { title, activeView: { name: "Level 2" }, selection: [1, 2] } } });

test("model visibility questions are read turns while mixed edits and redlines retain write intent", () => {
  for (const text of ["can you see the open model?", "Could you access my Revit model?", "Can you read this project?"]) {
    assert.equal(classifyAgentTurn(text), "inspection", text);
    assert.equal(classifyAutoGoalRequest(text).requestedEffect, "read", text);
  }
  for (const text of ["Can you see the open model and rename sheet M102?", "Open the Snowdon model", "12x10 SUPPLY DUCT at the marked branch"]) {
    assert.equal(classifyAutoGoalRequest(text).requestedEffect, "apply", text);
  }
});

test("direct answers are a narrow fresh-context read, never a task or attachment shortcut", async () => {
  let reads = 0;
  let authorizations = 0;
  const deps = { verifySession: async () => { authorizations++; }, readContext: async () => { reads++; return fresh(); } };
  const answer = await ui.tryContextReply(request(undefined, { context: { revit: { document: { title: "SPOOFED" } } } }), deps);
  assert.match(answer, /Yes.*Snowdon HVAC.*Level 2/);
  assert.equal(reads, 1); assert.equal(authorizations, 1);
  for (const body of [
    request("can you see the open model and change its name?"), request("how many ducts are in the model?"),
    request(undefined, { attachments: [{ id: "redline" }] }), request(undefined, { pending_attachments: [{ name: "redline.pdf" }] }),
    request(undefined, { user_attachments: [{ id: "uploaded-redline" }] }),
    request(undefined, { tool_results: [{ ok: true }] }), request(undefined, { assignment_id: "task-1" }),
    request("can you see the open model? Then delete the ducts.")
  ]) assert.equal(await ui.tryContextReply(body, deps), null);
  assert.equal(reads, 1); assert.equal(authorizations, 1);
  assert.match(await ui.tryContextReply(request("what view is active?"), deps), /active view.*Level 2/);
  assert.match(await ui.tryContextReply(request("what is selected?"), deps), /2 elements are selected/);
});

test("busy, missing and changed models produce truthful bounded answers without stale fallback", async () => {
  assert.match(ui.renderContextReply("model", { ok: true, data: { document: null } }), /no model is open/);
  assert.match(ui.renderContextReply("model", { ok: false, data: fresh().data }), /couldn’t confirm/);
  assert.match(ui.renderContextReply("model", fresh("Changed model")), /Changed model/);
  let signal: AbortSignal | undefined;
  const start = Date.now();
  const answer = await ui.tryContextReply(request(), { verifySession: async () => {}, timeoutMs: 30,
    readContext: async (value: AbortSignal) => { signal = value; return new Promise(() => {}); } });
  assert.match(answer, /couldn’t confirm/);
  assert.ok(Date.now() - start < 500);
  assert.equal(signal?.aborted, true);
});

test("denied or expired session authorization cannot dispatch a model read", async () => {
  let reads = 0;
  await assert.rejects(ui.tryContextReply(request(), { verifySession: async () => { throw Error("denied"); },
    readContext: async () => { reads++; return fresh(); } }), /denied/);
  let release: () => void = () => {};
  const pending = ui.tryContextReply(request(), { verifySession: () => new Promise<void>(resolve => { release = resolve; }),
    timeoutMs: 15, readContext: async () => { reads++; return fresh(); } });
  assert.match(await pending, /couldn’t confirm/);
  release();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(reads, 0);
});

test("native UI snapshots preserve no-model and transition states without claiming task evidence", () => {
  assert.equal(ui.contextSnapshotDiagnostic({ ok: true, data: { status: "ok" } }), null);
  const snapshot = { schema: "revit-operator.ui-context/v1", state: "available", authority: "ui_identity_only", revision: 2, context: fresh().data };
  assert.match(ui.renderContextReply("model", ui.contextSnapshotDiagnostic({ ok: true, data: { ui_context: snapshot } })), /Snowdon HVAC/);
  for (const change of [{ state: "unavailable" }, { authority: "model_verified" }, { revision: 0 }, { context: {} }]) {
    assert.equal(ui.contextSnapshotDiagnostic({ ok: true, data: { ui_context: { ...snapshot, ...change } } }).ok, false);
  }
  assert.match(ui.renderContextReply("model", ui.contextSnapshotDiagnostic({ ok: true, data: { ui_context: { ...snapshot, context: { document: null } } } })), /no model is open/);
});

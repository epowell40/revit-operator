import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { storeAttachmentUpload } from "../src/attachments/upload_store.js";
import { appendEvent, hasCodexThreadStartedTurn } from "../src/memory/sqlite_store.js";
import { buildCodexTurnInput } from "../src/brains/codex_turn_input.js";
import type { ChatRequest } from "../src/contracts.js";

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-recovery-"));
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => { if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = prior; });
  const binding = { assignment_id: "original-assignment", run_id: "chat:source-message", generation: 1,
    session_id: "original-session", principal_id: "local:test", document_fingerprint: "original-document" };
  const upload = (name: string, size: number, session = binding.session_id) => {
    const canvas = createCanvas(size, size);
    return storeAttachmentUpload({ filename: name, session_id: session, data_base64: canvas.toBuffer("image/png").toString("base64") });
  };
  const attachment = upload("Unit404-source.png", 3);
  appendEvent(binding.session_id, "user", "chat.message", { display: { message_id: "source-message", text: "Draft the visible Unit 404 HVAC.", attachments: [{ id: attachment.id, name: attachment.filename }] } });
  const request: ChatRequest = { version: "operator.backend.v1", session_id: binding.session_id, message_id: "answer-message",
    assignment_id: binding.assignment_id, assignment_run_id: binding.run_id, assignment_generation: 1,
    user_text: "Continue the existing task using its saved answers and evidence.", user_attachments: [],
    context: { revit: { document: { projectIdentity: { fingerprint: binding.document_fingerprint } } } } };
  const recovery = { new_provider_thread: true, source_binding: binding, current_binding: binding, source_message_id: "source-message" };
  return { root, binding, attachment, upload, request, recovery };
}

test("GUI clarification replacement restores original registered pixels at actual provider input construction", async t => {
  const f = setup(t);
  // Fourth parameter is a host-only recovery context, never a model/user argument.
  const input = await buildCodexTurnInput(f.request, ["Saved answer: use a provisional 6-inch ceiling device."], true, f.recovery);
  assert.equal(input.filter(item => item.type === "image").length, 1);
  const text = input.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(text, /Unit404-source.png/);
  assert.match(text, /VISUAL INPUT COVERAGE/);
  assert.match(text, /"status":"included"/);
  assert.match(text, /provisional 6-inch/);
});

test("same loaded thread and independent or unrelated requests never acquire old source pixels", async t => {
  const f = setup(t);
  assert.equal(hasCodexThreadStartedTurn("continued-thread"), false);
  appendEvent(f.binding.session_id, "assistant", "codex.turn.start", { thread_id: "continued-thread" });
  assert.equal(hasCodexThreadStartedTurn("continued-thread"), true);
  for (const [request, recovery] of [
    [f.request, { ...f.recovery, new_provider_thread: !hasCodexThreadStartedTurn("continued-thread") }],
    [{ ...f.request, assignment_id: undefined, assignment_run_id: undefined, assignment_generation: undefined, user_text: "Summarize this conversation." }, f.recovery],
    [{ ...f.request, assignment_id: "new-unrelated-assignment", user_text: "Draft a different floor." }, f.recovery],
    [{ ...f.request, assignment_run_id: "chat:new-message" }, f.recovery],
    [{ ...f.request, assignment_generation: 2 }, f.recovery],
    [{ ...f.request, session_id: "another-session" }, f.recovery],
    [f.request, { ...f.recovery, source_message_id: "unrelated-message" }],
    [f.request, { ...f.recovery, source_binding: { ...f.binding, document_fingerprint: "another-document" } }],
    [{ ...f.request, context: { revit: { document: { projectIdentity: { fingerprint: "another-document" } } } } }, f.recovery],
    [{ ...f.request, context: {} }, f.recovery]
  ] as const) {
    const input = await buildCodexTurnInput(request, [], true, recovery);
    assert.equal(input.filter(item => item.type === "image").length, 0);
  }
});

test("current attachments keep priority while original sources are restored once by ID", async t => {
  const f = setup(t);
  const current = f.upload("Updated-clarification.png", 5);
  const input = await buildCodexTurnInput({ ...f.request, user_attachments: [current, f.attachment] }, [], true, f.recovery);
  const images = input.filter(item => item.type === "image");
  assert.equal(images.length, 2);
  assert.ok("url" in images[0]); assert.equal(images[0].url, `data:image/png;base64,${fs.readFileSync(path.join(f.root, current.relative_path!)).toString("base64")}`);
  assert.equal(input.filter(item => item.type === "text" && item.text.startsWith("USER DRAWING: Unit404-source.png")).length, 1);
  const onlyCurrent = await buildCodexTurnInput({ ...f.request, user_attachments: [current] }, [], true, f.recovery);
  assert.equal(onlyCurrent.filter(item => item.type === "image").length, 2);
});

test("attachment recovery cannot use an upload registered only in another session", async t => {
  const f = setup(t);
  const foreign = f.upload("Other-customer.png", 4, "other-session");
  appendEvent(f.binding.session_id, "user", "chat.message", { display: { message_id: "source-message", text: "Original task", attachments: [{ id: foreign.id, name: foreign.filename }] } });
  await assert.rejects(buildCodexTurnInput(f.request, [], true, f.recovery), /unavailable in this conversation/);
});

test("missing or changed original bytes stop before constructing a visual provider turn", async t => {
  const f = setup(t);
  const file = path.join(f.root, f.attachment.relative_path!);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.from("Changed source"));
  await assert.rejects(buildCodexTurnInput(f.request, [], true, f.recovery), /changed since upload/);
  fs.writeFileSync(file, original);
  fs.unlinkSync(file);
  await assert.rejects(buildCodexTurnInput(f.request, [], true, f.recovery), /Cannot read visual attachment/);
});

test("restored source images share the existing pixel budget with fresh native evidence and report deferred coverage", async t => {
  const f = setup(t);
  const sources = [f.attachment, ...Array.from({ length: 5 }, (_, i) => f.upload(`Source-${i}.png`, i + 4))];
  appendEvent(f.binding.session_id, "user", "chat.message", { display: { message_id: "source-message", text: "Original task", attachments: sources.map(source => ({ id: source.id, name: source.filename })) } });
  const capture = f.upload("Current-model.png", 11);
  const input = await buildCodexTurnInput({ ...f.request, tool_results: [{ action_id: "fresh-capture", method: "POST", path: "/revit/capture-view", status: "done",
    attachments: [{ kind: "image", mime: "image/png", local_path: path.join(f.root, capture.relative_path!) }] }] }, [], true, f.recovery);
  assert.equal(input.filter(item => item.type === "image").length, 6);
  const text = input.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(text, /REVIT TOOL IMAGE/);
  assert.match(text, /"status":"deferred"/);
  assert.match(text, /Initial image budget reached/);
});

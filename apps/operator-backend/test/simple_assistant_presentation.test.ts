import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = ["../packages/operator-assistant-ui", "../../packages/operator-assistant-ui"].map(p => path.resolve(p))
  .find(p => fs.existsSync(path.join(p, "conversation_ui.mjs")))!;
const ui = await import(pathToFileURL(path.join(root, "conversation_ui.mjs")).href);
const intake = await import(pathToFileURL(path.join(root, "composer_intake.mjs")).href);

test("composer intake captures file bytes once and blocks duplicate backend or pending sends without blocking computer steering", () => {
  const state: any = { pendingAttachments: [{ filename: "redline.pdf", data_base64: "bytes" }], streaming: false };
  const first = intake.beginComposerSend(state, "Review it");
  assert.equal(state.composerSubmissionPending, true);
  assert.equal(intake.beginComposerSend(state, "Duplicate"), null);
  state.pendingAttachments[0].filename = "later.pdf";
  assert.equal(first.attachments[0].filename, "redline.pdf"); assert.equal(first.attachments[0].data_base64, "bytes");
  state.composerSubmissionPending = false; state.streaming = true; state.activeRunKind = "backend";
  assert.equal(intake.beginComposerSend(state, "Duplicate active send"), null);
  state.activeRunKind = "computer"; assert.ok(intake.beginComposerSend(state, "Steer this work"));
  state.composerSubmissionPending = false; state.resetting = true; assert.equal(intake.beginComposerSend(state, "Late send"), null);
  assert.equal(intake.beginComposerSend({ pendingAttachments: [] }, "  "), null);
});

test("idle tasks cannot imply ongoing work; working summaries do not expose internal task detail", () => {
  assert.equal(ui.compactWorkSummary({ current_step: "Canonical evidence token secret-value" }, false), "");
  assert.equal(ui.compactWorkSummary({ current_step: "Verify native postcondition for internal-id-42" }, true), "Checking the result…");
  assert.equal(ui.compactWorkSummary({ current_step: "Discover current model" }, true), "Checking the model…");
  assert.equal(ui.compactWorkSummary({ current_step: "Apply parameter changes" }, true), "Making the requested changes…");
  assert.equal(ui.conciseStatus("Sidecar ready."), "Ready");
  assert.equal(ui.conciseStatus("Revit connection lost."), "Revit connection lost.");
});

test("inline formatting treats model names and HTML as inert text", () => {
  const nodes: any[] = [];
  const document = { createElement: (tag: string) => ({ tag, textContent: "" }), createTextNode: (text: string) => ({ tag: "text", textContent: text }) };
  ui.appendInlineText({ ownerDocument: document, appendChild: (node: any) => nodes.push(node) }, "Yes — **Model A**. `<script>` <img onerror=run()>");
  assert.deepEqual(nodes.filter(n => n.tag !== "text").map(n => n.tag), ["strong", "code"]);
  assert.equal(nodes.find(n => n.tag === "strong").textContent, "Model A");
  assert.ok(nodes.some(n => n.textContent.includes("<img onerror=run()>")));
});

test("restoring history preserves a simultaneous live reply and avoids duplicate messages", () => {
  const live = { id: "new", role: "assistant", text: "Current streaming reply" };
  const result = ui.mergeConversationHistory([live], [
    { message_id: "old", role: "user", text: "Which model?" },
    { message_id: "old", role: "assistant", text: "Pilot." },
    { message_id: "new", role: "assistant", text: "Older partial reply" },
    { message_id: "old", role: "assistant", text: "Duplicate" },
    { message_id: "internal", role: "tool", text: "hidden" }
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[2], live);
  assert.equal(result[2].text, "Current streaming reply");
});

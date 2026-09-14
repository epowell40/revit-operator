import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { buildCodexTurnInput } from "../src/brains/codex_turn_input.js";
import { storeAttachmentUpload } from "../src/attachments/upload_store.js";
import type { ChatRequest } from "../src/contracts.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN8sAAAAASUVORK5CYII=", "base64");
const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({ version: "operator.backend.v1", session_id: "redline-input", message_id: "turn-1", user_text: "", ...extra });

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-visual-input-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "redline.png"), png);
  return root;
}

test("attachment-only request transports exact uploaded pixels and current assignment context", async t => {
  fixture(t);
  const uploaded = storeAttachmentUpload({ filename: "redline.png", session_id: "redline-input", data_base64: png.toString("base64") });
  const input = await buildCodexTurnInput(request({ user_attachments: [uploaded], context: { active_view_name: "Level 2" } }), ["Continue the approved note revision."]);
  const text = input.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(text, /Level 2/);
  assert.match(text, /Continue the approved note revision/);
  assert.match(text, /without a new written instruction/);
  assert.match(text, /VISUAL INPUT COVERAGE/);
  const images = input.filter(item => item.type === "image");
  assert.equal(images.length, 1);
  assert.equal(images[0].url, `data:image/png;base64,${png.toString("base64")}`);
  assert.equal(images[0].detail, "original");
});

test("empty continuation retains fresh native readback, context, and image instead of a generic nudge", async t => {
  const root = fixture(t);
  const input = await buildCodexTurnInput(request({
    context: { active_view_name: "Mechanical Level 2" },
    tool_results: [{ action_id: "capture-after-edit", method: "POST", path: "/revit/capture-view", status: "done", result_json: { viewId: 42, observed_at: "2026-09-13T12:00:00Z" }, attachments: [{ kind: "image", mime: "image/png", local_path: path.join(root, "redline.png") }] }]
  }), ["The note edit was committed; verify it before continuing."]);
  const text = input.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(text, /capture-after-edit/);
  assert.match(text, /Mechanical Level 2/);
  assert.match(text, /Reconcile any uncertain prior write/);
  assert.match(text, /REVIT TOOL IMAGE/);
  assert.equal(input.filter(item => item.type === "image").length, 1);
});

test("changed source digest and outside-workspace source stop before a visual turn is admitted", async t => {
  fixture(t);
  await assert.rejects(buildCodexTurnInput(request({ user_attachments: [{ id: "x", relative_path: "redline.png", sha256: "0".repeat(64) }] }), []), /changed since upload/);
  await assert.rejects(buildCodexTurnInput(request({ user_attachments: [{ id: "x", relative_path: "../outside.png" }] }), []), /Cannot read visual attachment/);
});

test("duplicate uploads preserve one pixel payload with explicit source receipts", async t => {
  fixture(t);
  const attachment = { id: "x", relative_path: "redline.png", sha256: createHash("sha256").update(png).digest("hex") };
  const input = await buildCodexTurnInput(request({ user_text: "Apply the redline", user_attachments: [attachment, { ...attachment, id: "y" }] }), []);
  assert.equal(input.filter(item => item.type === "image").length, 1);
});

test("large drawing sets cannot crowd the latest Revit capture out of the visual input", async t => {
  const root = fixture(t);
  const attachments = Array.from({ length: 6 }, (_, index) => {
    const canvas = createCanvas(index + 2, index + 2);
    const name = `drawing-${index}.png`;
    fs.writeFileSync(path.join(root, name), canvas.toBuffer("image/png"));
    return { id: name, relative_path: name };
  });
  const input = await buildCodexTurnInput(request({ user_attachments: attachments,
    tool_results: [{ action_id: "latest-capture", method: "POST", path: "/revit/capture-view", status: "done", attachments: [{ kind: "image", mime: "image/png", data_base64: png.toString("base64") }] }]
  }), []);
  const images = input.filter(item => item.type === "image");
  assert.equal(images.length, 6);
  assert.equal(images[0].url, `data:image/png;base64,${png.toString("base64")}`);
  assert.match(input.filter(item => item.type === "text").map(item => item.text).join("\n"), /Initial image budget reached/);
});

// A four-page vector PDF exercises the actual PDF parser and canvas renderer.
function pagedPdf(pageCount = 4): Buffer {
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`];
  for (let i = 0; i < pageCount; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents ${4 + i * 2} 0 R >>`);
    const stream = `1 0 0 RG 2 w 10 ${10 + i * 10} m 90 90 l S\n`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

test("PDF intake renders bounded annotated pages and explicitly retains uninspected page coverage", async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "drawing.pdf"), pagedPdf(7));
  const input = await buildCodexTurnInput(request({ user_attachments: [{ id: "pdf", relative_path: "drawing.pdf" }] }), []);
  assert.equal(input.filter(item => item.type === "image").length, 3);
  const text = input.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(text, /page 3 of 7/);
  assert.match(text, /4 pages still require inspection/);
  assert.doesNotMatch(text, /page 4 of 7/);
});

test("short document review receives every page including late discipline sections without Revit", async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "tasks.pdf"), pagedPdf(5));
  const input = await buildCodexTurnInput(request({ user_text: "Read the attached task list and explain the HVAC design-development work. Do not make model changes yet.", user_attachments: [{ id: "pdf", filename: "tasks.pdf", relative_path: "tasks.pdf" }] }), []);
  const text = input.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.equal(input.filter(item => item.type === "image").length, 5);
  assert.match(text, /page 5 of 5/);
  assert.match(text, /STANDALONE ASSISTANT TURN/);
  assert.match(text, /without a Revit bootstrap/);
  assert.doesNotMatch(text, /pages still require inspection/);
  const mixed = await buildCodexTurnInput(request({user_text:"Review the attached task list and update the open model."}), []);
  assert.doesNotMatch(mixed.filter(item=>item.type === "text").map(item=>item.text).join("\n"), /STANDALONE ASSISTANT TURN/);
});

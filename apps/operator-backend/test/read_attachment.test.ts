import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadImage, createCanvas } from "@napi-rs/canvas";
import { READ_ATTACHMENT_TOOL, readRegisteredPdfAttachment } from "../src/attachments/read_attachment.js";
import { storeAttachmentUpload } from "../src/attachments/upload_store.js";
import { appendUploadIndexRecord } from "../src/attachments/upload_index.js";
import { adaptMcpToolCallResultToDynamicResponse } from "../src/brains/codex_dynamic_result_adapter.js";
import { CodexMcpToolRuntime } from "../src/codex/mcp_tool_runtime.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { McpInputValidator } from "../src/codex/mcp_input_validation.js";
import { attachmentPdf } from "./pdf_attachment.fixtures.js";

function workspace(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-page-reader-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
const upload = (session = "owner", text = true) => storeAttachmentUpload({ session_id: session, filename: "checklist.pdf", data_base64: attachmentPdf(8, text).toString("base64") });

test("registered PDF reader and provider adapter return all three selected late pages, text, red pixels and exact coverage", async t => {
  workspace(t);
  const attachment = upload();
  const result = await readRegisteredPdfAttachment("owner", { attachment_id: attachment.id, pages: [6, 7, 8] });
  const adapted = adaptMcpToolCallResultToDynamicResponse(result);
  assert.equal(adapted.success, true);
  const images = adapted.contentItems.filter(item => item.type === "inputImage");
  assert.equal(images.length, 3);
  const texts = adapted.contentItems.filter(item => item.type === "inputText").map(item => JSON.parse(item.text));
  assert.deepEqual(texts[0].pages_returned, [6, 7, 8]);
  assert.equal(texts[0].page_count, 8); assert.equal(texts[0].pages_not_returned_count, 5);
  assert.equal(texts[0].sha256, attachment.sha256);
  for (let i = 0; i < 3; i++) {
    assert.match(texts[i + 1].extracted_text, new RegExp(`Fixture page ${i + 6}`));
    const decoded = await loadImage(images[i]!.imageUrl);
    const canvas = createCanvas(decoded.width, decoded.height); const context = canvas.getContext("2d"); context.drawImage(decoded, 0, 0);
    const pixels = context.getImageData(0, 0, decoded.width, decoded.height).data;
    let red = 0; for (let p = 0; p < pixels.length; p += 4) if (pixels[p]! > 180 && pixels[p + 1]! < 80 && pixels[p + 2]! < 80) red++;
    assert.ok(red > 200, "visible redline pixels must survive actual rendering and adaptation");
  }
});

test("image-only PDF still supplies actual pixels and does not misrepresent empty extracted text", async t => {
  workspace(t); const attachment = upload("owner", false);
  const result = await readRegisteredPdfAttachment("owner", { attachment_id: attachment.id, pages: [8] });
  assert.equal(result.content.filter(item => item.type === "image").length, 1);
  const page = JSON.parse(result.content.filter(item => item.type === "text").find(item => item.text.includes("extracted_text"))!.text);
  assert.equal(page.extracted_text, ""); assert.match(page.note, /does not mean an empty page/);
});

test("reader refuses another session, missing ownership, forged path, changed bytes and unsupported format", async t => {
  const root = workspace(t); const attachment = upload();
  await assert.rejects(readRegisteredPdfAttachment("other", { attachment_id: attachment.id, pages: [1] }), /not registered/);
  await assert.rejects(readRegisteredPdfAttachment("", { attachment_id: attachment.id, pages: [1] }), /No current conversation/);
  appendUploadIndexRecord({ ...attachment, id: "forged", session_id: "owner", relative_path: "private.pdf" });
  fs.writeFileSync(path.join(root, "private.pdf"), attachmentPdf());
  await assert.rejects(readRegisteredPdfAttachment("owner", { attachment_id: "forged", pages: [1] }), /path is invalid/);
  const other = storeAttachmentUpload({ session_id: "owner", filename: "notes.txt", data_base64: Buffer.from("notes").toString("base64") });
  await assert.rejects(readRegisteredPdfAttachment("owner", { attachment_id: other.id, pages: [1] }), /PDF attachments only/);
  fs.appendFileSync(path.join(root, attachment.relative_path!), "changed");
  await assert.rejects(readRegisteredPdfAttachment("owner", { attachment_id: attachment.id, pages: [1] }), /changed since upload/);
});

test("reader and advertised schema reject coerced, duplicate, excessive and out-of-range pages without partial success", async t => {
  workspace(t); const attachment = upload(); const validator = new McpInputValidator();
  for (const pages of [[], [0], [1.5], ["1"], [1, 1], [1, 2, 3, 4], [100_001]]) {
    const args = { attachment_id: attachment.id, pages };
    assert.throws(() => validator.validate(READ_ATTACHMENT_TOOL.name, args, [READ_ATTACHMENT_TOOL]));
    await assert.rejects(readRegisteredPdfAttachment("owner", args), /one to three/);
  }
  await assert.rejects(readRegisteredPdfAttachment("owner", { attachment_id: attachment.id, pages: [1, 9] }), /8 pages; no requested page/);
  await assert.rejects(readRegisteredPdfAttachment("owner", { attachment_id: attachment.id, pages: [1], session_id: "other" }), /conversation is bound by the host/);
  await assert.rejects(readRegisteredPdfAttachment("owner", { attachment_id: "../file.pdf", pages: [1] }), /not a path/);
});

test("actual backend reader requires matching live authentication lease and cannot read after turn release", async t => {
  const root = workspace(t); const attachment = upload();
  const runtime = new CodexMcpToolRuntime({ backendCwd: process.cwd(), workspaceRoot: root, codexHome: root, spawnEnv: {} });
  const args = { attachment_id: attachment.id, pages: [1] };
  await assert.rejects(runtime.readAttachmentForTurn(args, { turnId: "turn", sessionId: "owner" }), /not bound/);
  const lease = runtime.beginBackendAuthLease("owner", createOperatorBackendAuth("shared_token", "test-only"));
  runtime.bindBackendAuthLeaseTurn(lease, "turn");
  await assert.rejects(runtime.readAttachmentForTurn(args, { turnId: "turn", sessionId: "other" }), /binding does not match/);
  await assert.rejects(runtime.readAttachmentForTurn(args, { turnId: "wrong-turn", sessionId: "owner" }), /not bound/);
  assert.ok(await runtime.readAttachmentForTurn(args, { turnId: "turn", sessionId: "owner" }));
  runtime.endBackendAuthLease(lease);
  await assert.rejects(runtime.readAttachmentForTurn(args, { turnId: "turn", sessionId: "owner" }), /not bound/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { readOutputPdf, READ_OUTPUT_PDF_TOOL } from "../src/attachments/read_output_pdf.js";
import { attachmentPdf } from "./pdf_attachment.fixtures.js";
import { adaptMcpToolCallResultToDynamicResponse } from "../src/brains/codex_dynamic_result_adapter.js";
import { CodexMcpToolRuntime } from "../src/codex/mcp_tool_runtime.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { McpInputValidator } from "../src/codex/mcp_input_validation.js";

function fixture(t: test.TestContext, bytes = attachmentPdf(4)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-output-reader-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => { if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const prints = path.join(root, "artifacts", "prints"); fs.mkdirSync(prints, { recursive: true });
  const file_path = path.join(prints, "existing.pdf"); fs.writeFileSync(file_path, bytes);
  return { root, args: { file_path, sha256: createHash("sha256").update(bytes).digest("hex"), pages: [2, 3, 4] } };
}

test("existing output returns real page images, immutable digest, dimensions and incomplete coverage without rewriting", async t => {
  const { args } = fixture(t); const before = fs.statSync(args.file_path);
  new McpInputValidator().validate(READ_OUTPUT_PDF_TOOL.name, args, [READ_OUTPUT_PDF_TOOL]);
  const result = await readOutputPdf(args);
  const coverage = JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "{}");
  assert.equal(coverage.page_count, 4); assert.deepEqual(coverage.pages_returned, [2, 3, 4]);
  assert.equal(coverage.pages_not_returned_count, 1); assert.equal(coverage.sha256, args.sha256);
  assert.equal(coverage.file_path, args.file_path); assert.equal(coverage.attachment_id, undefined);
  const page = JSON.parse((result.content[1] as {text:string}).text);
  assert.equal(page.rendered_color_observation.observation, "color_detected");
  assert.ok(page.rendered_color_observation.chromatic_pixel_count > 0, "actual red PDF line must be observed after rendering");
  const adapted = adaptMcpToolCallResultToDynamicResponse(result);
  assert.equal(adapted.contentItems.filter(i => i.type === "inputImage").length, 3);
  assert.match(JSON.stringify(result.content.filter(i => i.type === "text")), /Fixture page 4/);
  assert.equal(fs.statSync(args.file_path).mtimeMs, before.mtimeMs);
  assert.equal(createHash("sha256").update(fs.readFileSync(args.file_path)).digest("hex"), args.sha256);
});

test("monochrome rendered content is observed without promoting partial page coverage", async t => {
  const bytes = Buffer.from(attachmentPdf(2).toString().replaceAll("1 0 0 RG", "0 0 0 RG"));
  const { args } = fixture(t, bytes);
  const result = await readOutputPdf({ ...args, pages: [1] });
  const coverage = JSON.parse((result.content[0] as {text:string}).text);
  const page = JSON.parse((result.content[1] as {text:string}).text);
  assert.equal(page.rendered_color_observation.chromatic_pixel_count, 0);
  assert.equal(page.rendered_color_observation.observation, "no_color_detected_at_render_resolution");
  assert.equal(coverage.pages_not_returned_count, 1);
  assert.match(page.rendered_color_observation.limitation, /finer details/);
});

test("output folders use the OS account while an authentication profile overrides the environment home", async t => {
  const { root, args } = fixture(t);
  const accountHome = path.join(root, "account");
  const credentialHome = path.join(root, "credentials");
  const priorHome = process.env.HOME, priorProfile = process.env.USERPROFILE;
  process.env.HOME = credentialHome; process.env.USERPROFILE = credentialHome;
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
  });
  const account = os.userInfo();
  t.mock.method(os, "userInfo", () => ({ ...account, homedir: accountHome }));
  for (const base of [accountHome, credentialHome]) {
    fs.mkdirSync(path.join(base, "Documents"), { recursive: true });
    fs.copyFileSync(args.file_path, path.join(base, "Documents", "existing.pdf"));
  }
  const result = await readOutputPdf({ ...args, file_path: path.join(accountHome, "Documents", "existing.pdf") });
  assert.equal(result.content.filter(item => item.type === "image").length, 3);
  await assert.rejects(readOutputPdf({ ...args, file_path: path.join(credentialHome, "Documents", "existing.pdf") }), /allowed folders/);
});

test("regional output inspection reports only regional visual coverage", async t => {
  const { args } = fixture(t);
  const result = await readOutputPdf({ ...args, pages: [1], region: { min_u: 0, min_v: 0, max_u: .5, max_v: .5 } });
  const first = result.content[0]; assert.equal(first?.type, "text");
  const coverage = JSON.parse((first as {text: string}).text);
  assert.deepEqual(coverage.fully_rendered_pages, []); assert.equal(coverage.coverage[0].visual_scope, "region");
});

test("changed, malformed, outside-root and invalid-page PDFs never become content proof", async t => {
  const { root, args } = fixture(t);
  await assert.rejects(readOutputPdf({ ...args, sha256: "0".repeat(64) }), /changed/);
  await assert.rejects(readOutputPdf({ ...args, pages: [5] }), /no requested page/);
  await assert.rejects(readOutputPdf({ ...args, pages: [1, 1] }), /distinct/);
  await assert.rejects(readOutputPdf({ ...args, pages: [1, 2, 3, 4] }), /one to three/);
  await assert.rejects(readOutputPdf({ ...args, allow_roots: [os.tmpdir()] }), /Only/);
  const outside = path.join(os.tmpdir(), path.basename(root) + ".pdf"); fs.copyFileSync(args.file_path, outside);
  t.after(() => fs.unlinkSync(outside));
  await assert.rejects(readOutputPdf({ ...args, file_path: outside }), /allowed folders/);
  const uploads = path.join(root, "artifacts", "uploads"); fs.mkdirSync(uploads);
  const foreignUpload = path.join(uploads, "other-session.pdf"); fs.copyFileSync(args.file_path, foreignUpload);
  await assert.rejects(readOutputPdf({ ...args, file_path: foreignUpload }), /allowed folders/, "output reader must not bypass session-bound upload access");
  const junction = path.join(root, "artifacts", "prints", "escape"); fs.symlinkSync(os.tmpdir(), junction, "junction");
  await assert.rejects(readOutputPdf({ ...args, file_path: path.join(junction, path.basename(outside)) }), /allowed folders/);
  fs.writeFileSync(args.file_path, "%PDF-broken");
  await assert.rejects(readOutputPdf(args), /changed/);
  await assert.rejects(readOutputPdf({ ...args, sha256: createHash("sha256").update("%PDF-broken").digest("hex") }));
});

test("output reads require the exact live turn/session authentication lease", async t => {
  const { root, args } = fixture(t);
  const runtime = new CodexMcpToolRuntime({ backendCwd: process.cwd(), workspaceRoot: root, codexHome: root, spawnEnv: {} });
  const binding = { turnId: "turn", sessionId: "owner" };
  await assert.rejects(runtime.readOutputPdfForTurn(args, binding), /not bound/);
  const lease = runtime.beginBackendAuthLease("owner", createOperatorBackendAuth("shared_token", "test-only"));
  runtime.bindBackendAuthLeaseTurn(lease, "turn");
  await assert.rejects(runtime.readOutputPdfForTurn(args, { ...binding, sessionId: "other" }), /binding does not match/);
  assert.ok(await runtime.readOutputPdfForTurn(args, binding));
  runtime.endBackendAuthLease(lease);
  await assert.rejects(runtime.readOutputPdfForTurn(args, binding), /not bound/);
});

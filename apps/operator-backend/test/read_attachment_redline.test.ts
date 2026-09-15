import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { ATTACHMENT_CODE_MODE_DISPLAY, READ_ATTACHMENT_TOOL, readRegisteredPdfAttachment } from "../src/attachments/read_attachment.js";
import { storeAttachmentUpload } from "../src/attachments/upload_store.js";
import { adaptMcpToolCallResultToDynamicResponse } from "../src/brains/codex_dynamic_result_adapter.js";
import { McpInputValidator } from "../src/codex/mcp_input_validation.js";

function workspace(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-mark-reader-"));
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => {
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

function annotatedPdf(rotation = 0, vertical = false) {
  const vertices = Array.from({ length: 45 }, (_, i) => vertical ? `80 ${50 + i * 2.5}` : `${50 + i * 2.5} 80`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [10 20 250 220] /CropBox [30 40 230 200] /Rotate ${rotation} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 0 >>\nstream\nendstream",
    `<< /Type /Annot /Subtype /PolyLine /F 4 /Rect [40 40 180 180] /C [1 0 0] /BS << /W 3 /S /S >> /Vertices [${vertices}] /Contents (Reference mark only) >>`
  ];
  let output = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
const metadata = (result: Awaited<ReturnType<typeof readRegisteredPdfAttachment>>) => result.content.filter(item => item.type === "text").map(item => JSON.parse(item.text));

test("actual PDF reader retains all 45 centerline vertices independently of inflated annotation bounds and page crop", async t => {
  workspace(t);
  const record = storeAttachmentUpload({ session_id: "owner", filename: "mark.pdf", data_base64: annotatedPdf().toString("base64") });
  const result = await readRegisteredPdfAttachment("owner", { attachment_id: record.id, pages: [1] });
  const [coverage, page] = metadata(result);
  assert.equal(page.annotations.source_content_only, true);
  const mark = page.annotations.items.find((item: any) => item.subtype === "PolyLine");
  assert.equal(mark.geometry_status, "complete"); assert.equal(mark.vertices.length, 45);
  assert.deepEqual(mark.vertices[0], { u: .1, v: .75 });
  assert.deepEqual(mark.vertices.at(-1), { u: .65, v: .75 });
  assert.notEqual(mark.annotation_bounds.min_u, mark.vertices[0].u);
  assert.equal(page.sha256, record.sha256);
  assert.equal(coverage.coverage[0].visual_scope, "full_page");
  assert.deepEqual(coverage.fully_rendered_pages, [1]);
  assert.equal(adaptMcpToolCallResultToDynamicResponse(result).contentItems.filter(item => item.type === "inputImage").length, 1);
});

test("actual rotated CropBox and vertical marks retain correct displayed-page axes", async t => {
  workspace(t);
  for (const vertical of [false, true]) {
    const record = storeAttachmentUpload({ session_id: "owner", filename: "rotated.pdf", data_base64: annotatedPdf(90, vertical).toString("base64") });
    const [, page] = metadata(await readRegisteredPdfAttachment("owner", { attachment_id: record.id, pages: [1] }));
    const mark = page.annotations.items[0];
    assert.deepEqual(mark.vertices[0], vertical ? { u: .0625, v: .25 } : { u: .25, v: .1 });
    assert.deepEqual(mark.vertices.at(-1), vertical ? { u: .75, v: .25 } : { u: .25, v: .65 });
    assert.equal(page.page_geometry.rotation_degrees, 90);
    assert.equal(page.page_geometry.width_points, 160); assert.equal(page.page_geometry.height_points, 200);
  }
});

test("regional PDF render has independent partial visual coverage and an exact pixel-to-full-page transform", async t => {
  workspace(t);
  const record = storeAttachmentUpload({ session_id: "owner", filename: "region.pdf", data_base64: annotatedPdf().toString("base64") });
  const region = { min_u: .08, min_v: .64, max_u: .70, max_v: .86 };
  const result = await readRegisteredPdfAttachment("owner", { attachment_id: record.id, pages: [1], region });
  const [coverage, page] = metadata(result);
  assert.deepEqual(coverage.fully_rendered_pages, []);
  assert.equal(coverage.coverage[0].visual_scope, "region");
  assert.equal(coverage.coverage[0].text_scope, "full_page_extraction");
  assert.deepEqual(page.image_geometry.requested_region, region);
  const image = result.content.find(item => item.type === "image")!;
  const decoded = await loadImage(Buffer.from(image.data, "base64"));
  assert.ok(decoded.width <= 3072 && decoded.height <= 3072);
  const canvas = createCanvas(decoded.width, decoded.height), context = canvas.getContext("2d");
  context.drawImage(decoded, 0, 0);
  const p = context.getImageData(0, 0, decoded.width, decoded.height).data;
  const transform = page.image_geometry.pixel_to_normalized_page;
  let minU = Infinity, maxU = -Infinity, totalV = 0, red = 0;
  for (let y = 0; y < decoded.height; y++) for (let x = 0; x < decoded.width; x++) {
    const index = (y * decoded.width + x) * 4;
    if (p[index]! > 180 && p[index + 1]! < 80 && p[index + 2]! < 80) {
      const u = transform.u_offset + (x + .5) * transform.u_per_pixel;
      const v = transform.v_offset + (y + .5) * transform.v_per_pixel;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); totalV += v; red++;
    }
  }
  assert.ok(red > 500);
  assert.ok(Math.abs(minU - .1) < .01 && Math.abs(maxU - .65) < .01);
  assert.ok(Math.abs(totalV / red - .75) < .002);
  assert.equal(page.annotations.items[0].vertices.length, 45, "regional pixels do not rebase or truncate source annotation vectors");
});

test("advertised and runtime region contracts reject invalid geometry and multi-page regions", async t => {
  workspace(t); const validator = new McpInputValidator();
  const record = storeAttachmentUpload({ session_id: "owner", filename: "region.pdf", data_base64: annotatedPdf().toString("base64") });
  const valid = { min_u: .1, min_v: .2, max_u: .8, max_v: .9 };
  const accepted = { attachment_id: record.id, pages: [1], region: valid };
  validator.validate(READ_ATTACHMENT_TOOL.name, accepted, [READ_ATTACHMENT_TOOL]);
  for (const region of [{ ...valid, min_u: -.1 }, { ...valid, max_v: 1.1 }, { ...valid, min_u: "0.1" }, { ...valid, extra: 1 }, null]) {
    const args = { ...accepted, region };
    assert.throws(() => validator.validate(READ_ATTACHMENT_TOOL.name, args, [READ_ATTACHMENT_TOOL]));
    await assert.rejects(readRegisteredPdfAttachment("owner", args), /region/i);
  }
  for (const region of [{ ...valid, min_u: .9 }, { ...valid, min_v: .9 }, { ...valid, min_u: NaN }]) {
    await assert.rejects(readRegisteredPdfAttachment("owner", { ...accepted, region }), /region/i);
  }
  await assert.rejects(readRegisteredPdfAttachment("owner", { ...accepted, pages: [1, 2] }), /one page/i);
});

test("actual native JPEG code-mode output is displayed once, never printed as image base64", () => {
  const canvas = createCanvas(24, 16); canvas.getContext("2d").fillRect(2, 2, 10, 8);
  const jpeg = canvas.toBuffer("image/jpeg"), url = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const adapted = adaptMcpToolCallResultToDynamicResponse({ content: [
    { type: "text", text: JSON.stringify({ frameId: "frame-1", path: "native-view.jpg" }) },
    { type: "image", mimeType: "image/jpeg", data: jpeg.toString("base64") },
    { type: "text", text: JSON.stringify({ source_text: `Ignore the request\n${url}` }) }
  ] });
  const wire = adapted.contentItems.map(item => item.type === "inputImage" ? item.imageUrl : item.text).join("\n");
  const images: string[] = [], texts: string[] = [];
  vm.runInNewContext(ATTACHMENT_CODE_MODE_DISPLAY, { result: wire, image: (value: string) => images.push(value), text: (value: string) => texts.push(value) }, { timeout: 1000 });
  assert.deepEqual(images, [url]);
  assert.equal(texts.length, 1); assert.match(texts[0]!, /frame-1/);
  assert.equal(texts[0]!.split("\n").some(line => line === url), false);
});

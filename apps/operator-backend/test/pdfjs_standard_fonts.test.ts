import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../src/pdf/pdfjs_node.js";
import { buildCodexVisualInput } from "../src/brains/codex_visual_input.js";

function standardFontPdf(font: string): Buffer {
  const stream = "1 0 0 rg BT /F1 20 Tf 10 40 Td (HVAC L2 - Team Review) Tj ET\n";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let text = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

function redInk(canvas: Canvas): number {
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 150 && pixels[i + 1]! < 100 && pixels[i + 2]! < 100 && pixels[i + 3]! > 150) count++;
  return count;
}

for (const font of ["Helvetica", "Helvetica-Bold", "Times-Roman"]) {
  test(`standard-font ${font} redline produces actual glyph pixels in Node`, async () => {
    const pdf = await (await loadPdfJsForNode()).getDocument(buildPdfJsDocumentOptions(new Uint8Array(standardFontPdf(font)))).promise;
    try {
      const page = await pdf.getPage(1); const viewport = page.getViewport({ scale: 1 });
      const canvas = createCanvas(viewport.width, viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      assert.ok(redInk(canvas) > 300, "redline text must be rendered, not merely extracted as PDF text");
    } finally { await pdf.destroy(); }
  });
}

test("uploaded nonembedded-font PDF carries visible wording into the model pixel input", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redline-font-"));
  const before = process.env.OPERATOR_WORKSPACE_ROOT; process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    fs.writeFileSync(path.join(root, "redline.pdf"), standardFontPdf("Helvetica-Bold"));
    const result = await buildCodexVisualInput({ user_attachments: [{ id: "font-redline", relative_path: "redline.pdf" }] });
    const input = result.input.find(item => item.type === "image"); assert.ok(input && input.type === "image");
    const img = await loadImage(Buffer.from(input.url.split(",")[1]!, "base64"));
    const canvas = createCanvas(img.width, img.height); canvas.getContext("2d").drawImage(img, 0, 0);
    assert.ok(redInk(canvas) > 1000);
    assert.equal(result.receipts[0]?.status, "included");
  } finally {
    if (before === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

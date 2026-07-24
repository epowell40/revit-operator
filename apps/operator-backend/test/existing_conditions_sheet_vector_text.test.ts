import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { extractSheetVectorTextV1 } from "../src/existing_conditions/sheet_vector_text.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../src/pdf/pdfjs_node.js";

function hash(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writePdf(filePath: string, text: string): void {
  const stream = `0 G\n1 w\n10 10 m\n90 10 l\n90 90 l\n10 90 l\nh\nS\nBT\n/F1 10 Tf\n20 45 Td\n(${text}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(filePath, Buffer.from(pdf, "binary"));
}

async function renderPdf(pdfPath: string, renderPath: string): Promise<void> {
  const pdfjs: any = await loadPdfJsForNode();
  const document = await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(fs.readFileSync(pdfPath)))).promise;
  try {
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(100, 100);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 100, 100);
    await page.render({ canvasContext: context as any, viewport }).promise;
    fs.writeFileSync(renderPath, canvas.toBuffer("image/png"));
  } finally {
    await document.destroy();
  }
}

test("hash-bound vector PDF text maps exact labels into the verified render", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-vector-text-"));
  const pdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  writePdf(pdfPath, "L43");
  await renderPdf(pdfPath, renderPath);

  const result = await extractSheetVectorTextV1({
    schema_version: 1,
    source_pdf_path: pdfPath,
    source_pdf_sha256: hash(pdfPath),
    registered_render_path: renderPath,
    registered_render_sha256: hash(renderPath),
    render_width_px: 100,
    render_height_px: 100,
    include_exact_text: ["L43"]
  });

  assert.equal(result.source_render_verification.passed, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.text, "L43");
  assert.equal(result.entries[0]?.normalized_text, "l43");
  assert.ok((result.entries[0]?.pixel_point.x ?? 0) > 20);
  assert.ok((result.entries[0]?.pixel_point.y ?? 0) > 40);
  assert.equal(result.native_write_allowed, false);
});

test("vector text extraction rejects a hash-valid render that does not match the PDF", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-vector-text-mismatch-"));
  const pdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "wrong.png");
  writePdf(pdfPath, "L43");
  const canvas = createCanvas(100, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, 100, 100);
  fs.writeFileSync(renderPath, canvas.toBuffer("image/png"));

  await assert.rejects(
    extractSheetVectorTextV1({
      schema_version: 1,
      source_pdf_path: pdfPath,
      source_pdf_sha256: hash(pdfPath),
      registered_render_path: renderPath,
      registered_render_sha256: hash(renderPath),
      render_width_px: 100,
      render_height_px: 100,
      include_exact_text: ["L43"]
    }),
    /sheet_vector_text_source_render_mismatch/
  );
});

test("vector text extraction rejects a shifted copy of the correct source render", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-vector-text-shifted-"));
  const pdfPath = path.join(directory, "source.pdf");
  const exactPath = path.join(directory, "exact.png");
  const shiftedPath = path.join(directory, "shifted.png");
  writePdf(pdfPath, "L43");
  await renderPdf(pdfPath, exactPath);
  const image = await loadImage(fs.readFileSync(exactPath));
  const canvas = createCanvas(100, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 100, 100);
  context.drawImage(image, 5, 0);
  fs.writeFileSync(shiftedPath, canvas.toBuffer("image/png"));

  await assert.rejects(
    extractSheetVectorTextV1({
      schema_version: 1,
      source_pdf_path: pdfPath,
      source_pdf_sha256: hash(pdfPath),
      registered_render_path: shiftedPath,
      registered_render_sha256: hash(shiftedPath),
      render_width_px: 100,
      render_height_px: 100,
      include_exact_text: ["L43"]
    }),
    /sheet_vector_text_source_render_mismatch/
  );
});

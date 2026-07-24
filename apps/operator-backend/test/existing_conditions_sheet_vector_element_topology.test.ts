import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { extractSheetVectorElementTopologyV1 } from "../src/existing_conditions/sheet_vector_element_topology.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../src/pdf/pdfjs_node.js";

function hash(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writePdf(filePath: string, marked: boolean): void {
  const firstStart = marked ? "/ViewRegion1 BMC\n/Element101 BMC\n" : "";
  const firstEnd = marked ? "EMC\nEMC\n" : "";
  const secondStart = marked ? "/ViewRegion1 BMC\n/Element102 BMC\n" : "";
  const secondEnd = marked ? "EMC\nEMC\n" : "";
  const stream = `0 G\n1 w\n${firstStart}10 50 m\n40 50 l\nS\nBT\n/F1 10 Tf\n15 60 Td\n(A) Tj\nET\n${firstEnd}${secondStart}40 50 m\n70 50 l\nS\n${secondEnd}`;
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

async function fixture(marked: boolean): Promise<{ pdfPath: string; renderPath: string }> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-vector-topology-"));
  const pdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  writePdf(pdfPath, marked);
  await renderPdf(pdfPath, renderPath);
  return { pdfPath, renderPath };
}

test("marked-content paths produce hashed source groups and a cross-group endpoint junction", async () => {
  const { pdfPath, renderPath } = await fixture(true);
  const result = await extractSheetVectorElementTopologyV1({
    schema_version: 1,
    source_pdf_path: pdfPath,
    source_pdf_sha256: hash(pdfPath),
    registered_render_path: renderPath,
    registered_render_sha256: hash(renderPath),
    render_width_px: 100,
    render_height_px: 100,
    junction_tolerance_px: 0.1
  });

  assert.equal(result.marked_content_supported, true);
  assert.equal(result.groups.length, 2);
  assert.equal(result.endpoint_junctions.length, 1);
  assert.equal(result.endpoint_junctions[0]?.distance_px, 0);
  assert.equal(result.native_write_allowed, false);
  assert.doesNotMatch(JSON.stringify(result), /Element101|Element102|ViewRegion1/);
  assert.ok(result.groups.every(group => group.source_group_id.startsWith("group_")));
});

test("a PDF without element marked content fails closed with no fabricated groups", async () => {
  const { pdfPath, renderPath } = await fixture(false);
  const result = await extractSheetVectorElementTopologyV1({
    schema_version: 1,
    source_pdf_path: pdfPath,
    source_pdf_sha256: hash(pdfPath),
    registered_render_path: renderPath,
    registered_render_sha256: hash(renderPath),
    render_width_px: 100,
    render_height_px: 100
  });

  assert.equal(result.marked_content_supported, false);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.endpoint_junctions, []);
  assert.equal(result.native_write_allowed, false);
});

test("a bounded pixel region emits only intersecting marked groups", async () => {
  const { pdfPath, renderPath } = await fixture(true);
  const result = await extractSheetVectorElementTopologyV1({
    schema_version: 1,
    source_pdf_path: pdfPath,
    source_pdf_sha256: hash(pdfPath),
    registered_render_path: renderPath,
    registered_render_sha256: hash(renderPath),
    render_width_px: 100,
    render_height_px: 100,
    include_pixel_bounds: { min: { x: 5, y: 45 }, max: { x: 39.9, y: 55 } }
  });

  assert.equal(result.operator_summary.marked_content_group_count, 2);
  assert.equal(result.operator_summary.emitted_group_count, 1);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.endpoint_junctions, []);
});

test("topology extraction inherits strict PDF hash verification", async () => {
  const { pdfPath, renderPath } = await fixture(true);
  await assert.rejects(
    extractSheetVectorElementTopologyV1({
      schema_version: 1,
      source_pdf_path: pdfPath,
      source_pdf_sha256: "0".repeat(64),
      registered_render_path: renderPath,
      registered_render_sha256: hash(renderPath),
      render_width_px: 100,
      render_height_px: 100
    }),
    /sheet_vector_text_source_pdf_hash_mismatch/
  );
});

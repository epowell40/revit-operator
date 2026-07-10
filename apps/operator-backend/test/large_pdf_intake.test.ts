import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRedlineFile } from "../src/redline/redline_analyzer.js";
import { analyzeRedlineWithGemini } from "../src/vision/gemini_agentic_vision.js";

function pdfString(value: string): string {
  return value.replace(/([\\()])/g, "\\$1");
}

function buildCommentedPdf(pageCount: number, comments: Map<number, string>): Buffer {
  const objects = new Map<number, string>();
  const pageObjectIds: number[] = [];
  let nextId = 4;

  for (let page = 1; page <= pageCount; page += 1) {
    const pageId = nextId++;
    const contentId = nextId++;
    const comment = comments.get(page);
    const annotationId = comment ? nextId++ : null;
    pageObjectIds.push(pageId);

    const annots = annotationId ? ` /Annots [${annotationId} 0 R]` : "";
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R${annots} >>`
    );
    const text = `SHEET A-${String(page).padStart(3, "0")} PAGE ${page}`;
    const stream = `BT /F1 12 Tf 72 720 Td (${pdfString(text)}) Tj ET`;
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    if (annotationId && comment) {
      objects.set(
        annotationId,
        `<< /Type /Annot /Subtype /FreeText /Rect [100 100 360 145] /Contents (${pdfString(comment)}) /C [1 0 0] /DA (/F1 12 Tf 1 0 0 rg) >>`
      );
    }
  }

  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const size = nextId;
  let body = "%PDF-1.7\n% large package fixture\n";
  const offsets = new Array<number>(size).fill(0);
  for (let id = 1; id < size; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects.get(id) ?? "<<>>"}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

test("redline analyzer inventories comments across a 125-page PDF package", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-large-pdf-"));
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const uploads = path.join(root, "artifacts", "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    const filePath = path.join(uploads, "125-page-comments.pdf");
    fs.writeFileSync(
      filePath,
      buildCommentedPdf(
        125,
        new Map([
          [1, "COMMENT EARLY: RELOCATE SUPPLY DIFFUSER"],
          [63, "COMMENT MIDDLE: ADD 12x10 SUPPLY DUCT"],
          [125, "COMMENT LATE: DELETE EXISTING GRILLE"]
        ])
      )
    );

    const result = await analyzeRedlineFile({
      file_path: "artifacts/uploads/125-page-comments.pdf",
      max_pages: 150,
      include_pdf_annotations: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.page_count, 125);
    assert.equal(result.pages?.length, 125);
    assert.equal(result.page_coverage?.complete, true);
    assert.deepEqual(result.page_coverage?.processed_ranges, ["1-125"]);
    assert.deepEqual(
      result.pdf_annotations?.map((annotation) => annotation.page),
      [1, 63, 125]
    );
    assert.match(result.pdf_annotations?.find((annotation) => annotation.page === 125)?.contents ?? "", /DELETE EXISTING GRILLE/);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("redline analyzer resumes a later page range with exact coverage reporting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-large-pdf-resume-"));
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const uploads = path.join(root, "artifacts", "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, "resume.pdf"), buildCommentedPdf(125, new Map([[125, "FINAL PAGE COMMENT"]])));

    const result = await analyzeRedlineFile({
      file_path: "artifacts/uploads/resume.pdf",
      page_start: 121,
      max_pages: 5,
      include_pdf_annotations: true
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.pages?.map((page) => page.page), [121, 122, 123, 124, 125]);
    assert.deepEqual(result.page_coverage?.processed_ranges, ["121-125"]);
    assert.deepEqual(result.page_coverage?.omitted_ranges, ["1-120"]);
    assert.deepEqual(result.pdf_package?.visual_batches, [
      { batch_index: 1, page_start: 121, page_end: 125, page_count: 5 }
    ]);
    assert.equal(result.pdf_annotations?.[0]?.page, 125);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("large PDF vision preprocessing rasterizes the requested late-page batch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-large-pdf-vision-"));
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const previousEnabled = process.env.OPERATOR_GEMINI_VISION_ENABLED;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_GEMINI_VISION_ENABLED = "0";
  try {
    const uploads = path.join(root, "artifacts", "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, "vision-range.pdf"), buildCommentedPdf(125, new Map([[125, "FINAL PAGE COMMENT"]])));

    const result = await analyzeRedlineWithGemini({
      file_path: "artifacts/uploads/vision-range.pdf",
      page_start: 121,
      max_pages: 5,
      timeout_ms: 120_000
    });

    assert.equal(result.ok, false);
    assert.equal(result.request.page_start, 121);
    assert.equal(result.request.page_end, 125);
    assert.equal(result.preprocess?.converted_pdf_pages?.length, 5);
    assert.match(result.preprocess?.converted_pdf_pages?.[0] ?? "", /page_0121/i);
    assert.match(result.preprocess?.converted_pdf_pages?.at(-1) ?? "", /page_0125/i);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    if (previousEnabled === undefined) delete process.env.OPERATOR_GEMINI_VISION_ENABLED;
    else process.env.OPERATOR_GEMINI_VISION_ENABLED = previousEnabled;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

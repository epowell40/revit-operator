import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRedlineFile } from "../src/redline/redline_analyzer.js";
import { analyzeRedlineWithGemini } from "../src/vision/gemini_agentic_vision.js";
import { buildCommentedPdf } from "./fixtures/commented_pdf.js";

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

test("redline analyzer inventories a 125-page flattened-comment package without native annotations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-flat-pdf-"));
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const uploads = path.join(root, "artifacts", "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(
      path.join(uploads, "125-page-flattened.pdf"),
      buildCommentedPdf(
        125,
        new Map([
          [1, "FLATTENED EARLY: MOVE DIFFUSER"],
          [63, "FLATTENED MIDDLE: ADD DUCT"],
          [125, "FLATTENED LATE: DELETE GRILLE"]
        ]),
        false
      )
    );

    const result = await analyzeRedlineFile({
      file_path: "artifacts/uploads/125-page-flattened.pdf",
      max_pages: 150,
      include_pdf_annotations: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.page_coverage?.complete, true);
    assert.equal(result.pdf_annotations?.length ?? 0, 0);
    assert.match(result.pages?.find((page) => page.page === 1)?.text_excerpt ?? "", /FLATTENED EARLY/);
    assert.match(result.pages?.find((page) => page.page === 63)?.text_excerpt ?? "", /FLATTENED MIDDLE/);
    assert.match(result.pages?.find((page) => page.page === 125)?.text_excerpt ?? "", /FLATTENED LATE/);
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

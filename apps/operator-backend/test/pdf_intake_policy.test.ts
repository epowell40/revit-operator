import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPdfPageBatches,
  buildPdfPageCoverage,
  pdfDefaultPageBudget,
  resolvePdfPageBudget
} from "../src/redline/pdf_intake_policy.js";
import { selectPdfExcerptPages } from "../src/attachments/extract.js";
import { formatWorkbenchResultsForPrompt } from "../src/brains/workbench_prompt_formatter.js";

test("large PDF intake defaults cover at least 100 pages", () => {
  assert.ok(pdfDefaultPageBudget() >= 100);
  assert.equal(resolvePdfPageBudget(undefined), pdfDefaultPageBudget());
});

test("large PDF intake plans bounded eight-page visual batches", () => {
  const batches = buildPdfPageBatches(125, 150, 8);
  assert.equal(batches.length, 16);
  assert.deepEqual(batches[0], { batch_index: 1, page_start: 1, page_end: 8, page_count: 8 });
  assert.deepEqual(batches.at(-1), { batch_index: 16, page_start: 121, page_end: 125, page_count: 5 });
});

test("large PDF coverage reports exact omitted ranges", () => {
  assert.deepEqual(buildPdfPageCoverage(220, 1, 150), {
    page_count: 220,
    requested_page_start: 1,
    requested_max_pages: 150,
    processed_page_count: 150,
    processed_ranges: ["1-150"],
    omitted_ranges: ["151-220"],
    complete: false
  });
  assert.deepEqual(buildPdfPageCoverage(220, 151, 70).processed_ranges, ["151-220"]);
});

test("PDF prompt excerpts sample the beginning, middle, and end of large packages", () => {
  assert.deepEqual(selectPdfExcerptPages(125), [1, 2, 63, 124, 125]);
  assert.deepEqual(selectPdfExcerptPages(3), [1, 2, 3]);
});

test("large PDF workbench prompt keeps comment provenance ahead of bulky page details", () => {
  const formatted = formatWorkbenchResultsForPrompt([
    {
      index: 1,
      type: "analyze_redline",
      ok: true,
      summary: "Redline analyzed (pdf).",
      details: {
        kind: "pdf",
        file_path: "artifacts/uploads/package.pdf",
        page_count: 125,
        page_coverage: { complete: true, processed_ranges: ["1-125"], omitted_ranges: [] },
        pdf_package: {
          native_comment_pages: [1, 63, 125],
          visual_batch_size: 8,
          visual_batches: buildPdfPageBatches(125, 150, 8)
        },
        pages: Array.from({ length: 125 }, (_, index) => ({ page: index + 1, text_excerpt: "x".repeat(200) })),
        pdf_annotations: [
          { page: 1, annotation_index: 1, subtype: "FreeText", contents: "EARLY COMMENT" },
          { page: 63, annotation_index: 1, subtype: "FreeText", contents: "MIDDLE COMMENT" },
          { page: 125, annotation_index: 1, subtype: "FreeText", contents: "LATE COMMENT" }
        ]
      }
    }
  ]);

  assert.match(formatted, /EARLY COMMENT/);
  assert.match(formatted, /MIDDLE COMMENT/);
  assert.match(formatted, /LATE COMMENT/);
  assert.match(formatted, /\"count\":16/);
  assert.doesNotMatch(formatted, /text_excerpt/);
});

test("large PDF visual prompt keeps package coverage and samples findings across the package", () => {
  const formatted = formatWorkbenchResultsForPrompt([{
    index: 1,
    type: "gemini_redline_analyze",
    ok: true,
    summary: "Package complete.",
    details: {
      summary: "Package complete.",
      package_coverage: { complete: true, processed_ranges: ["1-125"], failed_ranges: [], omitted_ranges: [] },
      deduplication: { raw_region_count: 80, unique_region_count: 75, duplicates_removed: 5 },
      batch_results: Array.from({ length: 16 }, (_, index) => ({ batch_index: index + 1, ok: true })),
      regions: Array.from({ length: 75 }, (_, index) => ({
        finding_id: `pdf_finding_${String(index + 1).padStart(4, "0")}`,
        page_number: index + 1,
        intent: index === 0 ? "EARLY VISUAL COMMENT" : index === 74 ? "LATE VISUAL COMMENT" : `COMMENT ${index + 1}`
      }))
    }
  }]);

  assert.match(formatted, /"complete":true/);
  assert.match(formatted, /EARLY VISUAL COMMENT/);
  assert.match(formatted, /LATE VISUAL COMMENT/);
  assert.match(formatted, /"findings_omitted_from_prompt":39/);
  assert.doesNotMatch(formatted, /batch_index":16/);
});

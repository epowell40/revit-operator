import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateGeminiRedlineBatches,
  analyzeRedlinePackageWithGemini,
  type GeminiBatchExecution
} from "../src/vision/gemini_redline_package.js";
import type {
  GeminiRedlineAnalyzeRequest,
  GeminiRedlineAnalyzeResponse,
  GeminiRegionIntent
} from "../src/vision/gemini_agentic_vision.js";

function responseFor(req: GeminiRedlineAnalyzeRequest, regions: GeminiRegionIntent[], ok = true): GeminiRedlineAnalyzeResponse {
  const pageStart = Math.max(1, Math.floor(req.page_start ?? 1));
  const pageCount = Math.max(1, Math.floor(req.max_pages ?? 1));
  return {
    ok,
    model: "gemini-test",
    provider: "gemini",
    used_code_execution: false,
    request: {
      file_path: req.file_path,
      image_paths: [],
      image_count: pageCount,
      max_regions: 80,
      min_confidence: 0.3,
      page_start: pageStart,
      page_end: pageStart + pageCount - 1
    },
    summary: ok ? `Analyzed ${pageStart}-${pageStart + pageCount - 1}.` : "Synthetic batch failure.",
    regions: ok ? regions : [],
    open_questions: [],
    global_confidence: ok ? 0.82 : 0,
    ...(ok ? {} : { warning: "Synthetic batch failure." })
  };
}

function finding(page: number, intent: string, confidence = 0.8): GeminiRegionIntent {
  return {
    page_number: page,
    region_index: 1,
    target_type: "model_element",
    intent,
    rationale: "Visible flattened red markup.",
    proposed_action: intent,
    size_or_value: null,
    confidence
  };
}

test("Gemini package runner processes all 125 pages and deduplicates same-page findings", async () => {
  const calls: GeminiRedlineAnalyzeRequest[] = [];
  const result = await analyzeRedlinePackageWithGemini(
    { file_path: "artifacts/uploads/flattened-125.pdf", max_pages: 150, page_start: 1 },
    {
      pageCount: 125,
      analyzeBatch: async (req) => {
        calls.push(req);
        const start = req.page_start ?? 1;
        const end = start + (req.max_pages ?? 1) - 1;
        const regions: GeminiRegionIntent[] = [];
        if (start <= 1 && end >= 1) regions.push(finding(1, "Relocate supply diffuser"));
        if (start <= 63 && end >= 63) {
          regions.push(finding(63, "Add 12 x 10 supply duct", 0.76));
          regions.push(finding(63, "Add 12x10 supply duct", 0.91));
        }
        if (start <= 125 && end >= 125) regions.push(finding(125, "Delete existing grille"));
        return responseFor(req, regions);
      }
    }
  );

  assert.equal("package_coverage" in result, true);
  if (!("package_coverage" in result)) return;
  assert.equal(calls.length, 16);
  assert.deepEqual(calls[0] && { start: calls[0].page_start, count: calls[0].max_pages }, { start: 1, count: 8 });
  assert.deepEqual(calls.at(-1) && { start: calls.at(-1)?.page_start, count: calls.at(-1)?.max_pages }, { start: 121, count: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.package_coverage.complete, true);
  assert.deepEqual(result.package_coverage.processed_ranges, ["1-125"]);
  assert.deepEqual(result.regions.map((region) => region.page_number), [1, 63, 125]);
  assert.equal(result.regions.find((region) => region.page_number === 63)?.duplicate_count, 2);
  assert.equal(result.regions.find((region) => region.page_number === 63)?.confidence, 0.91);
  assert.deepEqual(result.regions.map((region) => region.finding_id), ["pdf_finding_0001", "pdf_finding_0002", "pdf_finding_0003"]);
  assert.deepEqual(result.deduplication, { raw_region_count: 4, unique_region_count: 3, duplicates_removed: 1 });
});

test("Gemini package runner reports exact failed ranges without discarding successful findings", async () => {
  const result = await analyzeRedlinePackageWithGemini(
    { file_path: "artifacts/uploads/partial-40.pdf", max_pages: 40 },
    {
      pageCount: 40,
      analyzeBatch: async (req) => {
        const start = req.page_start ?? 1;
        if (start === 17) return responseFor(req, [], false);
        return responseFor(req, start === 1 ? [finding(1, "Move thermostat")] : []);
      }
    }
  );

  assert.equal("package_coverage" in result, true);
  if (!("package_coverage" in result)) return;
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.package_coverage.complete, false);
  assert.deepEqual(result.package_coverage.failed_ranges, ["17-24"]);
  assert.deepEqual(result.package_coverage.processed_ranges, ["1-16", "25-40"]);
  assert.deepEqual(result.package_coverage.omitted_ranges, []);
  assert.equal(result.regions.length, 1);
  assert.match(result.warning ?? "", /Synthetic batch failure/);
});

test("batch aggregation does not collapse identical instructions from different pages", () => {
  const executions: GeminiBatchExecution[] = [
    { batch_index: 1, page_start: 1, page_end: 1, response: responseFor({ file_path: "x.pdf", page_start: 1, max_pages: 1 }, [finding(1, "Delete grille")]) },
    { batch_index: 2, page_start: 2, page_end: 2, response: responseFor({ file_path: "x.pdf", page_start: 2, max_pages: 1 }, [finding(2, "Delete grille")]) }
  ];
  const aggregated = aggregateGeminiRedlineBatches(executions);
  assert.equal(aggregated.regions.length, 2);
  assert.deepEqual(aggregated.regions.map((region) => region.page_number), [1, 2]);
});

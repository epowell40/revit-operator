import fs from "node:fs";
import path from "node:path";
import { buildPdfPageBatches, buildPdfPageCoverage, resolvePdfPageBudget } from "../redline/pdf_intake_policy.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";
import { resolveExistingFileUnderWorkspace } from "../workspace.js";
import {
  analyzeRedlineWithGemini,
  type GeminiRedlineAnalyzeRequest,
  type GeminiRedlineAnalyzeResponse,
  type GeminiRegionIntent
} from "./gemini_agentic_vision.js";

export type GeminiFindingProvenance = {
  batch_index: number;
  page_start: number;
  page_end: number;
  source_region_index: number | null;
  confidence: number;
};

export type AggregatedGeminiRegionIntent = GeminiRegionIntent & {
  finding_id: string;
  duplicate_count: number;
  provenance: GeminiFindingProvenance[];
};

export type GeminiPackageBatchResult = {
  batch_index: number;
  page_start: number;
  page_end: number;
  page_count: number;
  ok: boolean;
  region_count: number;
  summary: string;
  warning?: string;
  model: string;
  global_confidence: number;
};

export type GeminiPackageCoverage = {
  page_count: number;
  requested_page_start: number;
  requested_max_pages: number;
  planned_batch_count: number;
  completed_batch_count: number;
  failed_batch_count: number;
  processed_ranges: string[];
  failed_ranges: string[];
  omitted_ranges: string[];
  complete: boolean;
};

export type GeminiRedlinePackageResponse = Omit<GeminiRedlineAnalyzeResponse, "regions"> & {
  regions: AggregatedGeminiRegionIntent[];
  partial: boolean;
  package_coverage: GeminiPackageCoverage;
  batch_results: GeminiPackageBatchResult[];
  deduplication: {
    raw_region_count: number;
    unique_region_count: number;
    duplicates_removed: number;
  };
};

export type GeminiBatchExecution = {
  batch_index: number;
  page_start: number;
  page_end: number;
  response: GeminiRedlineAnalyzeResponse;
};

type AnalyzeBatch = (req: GeminiRedlineAnalyzeRequest) => Promise<GeminiRedlineAnalyzeResponse>;

function finiteInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function normalizedText(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .toLowerCase()
    .replace(/[×x]/g, "x")
    .replace(/(\d+)\s*x\s*(\d+)/g, "$1x$2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function semanticText(region: GeminiRegionIntent): string {
  return normalizedText([region.target_type, region.intent, region.proposed_action, region.size_or_value ?? ""].join(" "));
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter(Boolean));
}

function jaccard(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function rangesFromPages(pages: number[]): string[] {
  const sorted = Array.from(new Set(pages.filter((page) => Number.isFinite(page) && page > 0))).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const ranges: string[] = [];
  let start = sorted[0]!;
  let end = start;
  for (const page of sorted.slice(1)) {
    if (page === end + 1) {
      end = page;
      continue;
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    start = page;
    end = page;
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges;
}

function pagesForRange(start: number, end: number): number[] {
  const pages: number[] = [];
  for (let page = start; page <= end; page += 1) pages.push(page);
  return pages;
}

function normalizeRegionPage(region: GeminiRegionIntent, batch: GeminiBatchExecution): number | null {
  const stated = finiteInt(region.page_number);
  if (stated !== null && stated >= batch.page_start && stated <= batch.page_end) return stated;
  if (batch.page_start === batch.page_end) return batch.page_start;
  return null;
}

function regionsAreDuplicates(left: AggregatedGeminiRegionIntent, right: AggregatedGeminiRegionIntent): boolean {
  if (left.page_number !== right.page_number) return false;
  if (left.page_number === null) {
    const leftBatch = left.provenance[0]?.batch_index;
    const rightBatch = right.provenance[0]?.batch_index;
    if (leftBatch !== rightBatch) return false;
  }
  if (left.target_type !== "unknown" && right.target_type !== "unknown" && left.target_type !== right.target_type) return false;
  const a = semanticText(left);
  const b = semanticText(right);
  if (!a || !b) return false;
  return a === b || jaccard(a, b) >= 0.82;
}

function dedupeStrings(values: string[], maxItems: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = value.trim();
    const key = normalizedText(clean);
    if (!clean || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function aggregateGeminiRedlineBatches(executions: GeminiBatchExecution[]): {
  regions: AggregatedGeminiRegionIntent[];
  open_questions: string[];
  summaries: string[];
  raw_region_count: number;
  duplicates_removed: number;
  global_confidence: number;
} {
  const regions: AggregatedGeminiRegionIntent[] = [];
  const questions: string[] = [];
  const summaries: string[] = [];
  let rawRegionCount = 0;
  let confidenceTotal = 0;
  let confidenceWeight = 0;

  for (const batch of [...executions].sort((a, b) => a.batch_index - b.batch_index)) {
    if (batch.response.summary?.trim()) summaries.push(batch.response.summary.trim());
    questions.push(...(Array.isArray(batch.response.open_questions) ? batch.response.open_questions : []));
    if (!batch.response.ok) continue;
    const batchRegions = Array.isArray(batch.response.regions) ? batch.response.regions : [];
    rawRegionCount += batchRegions.length;
    const weight = Math.max(1, batchRegions.length);
    confidenceTotal += Math.max(0, Math.min(1, batch.response.global_confidence || 0)) * weight;
    confidenceWeight += weight;

    for (const source of batchRegions) {
      const pageNumber = normalizeRegionPage(source, batch);
      const provenance: GeminiFindingProvenance = {
        batch_index: batch.batch_index,
        page_start: batch.page_start,
        page_end: batch.page_end,
        source_region_index: finiteInt(source.region_index),
        confidence: Math.max(0, Math.min(1, Number(source.confidence) || 0))
      };
      const candidate: AggregatedGeminiRegionIntent = {
        ...source,
        page_number: pageNumber,
        finding_id: "",
        duplicate_count: 1,
        provenance: [provenance]
      };
      const existing = regions.find((region) => regionsAreDuplicates(region, candidate));
      if (!existing) {
        regions.push(candidate);
        continue;
      }
      existing.duplicate_count += 1;
      existing.provenance.push(provenance);
      if (candidate.confidence > existing.confidence) {
        existing.confidence = candidate.confidence;
        existing.intent = candidate.intent;
        existing.rationale = candidate.rationale;
        existing.proposed_action = candidate.proposed_action;
        existing.size_or_value = candidate.size_or_value;
        if (existing.target_type === "unknown") existing.target_type = candidate.target_type;
      }
    }
  }

  regions.sort((a, b) => {
    const pageA = a.page_number ?? Number.MAX_SAFE_INTEGER;
    const pageB = b.page_number ?? Number.MAX_SAFE_INTEGER;
    if (pageA !== pageB) return pageA - pageB;
    return semanticText(a).localeCompare(semanticText(b));
  });
  regions.forEach((region, index) => {
    region.finding_id = `pdf_finding_${String(index + 1).padStart(4, "0")}`;
  });

  return {
    regions,
    open_questions: dedupeStrings(questions, 100),
    summaries: dedupeStrings(summaries, 100),
    raw_region_count: rawRegionCount,
    duplicates_removed: Math.max(0, rawRegionCount - regions.length),
    global_confidence: confidenceWeight > 0 ? confidenceTotal / confidenceWeight : 0
  };
}

async function pdfPageCount(relativePath: string): Promise<number> {
  const full = resolveExistingFileUnderWorkspace(relativePath);
  const bytes = fs.readFileSync(full);
  const pdfjs = await loadPdfJsForNode();
  const doc = await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(bytes))).promise;
  return Math.max(0, finiteInt(doc.numPages) ?? 0);
}

function isPdfRequest(req: GeminiRedlineAnalyzeRequest): boolean {
  return path.extname((req.file_path ?? "").trim()).toLowerCase() === ".pdf";
}

export async function analyzeRedlinePackageWithGemini(
  req: GeminiRedlineAnalyzeRequest,
  options: { analyzeBatch?: AnalyzeBatch; pageCount?: number } = {}
): Promise<GeminiRedlineAnalyzeResponse | GeminiRedlinePackageResponse> {
  const requestedPages = Math.max(1, Math.floor(req.max_pages ?? 2));
  if (!isPdfRequest(req) || requestedPages <= 8) return (options.analyzeBatch ?? analyzeRedlineWithGemini)(req);

  const analyzeBatch = options.analyzeBatch ?? analyzeRedlineWithGemini;
  const pageCount = Math.max(0, Math.floor(options.pageCount ?? await pdfPageCount(req.file_path)));
  const pageStart = Math.max(1, Math.floor(req.page_start ?? 1));
  const pageBudget = resolvePdfPageBudget(requestedPages);
  const coverage = buildPdfPageCoverage(pageCount, pageStart, pageBudget);
  const batches = buildPdfPageBatches(coverage.processed_page_count, coverage.processed_page_count, 8).map((batch) => ({
    ...batch,
    page_start: batch.page_start + pageStart - 1,
    page_end: batch.page_end + pageStart - 1
  }));

  const executions: GeminiBatchExecution[] = [];
  for (const batch of batches) {
    const response = await analyzeBatch({
      ...req,
      image_paths: [],
      region_boxes: [],
      page_start: batch.page_start,
      max_pages: batch.page_count
    });
    executions.push({
      batch_index: batch.batch_index,
      page_start: batch.page_start,
      page_end: batch.page_end,
      response
    });
  }

  const aggregate = aggregateGeminiRedlineBatches(executions);
  const successful = executions.filter((entry) => entry.response.ok);
  const failed = executions.filter((entry) => !entry.response.ok);
  const processedPages = successful.flatMap((entry) => pagesForRange(entry.page_start, entry.page_end));
  const failedPages = failed.flatMap((entry) => pagesForRange(entry.page_start, entry.page_end));
  const complete = batches.length > 0 && failed.length === 0 && coverage.complete;
  const firstResponse = executions[0]?.response;
  const model = successful[0]?.response.model ?? firstResponse?.model ?? "gemini";
  const warnings = dedupeStrings(failed.map((entry) => entry.response.warning ?? entry.response.summary), 50);
  const batchResults: GeminiPackageBatchResult[] = executions.map((entry) => ({
    batch_index: entry.batch_index,
    page_start: entry.page_start,
    page_end: entry.page_end,
    page_count: entry.page_end - entry.page_start + 1,
    ok: entry.response.ok,
    region_count: entry.response.regions.length,
    summary: entry.response.summary,
    ...(entry.response.warning ? { warning: entry.response.warning } : {}),
    model: entry.response.model,
    global_confidence: entry.response.global_confidence
  }));

  return {
    ok: complete,
    partial: successful.length > 0 && !complete,
    model,
    provider: "gemini",
    used_code_execution: executions.some((entry) => entry.response.used_code_execution),
    request: {
      file_path: (req.file_path ?? "").trim(),
      image_paths: [],
      image_count: executions.reduce((sum, entry) => sum + entry.response.request.image_count, 0),
      max_regions: Math.max(1, Math.floor(req.max_regions ?? 80)),
      min_confidence: Math.max(0, Math.min(1, Number(req.min_confidence ?? 0.35))),
      page_start: pageStart,
      page_end: Math.max(pageStart, pageStart + coverage.processed_page_count - 1)
    },
    summary: complete
      ? `Gemini package analysis completed ${successful.length}/${batches.length} visual batches with ${aggregate.regions.length} unique finding(s).`
      : `Gemini package analysis completed ${successful.length}/${batches.length} visual batches; ${failed.length} batch(es) failed or pages were omitted.`,
    regions: aggregate.regions,
    open_questions: aggregate.open_questions,
    global_confidence: aggregate.global_confidence,
    package_coverage: {
      page_count: pageCount,
      requested_page_start: pageStart,
      requested_max_pages: pageBudget,
      planned_batch_count: batches.length,
      completed_batch_count: successful.length,
      failed_batch_count: failed.length,
      processed_ranges: rangesFromPages(processedPages),
      failed_ranges: rangesFromPages(failedPages),
      omitted_ranges: coverage.omitted_ranges,
      complete
    },
    batch_results: batchResults,
    deduplication: {
      raw_region_count: aggregate.raw_region_count,
      unique_region_count: aggregate.regions.length,
      duplicates_removed: aggregate.duplicates_removed
    },
    ...(warnings.length > 0 ? { warning: warnings.join(" | ") } : {})
  };
}

export type PdfPageBatch = {
  batch_index: number;
  page_start: number;
  page_end: number;
  page_count: number;
};

export type PdfPageCoverage = {
  page_count: number;
  requested_page_start: number;
  requested_max_pages: number;
  processed_page_count: number;
  processed_ranges: string[];
  omitted_ranges: string[];
  complete: boolean;
};

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt((process.env[name] ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function pdfHardPageLimit(): number {
  return Math.max(100, Math.min(1_000, envInt("OPERATOR_PDF_MAX_PAGES_HARD_LIMIT", 500)));
}

export function pdfDefaultPageBudget(): number {
  return Math.max(100, Math.min(pdfHardPageLimit(), envInt("OPERATOR_PDF_MAX_PAGES_DEFAULT", 150)));
}

export function pdfVisionBatchSize(): number {
  return Math.max(1, Math.min(8, envInt("OPERATOR_PDF_VISION_BATCH_SIZE", 8)));
}

export function resolvePdfPageBudget(requested: unknown): number {
  const n = typeof requested === "number" ? requested : Number(requested);
  const chosen = Number.isFinite(n) && n > 0 ? Math.floor(n) : pdfDefaultPageBudget();
  return Math.max(1, Math.min(pdfHardPageLimit(), chosen));
}

export function resolvePdfPageStart(requested: unknown): number {
  const n = typeof requested === "number" ? requested : Number(requested);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function rangeLabel(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

export function buildPdfPageCoverage(pageCount: number, pageStart: number, maxPages: number): PdfPageCoverage {
  const total = Math.max(0, Math.floor(pageCount));
  const start = Math.max(1, Math.floor(pageStart));
  const budget = Math.max(1, Math.floor(maxPages));
  const end = total > 0 && start <= total ? Math.min(total, start + budget - 1) : start - 1;
  const processed = end >= start ? end - start + 1 : 0;
  const omitted: string[] = [];
  if (total > 0 && start > 1) omitted.push(rangeLabel(1, Math.min(total, start - 1)));
  if (total > 0 && end < total) omitted.push(rangeLabel(Math.max(1, end + 1), total));
  return {
    page_count: total,
    requested_page_start: start,
    requested_max_pages: budget,
    processed_page_count: processed,
    processed_ranges: processed > 0 ? [rangeLabel(start, end)] : [],
    omitted_ranges: omitted,
    complete: total === 0 || (start === 1 && end === total)
  };
}

export function buildPdfPageBatches(pageCount: number, maxPages: number, batchSize: number = pdfVisionBatchSize()): PdfPageBatch[] {
  const total = Math.max(0, Math.floor(pageCount));
  const covered = Math.min(total, Math.max(1, Math.floor(maxPages)));
  const size = Math.max(1, Math.min(8, Math.floor(batchSize)));
  const out: PdfPageBatch[] = [];
  for (let start = 1; start <= covered; start += size) {
    const end = Math.min(covered, start + size - 1);
    out.push({
      batch_index: out.length + 1,
      page_start: start,
      page_end: end,
      page_count: end - start + 1
    });
  }
  return out;
}
